import { Database, type Statement } from "bun:sqlite";
import type { D1Database } from "@cloudflare/workers-types";

/**
 * A faithful-enough `D1Database` backed by `bun:sqlite`, for `d1-eloquent
 * tinker` running against a local wrangler D1 file. Implements the subset of
 * the D1 API the ORM exercises: `prepare().bind().{all,first,run,raw}`,
 * `batch`, and `exec`.
 *
 * The wrangler local D1 is just a SQLite database on disk, so this opens it
 * directly — no Worker, no HTTP, instant. Remote D1 uses the wrangler bridge
 * (`d1Execute`) instead.
 *
 * Every statement is recorded in a capped query log so the REPL can echo the
 * SQL it ran (`.sql`), explain it (`.explain`), and show per-query timing.
 */

type D1Meta = {
  duration: number;
  rows_read: number;
  rows_written: number;
  last_row_id: number;
  changes: number;
  changed_db: boolean;
  size_after: number;
};

export type QueryRecord = {
  sql: string;
  params: unknown[];
  kind: "all" | "first" | "run";
  durationMs: number;
  /** Row count for reads. */
  rows?: number;
  /** Changed-row count for writes. */
  changes?: number;
};

const LOG_CAP = 500;

/** D1 accepts null/number/string/ArrayBuffer/boolean. Coerce to what bun:sqlite binds. */
function normalizeParam(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (v instanceof Date) return v.toISOString(); // safety; the ORM usually pre-serializes
  return v;
}

function meta(started: number, extra: Partial<D1Meta> = {}): D1Meta {
  return {
    duration: performance.now() - started,
    rows_read: 0,
    rows_written: 0,
    last_row_id: 0,
    changes: 0,
    changed_db: false,
    size_after: 0,
    ...extra,
  };
}

class ShimStatement {
  constructor(
    private readonly db: Database,
    private readonly sql: string,
    private readonly sink: (r: QueryRecord) => void,
    private readonly params: unknown[] = [],
  ) {}

  bind(...values: unknown[]): ShimStatement {
    return new ShimStatement(this.db, this.sql, this.sink, values.map(normalizeParam));
  }

  private stmt(): Statement {
    return this.db.query(this.sql);
  }

  async all<T = Record<string, unknown>>() {
    const started = performance.now();
    const results = this.stmt().all(...(this.params as never[])) as T[];
    const durationMs = performance.now() - started;
    this.sink({ sql: this.sql, params: this.params, kind: "all", durationMs, rows: results.length });
    return { results, success: true, meta: meta(started, { rows_read: results.length, duration: durationMs }) };
  }

  async first<T = unknown>(col?: string): Promise<T | null> {
    const started = performance.now();
    const row = this.stmt().get(...(this.params as never[])) as Record<string, unknown> | undefined;
    this.sink({ sql: this.sql, params: this.params, kind: "first", durationMs: performance.now() - started, rows: row ? 1 : 0 });
    if (row == null) return null;
    if (col != null) return (row[col] ?? null) as T;
    return row as T;
  }

  async run<T = Record<string, unknown>>() {
    const started = performance.now();
    const r = this.stmt().run(...(this.params as never[]));
    const durationMs = performance.now() - started;
    this.sink({ sql: this.sql, params: this.params, kind: "run", durationMs, changes: r.changes });
    return {
      results: [] as T[],
      success: true,
      meta: meta(started, {
        changes: r.changes,
        rows_written: r.changes,
        last_row_id: Number(r.lastInsertRowid),
        changed_db: r.changes > 0,
        duration: durationMs,
      }),
    };
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const stmt = this.stmt();
    const rows = stmt.values(...(this.params as never[])) as unknown[][];
    if (options?.columnNames) {
      return [stmt.columnNames as unknown[], ...rows] as T[];
    }
    return rows as T[];
  }
}

export class ShimD1 {
  /** Capped ring of the most recent queries. Newest last. */
  readonly log: QueryRecord[] = [];

  constructor(public readonly raw: Database) {}

  private push = (r: QueryRecord): void => {
    this.log.push(r);
    if (this.log.length > LOG_CAP) this.log.shift();
  };

  prepare(sql: string): ShimStatement {
    return new ShimStatement(this.raw, sql, this.push);
  }

  /** Most recent read (SELECT) query, for `.explain`. */
  lastReadQuery(): QueryRecord | undefined {
    for (let i = this.log.length - 1; i >= 0; i--) {
      if (this.log[i].kind !== "run") return this.log[i];
    }
    return undefined;
  }

  /** D1 `batch` runs the statements in one implicit transaction. Uses a
   * SAVEPOINT so it nests safely inside the REPL's sandbox transaction. */
  async batch<T = unknown>(statements: ShimStatement[]): Promise<T[]> {
    const sp = "d1e_batch";
    const out: unknown[] = [];
    this.raw.exec(`SAVEPOINT ${sp}`);
    try {
      for (const s of statements) out.push(await s.all());
      this.raw.exec(`RELEASE ${sp}`);
    } catch (e) {
      this.raw.exec(`ROLLBACK TO ${sp}`);
      this.raw.exec(`RELEASE ${sp}`);
      throw e;
    }
    return out as T[];
  }

  async exec(sql: string) {
    const started = performance.now();
    this.raw.exec(sql);
    const count = sql.split(";").filter((s) => s.trim().length > 0).length;
    return { count, duration: performance.now() - started };
  }

  async dump(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }
}

export type OpenedD1 = { d1: D1Database; raw: Database; shim: ShimD1; close: () => void };

/** Open a wrangler local D1 SQLite file as a D1Database shim. */
export function openD1(path: string, opts?: { readonly?: boolean }): OpenedD1 {
  // bun:sqlite rejects `{ readonly: false }`; use the bare form for read-write
  // (the file already exists, so no `create` is needed).
  const db = opts?.readonly ? new Database(path, { readonly: true }) : new Database(path);
  if (!opts?.readonly) {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
  }
  db.exec("PRAGMA busy_timeout = 5000;");
  const shim = new ShimD1(db);
  return { d1: shim as unknown as D1Database, raw: db, shim, close: () => db.close() };
}
