export type FKAction = "cascade" | "restrict" | "set null" | "set default" | "no action";

/**
 * Reduce a composite column list (e.g. `"a, b"`) to a safe slug suffix for
 * auto-generated index names. Strips whitespace, replaces commas + non-ident
 * characters with underscores, collapses adjacent underscores.
 *
 * @internal
 */
function slugifyColumns(columns: string): string {
  return columns
    .replaceAll(/\s+/g, "")
    .replaceAll(/[^A-Za-z0-9_]+/g, "_")
    .replaceAll(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * Normalize a column list given as a single name, a comma-separated string, or
 * a string[] (or any mix) into a clean string[] — trimmed, empties dropped. Lets
 * the FK helpers accept `'a'`, `'a, b'`, `'a,b'`, and `['a','b']` interchangeably.
 *
 * @internal
 */
function normalizeColumnList(cols: string | string[]): string[] {
  return (Array.isArray(cols) ? cols : [cols])
    .flatMap((c) => c.split(","))
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/**
 * Format a column list as canonical SQL `"a, b"`. See {@link normalizeColumnList}.
 *
 * @internal
 */
function formatColumnList(cols: string | string[]): string {
  return normalizeColumnList(cols).join(", ");
}

/**
 * Persisted SQLite column types supported by the schema builder.
 * `JSON` is a TEXT column under the hood (SQLite has no JSON storage class);
 * the JSON label is preserved in generated SQL for documentation/tooling and
 * accepted by D1. Use `t.json(...)` and pair with `static casts = { col: 'json' }`.
 */
type ColumnType = "TEXT" | "INTEGER" | "REAL" | "BLOB" | "JSON";

/**
 * Mode for SQLite GENERATED column expressions.
 * - `virtual` (default): expression is evaluated on read; uses no storage.
 * - `stored`: expression is materialised on write; faster reads, requires table rebuild
 *   to change. STORED columns are NOT supported on `ALTER TABLE ADD COLUMN`.
 */
export type TGeneratedMode = "virtual" | "stored";

// ---------------------------------------------------------------------------
// BaseColumnBuilder — shared column modifiers (create + alter)
// ---------------------------------------------------------------------------

export class BaseColumnBuilder {
  protected _name: string;
  protected _type: ColumnType;
  protected _nullable: boolean;
  protected _default: string | number | boolean | undefined;
  protected _defaultRaw: string | undefined;
  protected _unique: boolean;
  protected _uniqueIndexName?: string;
  protected _uniqueIndexWhere?: string;
  protected _index: boolean;
  protected _indexName?: string;
  protected _indexWhere?: string;
  protected _primary: boolean;
  protected _check: string | null;
  protected _collate: string | undefined;
  protected _generatedExpr: string | undefined;
  protected _generatedMode: TGeneratedMode = "virtual";

  constructor(
    name: string,
    type: ColumnType,
    opts: { nullable?: boolean; unique?: boolean; default?: string | number | boolean } = {},
  ) {
    this._name = name;
    this._type = type;
    this._nullable = opts.nullable ?? true;
    this._default = opts.default;
    this._unique = opts.unique ?? false;
    this._index = false;
    this._primary = false;
    this._check = null;
  }

  public nullable(value = true): this {
    this._nullable = value;
    return this;
  }

  public notNull(): this {
    this._nullable = false;
    return this;
  }

  /** Set a literal DEFAULT value. Strings are quoted and single-quote-escaped. */
  public default(value: string | number | boolean): this {
    this._default = value;
    this._defaultRaw = undefined;
    return this;
  }

  /**
   * Set a raw DEFAULT expression (NOT quoted) — use for SQL functions like
   * `CURRENT_TIMESTAMP`, `(datetime('now'))`, or `(json('[]'))`. The expression
   * is emitted verbatim, so only pass values you generate yourself.
   */
  public defaultRaw(expression: string): this {
    this._defaultRaw = expression;
    this._default = undefined;
    return this;
  }

  public unique(indexName?: string): this {
    this._unique = true;
    if (indexName) this._uniqueIndexName = indexName;
    return this;
  }

  public index(indexName?: string): this {
    this._index = true;
    if (indexName) this._indexName = indexName;
    return this;
  }

  /**
   * Constrain the per-column index (set via `.index()` or `.unique()`) to rows
   * matching `condition` — emits `CREATE INDEX ... WHERE <condition>`.
   * Pass a WHERE expression without the keyword, e.g. `'deleted_at IS NULL'`.
   */
  public where(condition: string): this {
    if (this._unique) this._uniqueIndexWhere = condition;
    if (this._index) this._indexWhere = condition;
    if (!this._unique && !this._index) {
      throw new Error(
        `Column '${this._name}': .where() must follow .index() or .unique()`,
      );
    }
    return this;
  }

  public primary(): this {
    this._primary = true;
    this._nullable = false;
    return this;
  }

  public check(expression: string): this {
    this._check = expression;
    return this;
  }

  /** Apply a SQLite collation sequence (e.g. `NOCASE`, `BINARY`, `RTRIM`). */
  public collate(sequence: string): this {
    this._collate = sequence;
    return this;
  }

  /**
   * Declare this column as a generated/computed column.
   *
   * @param expression SQL expression — emitted verbatim, parens added automatically.
   * @param mode `'virtual'` (default, no storage) or `'stored'` (materialised).
   *
   * @example
   * t.text('full_name').generatedAs("first_name || ' ' || last_name")
   * t.json('summary').generatedAs("json_object('id', id, 'name', name)", 'stored')
   */
  public generatedAs(expression: string, mode: TGeneratedMode = "virtual"): this {
    this._generatedExpr = expression;
    this._generatedMode = mode;
    return this;
  }

  protected formatDefault(): string | null {
    if (this._defaultRaw !== undefined) return this._defaultRaw;
    if (this._default === undefined) return null;
    if (typeof this._default === "string") return `'${this._default.replaceAll("'", "''")}'`;
    if (typeof this._default === "boolean") return this._default ? "1" : "0";
    return String(this._default);
  }

  /**
   * Emit the column type token used inside CREATE TABLE / ALTER TABLE.
   * `JSON` is reduced to `TEXT` in the SQL since SQLite has no JSON storage class.
   */
  protected sqlType(): string {
    return this._type === "JSON" ? "TEXT" : this._type;
  }

  /** @internal */
  toColumnDef(): string {
    const parts: string[] = [`${this._name} ${this.sqlType()}`];
    if (this._primary) parts.push("PRIMARY KEY");
    if (!this._nullable) parts.push("NOT NULL");
    if (this._collate) parts.push(`COLLATE ${this._collate}`);
    const def = this.formatDefault();
    if (def !== null) parts.push(`DEFAULT ${def}`);
    if (this._check) parts.push(`CHECK (${this._check})`);
    if (this._generatedExpr) {
      parts.push(`GENERATED ALWAYS AS (${this._generatedExpr}) ${this._generatedMode.toUpperCase()}`);
    }
    return parts.join(" ");
  }

  /** @internal */
  toIndexStatements(tableName: string): string[] {
    const stmts: string[] = [];
    if (this._unique) {
      const idx = this._uniqueIndexName ?? `uidx_${tableName}_${this._name}`;
      const where = this._uniqueIndexWhere ? ` WHERE ${this._uniqueIndexWhere}` : "";
      stmts.push(`CREATE UNIQUE INDEX IF NOT EXISTS ${idx} ON ${tableName}(${this._name})${where};`);
    }
    if (this._index) {
      const idx = this._indexName ?? `idx_${tableName}_${this._name}`;
      const where = this._indexWhere ? ` WHERE ${this._indexWhere}` : "";
      stmts.push(`CREATE INDEX IF NOT EXISTS ${idx} ON ${tableName}(${this._name})${where};`);
    }
    return stmts;
  }
}

// ---------------------------------------------------------------------------
// ColumnBuilder — create mode, adds FK support
// ---------------------------------------------------------------------------

export class ColumnBuilder extends BaseColumnBuilder {
  // Referenced column(s) stored canonically as a formatted `"a, b"` string.
  private _references: { table: string; columns: string } | null = null;
  private _onDelete: FKAction = "restrict";
  private _onUpdate: FKAction = "restrict";

  /**
   * Declare a FOREIGN KEY on this column. The referenced `column` accepts a
   * single name, a comma-separated string, or a string[] (for a composite
   * referenced key) — interchangeably. The local side is always this column.
   */
  public references(table: string, column: string | string[] = "id"): this {
    this._references = { table, columns: formatColumnList(column) };
    return this;
  }

  public constrained(table: string): this {
    return this.references(table, "id");
  }

  public onDelete(action: FKAction): this {
    this._onDelete = action;
    return this;
  }

  public onUpdate(action: FKAction): this {
    this._onUpdate = action;
    return this;
  }

  /** @internal */
  toForeignKeyClause(): string | null {
    if (!this._references) return null;
    const { table, columns } = this._references;
    return `FOREIGN KEY (${this._name}) REFERENCES ${table}(${columns}) ON DELETE ${this._onDelete.toUpperCase()} ON UPDATE ${this._onUpdate.toUpperCase()}`;
  }
}

// ---------------------------------------------------------------------------
// AlterColumnBuilder — alter mode, no FK methods (compile-time prevention)
// ---------------------------------------------------------------------------

export class AlterColumnBuilder extends BaseColumnBuilder {
  /**
   * Generated columns added via `ALTER TABLE ADD COLUMN` may only be
   * `VIRTUAL` in SQLite — `STORED` requires rebuilding the table.
   * Override the inherited method to throw a clear error instead of
   * letting SQLite reject the statement at runtime.
   */
  public generatedAs(expression: string, mode: TGeneratedMode = "virtual"): this {
    if (mode === "stored") {
      throw new Error(
        `STORED generated columns cannot be added via ALTER TABLE in SQLite. ` +
          `Use 'virtual' mode, or recreate the table with createTable() including the STORED column.`,
      );
    }
    return super.generatedAs(expression, mode);
  }
}

// ---------------------------------------------------------------------------
// VirtualTableBuilder — used inside createVirtualTable callbacks (FTS5, R*Tree, …)
// ---------------------------------------------------------------------------

/**
 * Lightweight builder passed to `Schema.createVirtualTable()` callbacks.
 * Virtual tables ignore standard column constraints (NOT NULL / DEFAULT / etc.),
 * so this surface intentionally only exposes column-name registration and
 * module-specific options as raw lines.
 */
export class VirtualTableBuilder {
  /** @internal */ readonly columns: string[] = [];
  /** @internal */ readonly options: string[] = [];

  /** Register a column name. Pass-through for FTS5/R*Tree column lists. */
  public column(name: string): this {
    this.columns.push(name);
    return this;
  }

  /** Add a raw clause (e.g. `tokenize = 'porter'`, `content = 'posts'`). */
  public option(clause: string): this {
    this.options.push(clause);
    return this;
  }
}

/**
 * Options for `createFts5Table()` — convenience over `createVirtualTable()`.
 */
export type TFts5Options = {
  /** Column names indexed for full-text search. */
  columns: string[];
  /**
   * Tokenizer — e.g. `'unicode61'` (default), `'porter'`, `'ascii'`, or
   * `"unicode61 remove_diacritics 2"` for a parameterised form.
   */
  tokenize?: string;
  /**
   * Backing table for contentless / external-content FTS5 indexes.
   * Pass `''` (empty string) for a contentless table.
   */
  content?: string;
  /** Primary-key column on the backing table (defaults to FTS5's `rowid`). */
  contentRowid?: string;
  /** Pre-built prefix indexes — e.g. `[2, 3]` for prefix lengths 2 and 3. */
  prefix?: number[];
  /** Columns excluded from the BM25 ranking input (`UNINDEXED` modifier). */
  unindexed?: string[];
  /**
   * If true, also emit external-content sync triggers (`AFTER INSERT/UPDATE/DELETE`
   * on `content`) — only valid when `content` is set to a non-empty table name.
   */
  contentSyncTriggers?: boolean;
};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Options for `createTable()` modifying the table-level SQL.
 *
 * - `strict` adds SQLite's `STRICT` modifier (SQLite ≥ 3.37 / D1 supports it),
 *    enforcing column types at write time.
 * - `withoutRowid` adds `WITHOUT ROWID` — requires an explicit non-nullable PK.
 * - `ifNotExists` toggles the `IF NOT EXISTS` guard (default `true`).
 */
export type TCreateTableOpts = {
  strict?: boolean;
  withoutRowid?: boolean;
  ifNotExists?: boolean;
};

export class Schema {
  private statements: string[] = [];

  public raw(sql: string): this {
    this.statements.push(sql.trim().replace(/;$/, "") + ";");
    return this;
  }

  public createTable(name: string, cb: (t: TableBuilder) => void, opts?: TCreateTableOpts): this {
    const t = new TableBuilder(name, "create");
    cb(t);

    const ifNotExists = opts?.ifNotExists ?? true;
    const head = ifNotExists ? "CREATE TABLE IF NOT EXISTS" : "CREATE TABLE";

    const tail: string[] = [];
    if (opts?.withoutRowid) tail.push("WITHOUT ROWID");
    if (opts?.strict) tail.push("STRICT");
    const tailSql = tail.length ? ` ${tail.join(", ")}` : "";

    const sql = `${head} ${name} (\n${t.buildCreateBody()}\n)${tailSql};`;
    this.statements.push(sql);

    for (const extra of t.buildExtras()) this.statements.push(extra);
    return this;
  }

  public dropTable(name: string): this {
    this.statements.push(`DROP TABLE IF EXISTS ${name};`);
    return this;
  }

  /**
   * Rename an existing table (SQLite ≥ 3.25).
   */
  public renameTable(from: string, to: string): this {
    this.statements.push(`ALTER TABLE ${from} RENAME TO ${to};`);
    return this;
  }

  /**
   * Alter table operations (SQLite/D1 limitations apply).
   * Supports ADD COLUMN, DROP COLUMN (3.35+), RENAME COLUMN (3.25+) and indexes.
   */
  public table(name: string, cb: (t: TableBuilder) => void): this {
    const t = new TableBuilder(name, "alter");
    cb(t);

    for (const stmt of t.buildAlterStatements()) this.statements.push(stmt);
    for (const extra of t.buildExtras()) this.statements.push(extra);

    return this;
  }

  /**
   * Create a virtual table — base primitive for FTS5, R*Tree, and other
   * SQLite extension modules. Prefer `createFts5Table()` for full-text search.
   *
   * @example
   * schema.createVirtualTable('items_idx', 'fts5', (t) => {
   *   t.column('title');
   *   t.column('body');
   *   t.option("tokenize = 'porter unicode61'");
   * });
   */
  public createVirtualTable(name: string, module: string, cb: (t: VirtualTableBuilder) => void): this {
    const t = new VirtualTableBuilder();
    cb(t);
    const parts = [...t.columns, ...t.options];
    const body = parts.join(", ");
    this.statements.push(`CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING ${module}(${body});`);
    return this;
  }

  /**
   * Convenience helper for SQLite's FTS5 full-text search engine.
   *
   * @example
   * // Standalone full-text index
   * schema.createFts5Table('posts_search', { columns: ['title', 'body'] });
   *
   * @example
   * // External-content table (indexes data already stored in `posts`),
   * // with porter-stemmed unicode61 tokenizer and auto-sync triggers
   * schema.createFts5Table('posts_search', {
   *   columns: ['title', 'body'],
   *   tokenize: 'porter unicode61 remove_diacritics 2',
   *   content: 'posts',
   *   contentRowid: 'rowid',
   *   contentSyncTriggers: true,
   *   prefix: [2, 3],
   *   unindexed: ['source'],
   * });
   */
  public createFts5Table(name: string, opts: TFts5Options): this {
    if (opts.columns.length === 0) {
      throw new Error(`createFts5Table('${name}'): at least one column is required`);
    }
    if (opts.contentSyncTriggers && !opts.content) {
      throw new Error(
        `createFts5Table('${name}'): contentSyncTriggers requires a non-empty 'content' table`,
      );
    }

    const unindexed = new Set(opts.unindexed ?? []);
    const cols = opts.columns.map((c) => (unindexed.has(c) ? `${c} UNINDEXED` : c));
    const parts = [...cols];

    if (opts.tokenize) parts.push(`tokenize = '${opts.tokenize.replaceAll("'", "''")}'`);
    if (opts.content !== undefined) {
      parts.push(`content = '${opts.content.replaceAll("'", "''")}'`);
    }
    if (opts.contentRowid) parts.push(`content_rowid = '${opts.contentRowid.replaceAll("'", "''")}'`);
    if (opts.prefix && opts.prefix.length > 0) {
      const cleaned = opts.prefix
        .filter((n) => Number.isFinite(n))
        .map((n) => Math.max(1, Math.floor(n)));
      if (cleaned.length === 0) {
        throw new Error(
          `createFts5Table('${name}'): prefix must contain at least one finite integer`,
        );
      }
      parts.push(`prefix = '${cleaned.join(" ")}'`);
    }

    this.statements.push(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING fts5(${parts.join(", ")});`,
    );

    if (opts.contentSyncTriggers && opts.content) {
      const content = opts.content;
      const rowid = opts.contentRowid ?? "rowid";
      const insertCols = opts.columns.join(", ");
      const newRefs = opts.columns.map((c) => `new.${c}`).join(", ");
      const oldRefs = opts.columns.map((c) => `old.${c}`).join(", ");

      this.statements.push(
        `CREATE TRIGGER IF NOT EXISTS ${name}_ai AFTER INSERT ON ${content} BEGIN ` +
          `INSERT INTO ${name}(rowid, ${insertCols}) VALUES (new.${rowid}, ${newRefs}); ` +
          `END;`,
      );
      this.statements.push(
        `CREATE TRIGGER IF NOT EXISTS ${name}_ad AFTER DELETE ON ${content} BEGIN ` +
          `INSERT INTO ${name}(${name}, rowid, ${insertCols}) VALUES('delete', old.${rowid}, ${oldRefs}); ` +
          `END;`,
      );
      this.statements.push(
        `CREATE TRIGGER IF NOT EXISTS ${name}_au AFTER UPDATE ON ${content} BEGIN ` +
          `INSERT INTO ${name}(${name}, rowid, ${insertCols}) VALUES('delete', old.${rowid}, ${oldRefs}); ` +
          `INSERT INTO ${name}(rowid, ${insertCols}) VALUES (new.${rowid}, ${newRefs}); ` +
          `END;`,
      );
    }

    return this;
  }

  /**
   * Create a view from a SELECT statement.
   *
   * @example
   * schema.createView('active_users', 'SELECT * FROM users WHERE deleted_at IS NULL');
   */
  public createView(name: string, select: string): this {
    const body = select.trim().replace(/;$/, "");
    this.statements.push(`CREATE VIEW IF NOT EXISTS ${name} AS ${body};`);
    return this;
  }

  public dropView(name: string): this {
    this.statements.push(`DROP VIEW IF EXISTS ${name};`);
    return this;
  }

  /** Drop an index by name. */
  public dropIndex(name: string): this {
    this.statements.push(`DROP INDEX IF EXISTS ${name};`);
    return this;
  }

  /**
   * Standalone CREATE INDEX (outside a createTable block).
   *
   * @example
   * schema.createIndex('idx_posts_status_pub', 'posts', ['status', 'published_at'], {
   *   unique: true,
   *   where: 'deleted_at IS NULL',
   * });
   */
  public createIndex(
    name: string,
    table: string,
    columns: string | string[],
    opts: { unique?: boolean; where?: string; ifNotExists?: boolean } = {},
  ): this {
    const cols = Array.isArray(columns) ? columns.join(", ") : columns;
    const ifNotExists = opts.ifNotExists ?? true;
    const head = `CREATE ${opts.unique ? "UNIQUE " : ""}INDEX${ifNotExists ? " IF NOT EXISTS" : ""}`;
    const where = opts.where ? ` WHERE ${opts.where}` : "";
    this.statements.push(`${head} ${name} ON ${table}(${cols})${where};`);
    return this;
  }

  /**
   * Create a trigger. The body is emitted verbatim between `BEGIN ... END`.
   *
   * @example
   * schema.createTrigger('audit_users', {
   *   timing: 'AFTER',
   *   event: 'UPDATE',
   *   on: 'users',
   *   body: "INSERT INTO audit_log(table_name, row_id) VALUES ('users', new.id);",
   * });
   */
  public createTrigger(
    name: string,
    opts: {
      timing: "BEFORE" | "AFTER" | "INSTEAD OF";
      event: "INSERT" | "UPDATE" | "DELETE";
      on: string;
      when?: string;
      body: string;
      forEachRow?: boolean;
    },
  ): this {
    const when = opts.when ? ` WHEN ${opts.when}` : "";
    const forEachRow = opts.forEachRow === false ? "" : " FOR EACH ROW";
    const body = opts.body.trim().replace(/;\s*$/, ";");
    this.statements.push(
      `CREATE TRIGGER IF NOT EXISTS ${name} ${opts.timing} ${opts.event} ON ${opts.on}${forEachRow}${when} BEGIN ${body} END;`,
    );
    return this;
  }

  public dropTrigger(name: string): this {
    this.statements.push(`DROP TRIGGER IF EXISTS ${name};`);
    return this;
  }

  public toSql(): string {
    return this.statements.join("\n");
  }

  public toStatements(): string[] {
    return [...this.statements];
  }
}

// ---------------------------------------------------------------------------
// TableBuilder
// ---------------------------------------------------------------------------

type TTableMode = "create" | "alter";

/**
 * Options accepted by `t.timestamps()` for created_at/updated_at columns.
 *
 * - `useCurrentTimestamp`: emit `DEFAULT (datetime('now'))` so SQLite fills
 *   the value when the ORM doesn't (e.g. raw inserts via `INSERT INTO ...`).
 *   The ORM's timestamp manager continues to set these in TypeScript paths.
 * - `nullable`: relax the default `NOT NULL` constraint (rarely needed).
 */
export type TTimestampsOpts = {
  useCurrentTimestamp?: boolean;
  nullable?: boolean;
};

class TableBuilder {
  private readonly table: string;
  private readonly mode: TTableMode;

  private columns: ColumnBuilder[] = [];
  private alterColumns: AlterColumnBuilder[] = [];
  private tableConstraints: string[] = [];
  private tableExtras: string[] = [];
  private rawAlterStatements: string[] = [];

  public constructor(table: string, mode: TTableMode) {
    this.table = table;
    this.mode = mode;
  }

  // ---- columns (create) ----

  public text(name: string, opts: { nullable?: boolean; unique?: boolean; default?: string } = {}): ColumnBuilder {
    const col = new ColumnBuilder(name, "TEXT", opts);
    this.columns.push(col);
    return col;
  }

  public integer(name: string, opts: { nullable?: boolean; unique?: boolean; default?: number } = {}): ColumnBuilder {
    const col = new ColumnBuilder(name, "INTEGER", opts);
    this.columns.push(col);
    return col;
  }

  public real(name: string, opts: { nullable?: boolean; unique?: boolean; default?: number } = {}): ColumnBuilder {
    const col = new ColumnBuilder(name, "REAL", opts);
    this.columns.push(col);
    return col;
  }

  public boolean(name: string, opts: { nullable?: boolean; default?: boolean } = {}): ColumnBuilder {
    const col = new ColumnBuilder(name, "INTEGER", { nullable: opts.nullable, default: opts.default });
    this.columns.push(col);
    return col;
  }

  /**
   * BLOB column — stores raw binary data (e.g. images, encrypted bytes).
   * D1 returns these as `ArrayBuffer`.
   */
  public blob(name: string, opts: { nullable?: boolean; unique?: boolean } = {}): ColumnBuilder {
    const col = new ColumnBuilder(name, "BLOB", opts);
    this.columns.push(col);
    return col;
  }

  /**
   * JSON column — stored as TEXT but labelled JSON for tooling/docs. Pair with
   * `static casts = { col: 'json' }` on the model to auto serialize/parse.
   *
   * Pass `validate: true` to add a `CHECK (json_valid(col) OR col IS NULL)`
   * constraint so D1 rejects malformed JSON at write time.
   */
  public json(
    name: string,
    opts: { nullable?: boolean; unique?: boolean; default?: string; validate?: boolean } = {},
  ): ColumnBuilder {
    const col = new ColumnBuilder(name, "JSON", {
      nullable: opts.nullable,
      unique: opts.unique,
      default: opts.default,
    });
    if (opts.validate) {
      const expr = opts.nullable === false
        ? `json_valid(${name})`
        : `${name} IS NULL OR json_valid(${name})`;
      col.check(expr);
    }
    this.columns.push(col);
    return col;
  }

  public timestamps(opts: TTimestampsOpts = {}): this {
    const colOpts = { nullable: opts.nullable ?? false };
    const c1 = this.text("created_at", colOpts);
    const c2 = this.text("updated_at", colOpts);
    if (opts.useCurrentTimestamp) {
      c1.defaultRaw("(datetime('now'))");
      c2.defaultRaw("(datetime('now'))");
    }
    return this;
  }

  public id(name = "id"): this {
    if (this.mode === "create") {
      const col = new ColumnBuilder(name, "TEXT");
      col.primary();
      this.columns.push(col);
      return this;
    }
    this.rawAlterStatements.push(`-- NOTE: cannot add primary key via ALTER TABLE in SQLite safely`);
    return this;
  }

  /** Table-level composite primary key, e.g. `t.primary('user_id, role_id')` */
  public primary(columns: string): this {
    if (this.mode !== "create") {
      this.rawAlterStatements.push(
        `-- NOTE: ALTER TABLE add primary key is not supported safely in SQLite`,
      );
      return this;
    }
    this.tableConstraints.push(`PRIMARY KEY (${columns})`);
    return this;
  }

  /** Table-level unique index (supports composite columns). */
  public unique(columns: string, indexName?: string, opts: { where?: string } = {}): this {
    const idx = indexName ?? `uidx_${this.table}_${slugifyColumns(columns)}`;
    const where = opts.where ? ` WHERE ${opts.where}` : "";
    this.tableExtras.push(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${idx} ON ${this.table}(${columns})${where};`,
    );
    return this;
  }

  /** Table-level index (supports composite columns). */
  public index(columns: string, indexName?: string, opts: { where?: string } = {}): this {
    const idx = indexName ?? `idx_${this.table}_${slugifyColumns(columns)}`;
    const where = opts.where ? ` WHERE ${opts.where}` : "";
    this.tableExtras.push(
      `CREATE INDEX IF NOT EXISTS ${idx} ON ${this.table}(${columns})${where};`,
    );
    return this;
  }

  /** Add a table-level CHECK constraint (create mode only). */
  public check(expression: string, name?: string): this {
    const constraint = name ? `CONSTRAINT ${name} CHECK (${expression})` : `CHECK (${expression})`;
    if (this.mode === "create") {
      this.tableConstraints.push(constraint);
    } else {
      this.rawAlterStatements.push(`-- NOTE: ALTER TABLE ADD CHECK is not supported in SQLite`);
    }
    return this;
  }

  /**
   * Add a table-level FOREIGN KEY constraint (create mode only). Useful for
   * composite FKs or when you prefer FKs separate from column definitions.
   *
   * Both the local `columns` and the referenced `on` accept a single name, a
   * comma-separated string, or a string[] — interchangeably.
   */
  public foreign(
    columns: string | string[],
    opts: { references: string; on?: string | string[]; onDelete?: FKAction; onUpdate?: FKAction },
  ): this {
    if (this.mode !== "create") {
      this.rawAlterStatements.push(`-- NOTE: ALTER TABLE ADD FOREIGN KEY is not supported in SQLite`);
      return this;
    }
    const localCols = formatColumnList(columns);
    const refCols = opts.on === undefined ? "id" : formatColumnList(opts.on);
    const onDelete = ` ON DELETE ${(opts.onDelete ?? "restrict").toUpperCase()}`;
    const onUpdate = ` ON UPDATE ${(opts.onUpdate ?? "restrict").toUpperCase()}`;
    this.tableConstraints.push(
      `FOREIGN KEY (${localCols}) REFERENCES ${opts.references}(${refCols})${onDelete}${onUpdate}`,
    );
    return this;
  }

  // ---- alter helpers ----

  public addText(name: string, opts: { nullable?: boolean; default?: string } = {}): AlterColumnBuilder {
    const col = new AlterColumnBuilder(name, "TEXT", opts);
    this.alterColumns.push(col);
    return col;
  }

  public addInteger(name: string, opts: { nullable?: boolean; default?: number } = {}): AlterColumnBuilder {
    const col = new AlterColumnBuilder(name, "INTEGER", opts);
    this.alterColumns.push(col);
    return col;
  }

  public addReal(name: string, opts: { nullable?: boolean; default?: number } = {}): AlterColumnBuilder {
    const col = new AlterColumnBuilder(name, "REAL", opts);
    this.alterColumns.push(col);
    return col;
  }

  public addBoolean(name: string, opts: { nullable?: boolean; default?: boolean } = {}): AlterColumnBuilder {
    const col = new AlterColumnBuilder(name, "INTEGER", { nullable: opts.nullable, default: opts.default });
    this.alterColumns.push(col);
    return col;
  }

  public addBlob(name: string, opts: { nullable?: boolean } = {}): AlterColumnBuilder {
    const col = new AlterColumnBuilder(name, "BLOB", opts);
    this.alterColumns.push(col);
    return col;
  }

  public addJson(
    name: string,
    opts: { nullable?: boolean; default?: string; validate?: boolean } = {},
  ): AlterColumnBuilder {
    const col = new AlterColumnBuilder(name, "JSON", {
      nullable: opts.nullable,
      default: opts.default,
    });
    if (opts.validate) {
      const expr = opts.nullable === false
        ? `json_valid(${name})`
        : `${name} IS NULL OR json_valid(${name})`;
      col.check(expr);
    }
    this.alterColumns.push(col);
    return col;
  }

  /** Drop a column (SQLite ≥ 3.35.0). */
  public dropColumn(name: string): this {
    if (this.mode === "create") {
      throw new Error(`dropColumn('${name}'): only available in alter mode (schema.table())`);
    }
    this.rawAlterStatements.push(`ALTER TABLE ${this.table} DROP COLUMN ${name};`);
    return this;
  }

  /** Rename a column in place (SQLite ≥ 3.25.0). */
  public renameColumn(from: string, to: string): this {
    if (this.mode === "create") {
      throw new Error(`renameColumn('${from}'): only available in alter mode (schema.table())`);
    }
    this.rawAlterStatements.push(`ALTER TABLE ${this.table} RENAME COLUMN ${from} TO ${to};`);
    return this;
  }

  /** Drop an index attached to this table. */
  public dropIndex(name: string): this {
    this.rawAlterStatements.push(`DROP INDEX IF EXISTS ${name};`);
    return this;
  }

  // ---- soft deletes ----

  public softDeletes(opts: { column?: string; index?: boolean; indexName?: string } = {}): this {
    const column = opts.column ?? "deleted_at";
    const shouldIndex = opts.index ?? true;

    if (this.mode === "alter") {
      this.addText(column);
    } else {
      this.text(column, { nullable: true });
    }

    if (shouldIndex) {
      this.index(column, opts.indexName);
    }

    return this;
  }

  public dropSoftDeletes(column = "deleted_at"): this {
    if (this.mode === "alter") {
      this.dropColumn(column);
    } else {
      this.rawAlterStatements.push(
        `-- NOTE: dropSoftDeletes() in create mode is a no-op; call inside schema.table() to drop`,
      );
    }
    return this;
  }

  // ---- SQL generation ----

  public buildCreateBody(): string {
    const lines: string[] = [];

    // Column definitions
    for (const col of this.columns) {
      lines.push(col.toColumnDef());
    }

    // FK constraints
    for (const col of this.columns) {
      const fk = col.toForeignKeyClause();
      if (fk) lines.push(fk);
    }

    // Table-level constraints (composite PRIMARY KEY, CHECK, etc.)
    lines.push(...this.tableConstraints);

    return lines.map((l) => `  ${l}`).join(",\n");
  }

  public buildAlterStatements(): string[] {
    const stmts: string[] = [...this.rawAlterStatements];
    for (const col of this.alterColumns) {
      stmts.push(`ALTER TABLE ${this.table} ADD COLUMN ${col.toColumnDef()};`);
    }
    return stmts;
  }

  public buildExtras(): string[] {
    const extras: string[] = [];

    // Index statements from column builders
    for (const col of this.columns) {
      extras.push(...col.toIndexStatements(this.table));
    }
    for (const col of this.alterColumns) {
      extras.push(...col.toIndexStatements(this.table));
    }

    // Table-level extras
    extras.push(...this.tableExtras);

    return extras;
  }
}
