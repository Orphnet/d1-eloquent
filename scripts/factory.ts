import {d1Execute} from "./d1Execute";
import type {TSeederOpts} from "./types";

// Internal — safe for known seeder/test data (not user input)
const escapeValue = (v: unknown): string => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
};

export type TCreateOpts = { orIgnore?: boolean; upsert?: boolean; conflictTarget?: string | string[] };

/** Tables already cleared during this process (shared across factory instances). */
const _clearedTables = new Set<string>();

/** Reset cleared-table tracking (called automatically before each seed run). */
export const resetClearedTables = (): void => { _clearedTables.clear(); };

export abstract class Factory<T extends Record<string, unknown>> {
  abstract readonly table: string;
  abstract definition(): T;

  make(overrides: Partial<T> = {}): T {
    return { ...this.definition(), ...overrides } as T;
  }

  makeMany(count: number, overrides: Partial<T> | ((index: number) => Partial<T>) = {}): T[] {
    const resolve = typeof overrides === "function" ? overrides : () => overrides;
    return Array.from({ length: count }, (_, i) => this.make(resolve(i)));
  }

  async create(opts: TSeederOpts, overrides: Partial<T> = {}, createOpts?: TCreateOpts): Promise<T> {
    const attrs = this.make(overrides);
    await this._insertRow(opts, attrs, createOpts);
    return attrs;
  }

  async createMany(opts: TSeederOpts, count: number, overrides: Partial<T> | ((index: number) => Partial<T>) = {}, createOpts?: TCreateOpts): Promise<T[]> {
    const rows = this.makeMany(count, overrides);
    await this._insertBatch(opts, rows, createOpts);
    return rows;
  }

  private async _clearTableOnce(opts: TSeederOpts): Promise<void> {
    if (_clearedTables.has(this.table)) return;
    _clearedTables.add(this.table);

    const sql = `DELETE FROM ${this.table};`;
    if (opts.pretend) {
      console.log(`-- [pretend] ${sql}`);
      return;
    }
    console.log(`🗑️  Clearing table: ${this.table}`);
    await d1Execute({ dbName: opts.dbName, local: opts.local, remote: opts.remote, command: sql });
  }

  private _resolveConflictTarget(createOpts?: TCreateOpts): string[] {
    const target = createOpts?.conflictTarget ?? "id";
    return Array.isArray(target) ? target : [target];
  }

  private _buildInsertSql(opts: TSeederOpts, colNames: string[], valuesClauses: string, createOpts?: TCreateOpts): string {
    const useUpsert = createOpts?.upsert || opts.idempotent;

    if (createOpts?.orIgnore) {
      return `INSERT OR IGNORE INTO ${this.table} (${colNames.join(", ")}) VALUES\n  ${valuesClauses};`;
    }

    if (useUpsert) {
      const conflictCols = this._resolveConflictTarget(createOpts);
      const updateCols = colNames.filter((c) => !conflictCols.includes(c));
      const setClause = updateCols.map((c) => `${c}=excluded.${c}`).join(", ");
      return `INSERT INTO ${this.table} (${colNames.join(", ")}) VALUES\n  ${valuesClauses}\n  ON CONFLICT(${conflictCols.join(", ")}) DO UPDATE SET ${setClause};`;
    }

    return `INSERT INTO ${this.table} (${colNames.join(", ")}) VALUES\n  ${valuesClauses};`;
  }

  private async _insertRow(opts: TSeederOpts, attrs: T, createOpts?: TCreateOpts): Promise<void> {
    if (opts.fresh) await this._clearTableOnce(opts);

    const colNames = Object.keys(attrs);
    const vals = `(${Object.values(attrs).map(escapeValue).join(", ")})`;
    const sql = this._buildInsertSql(opts, colNames, vals, createOpts);

    if (opts.pretend) {
      console.log(`-- [pretend] ${sql}`);
      return;
    }

    await d1Execute({ dbName: opts.dbName, local: opts.local, remote: opts.remote, command: sql });
  }

  /**
   * Batch-insert rows using multi-row VALUES syntax.
   * Chunks at BATCH_SIZE rows per statement to stay within SQLite limits.
   */
  private async _insertBatch(opts: TSeederOpts, rows: T[], createOpts?: TCreateOpts): Promise<void> {
    if (rows.length === 0) return;
    if (opts.fresh) await this._clearTableOnce(opts);

    const colNames = Object.keys(rows[0]);

    // Chunk to stay within SQLite's max variable count (999) and keep statements reasonable
    const chunkSize = Math.max(1, Math.floor(999 / colNames.length));
    const batchSize = Math.min(chunkSize, 50);

    for (let i = 0; i < rows.length; i += batchSize) {
      const chunk = rows.slice(i, i + batchSize);
      const valuesClauses = chunk
        .map((row) => `(${Object.values(row).map(escapeValue).join(", ")})`)
        .join(",\n  ");
      const sql = this._buildInsertSql(opts, colNames, valuesClauses, createOpts);

      if (opts.pretend) {
        console.log(`-- [pretend] ${sql}`);
        continue;
      }

      await d1Execute({ dbName: opts.dbName, local: opts.local, remote: opts.remote, command: sql });
    }
  }
}
