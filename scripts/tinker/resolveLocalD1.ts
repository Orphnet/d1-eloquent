import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

/** wrangler/miniflare local D1 state directory, relative to the project root. */
const D1_STATE = ".wrangler/state/v3/d1/miniflare-D1DatabaseObject";

export type LocalD1Candidate = { path: string; rows: number; tables: number };

export type LocalD1Resolution = {
  /** Chosen SQLite file (the one with the most data). */
  path: string;
  /** All candidates, ranked best-first. */
  candidates: LocalD1Candidate[];
  /** True when more than one candidate existed and we had to pick. */
  ambiguous: boolean;
};

/**
 * Locate the local wrangler D1 SQLite file for the project at `cwd`.
 *
 * miniflare names the file by a hash, so we glob the state dir. With a single
 * file it's unambiguous. With several (multiple bindings, or a project plus a
 * sibling example), we prefer the one with the most actual data — then schema,
 * then most-recently-modified — so a freshly-migrated-but-empty DB never wins
 * over the one you've actually seeded.
 */
export function resolveLocalD1(cwd: string = process.cwd()): LocalD1Resolution | null {
  const dir = join(cwd, D1_STATE);
  if (!existsSync(dir)) return null;

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")
    .map((f) => join(dir, f));

  if (files.length === 0) return null;

  const ranked = files
    .map((path) => {
      const s = scoreDb(path);
      return { path, rows: s.rows, tables: s.tables, hasMigrations: s.hasMigrations, mtime: safeMtimeMs(path) };
    })
    .sort(
      (a, b) =>
        b.rows - a.rows ||
        Number(b.hasMigrations) - Number(a.hasMigrations) ||
        b.tables - a.tables ||
        b.mtime - a.mtime,
    );

  return {
    path: ranked[0].path,
    candidates: ranked.map((r) => ({ path: r.path, rows: r.rows, tables: r.tables })),
    ambiguous: files.length > 1,
  };
}

/** Count user-table rows (data) and tables for a candidate DB. */
function scoreDb(path: string): { rows: number; tables: number; hasMigrations: boolean } {
  try {
    const db = new Database(path, { readonly: true });
    const tables = (
      db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")
        .all() as Array<{ name: string }>
    ).map((t) => t.name);
    const hasMigrations = tables.includes("_migrations");
    let rows = 0;
    for (const name of tables) {
      if (name === "_migrations") continue;
      if (/_(data|idx|content|docsize|config)$/.test(name)) continue; // FTS5 shadow tables
      try {
        rows += Number((db.query(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n);
      } catch {
        /* unreadable table — skip */
      }
    }
    db.close();
    return { rows, tables: tables.length, hasMigrations };
  } catch {
    return { rows: -1, tables: -1, hasMigrations: false };
  }
}

function safeMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
