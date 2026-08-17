import type {TD1ResultMeta, TModelAttrsOf, TModelCtor, TOrderDirection, TSessionConstraint, TWhereOp} from "./types";
import {WHERE_OPS} from "./types";
import type { TRelationDefinition } from "./relationTypes";
import { buildAggregateSubquery, buildExistsSubquery, deriveEagerLoaders } from "./relationResolver";
import { resolveDb as registryResolveDb } from "./registry";
import { Collection } from "./collection";
import { ModelNotFoundException, MultipleRecordsFoundException } from "./exceptions";
import { CastManager, type AttributeCast } from "./castManager";
import type { BaseModel } from "./baseModel";

/** A named bind placeholder for a prepared query — see {@link placeholder} + `QueryBuilder.prepare()`. */
export class Placeholder {
    constructor(public readonly name: string) {}
}

/** Create a named placeholder for a value in a prepared query (Drizzle-style `sql.placeholder`). */
export function placeholder(name: string): Placeholder {
    return new Placeholder(name);
}

/**
 * Result envelope returned by `getWithMeta()` / `firstWithMeta()`. Includes
 * the model data, D1's result metadata (`rows_read`, `rows_written`, …), and
 * the active session bookmark when sessions are in use.
 */
export type TQueryResult<TData> = {
    data: TData;
    meta: TD1ResultMeta;
    bookmark: string | null;
};

/**
 * Minimal shape of a D1DatabaseSession we care about — we treat it
 * structurally so this code compiles even on older `@cloudflare/workers-types`.
 */
type TD1SessionLike = {
    prepare: D1Database["prepare"];
    batch?: D1Database["batch"];
    getBookmark: () => string | null;
};

type TD1DatabaseWithSession = D1Database & {
    withSession?: (constraint?: TSessionConstraint) => TD1SessionLike;
};

type TWhereJoin = "AND" | "OR";

type TWhereClause =
    | { kind: "basic"; join: TWhereJoin; col: string; op: TWhereOp; val: unknown }
    | { kind: "in"; join: TWhereJoin; col: string; vals: unknown[] }
    | { kind: "not_in"; join: TWhereJoin; col: string; vals: unknown[] }
    | { kind: "sub_in"; join: TWhereJoin; col: string; negated: boolean; sql: string; bindings: unknown[] }
    | { kind: "null"; join: TWhereJoin; col: string; negated: boolean }
    | { kind: "between"; join: TWhereJoin; col: string; range: [unknown, unknown]; negated: boolean }
    | { kind: "raw"; join: TWhereJoin; sql: string; bindings: unknown[] }
    | { kind: "group"; join: TWhereJoin; clauses: TWhereClause[] }
    | { kind: "exists"; join: TWhereJoin; not: boolean; sql: string; bindings: unknown[] }
    | { kind: "column"; join: TWhereJoin; col1: string; op: string; col2: string }
    | { kind: "match"; join: TWhereJoin; col: string; pattern: string };

type TCteClause = {
    name: string;
    recursive: boolean;
    sql: string;
    bindings: unknown[];
    columns?: string[];
};

type TIndexHint = { kind: "indexed"; name: string } | { kind: "not_indexed" };

type THavingClause =
    | { kind: "basic"; join: TWhereJoin; col: string; op: TWhereOp; val: unknown }
    | { kind: "raw"; join: TWhereJoin; sql: string; bindings: unknown[] };

export type TSelectQuery = { sql: string; bindings: unknown[] };

/**
 * Cursor payload shape — encoded as base64url(JSON(value)). The cursor is
 * opaque to callers; the format is implementation detail and may change.
 *
 * @internal
 */
type TCursorPayload = { col: unknown; pk: unknown };

function encodeCursor(payload: TCursorPayload): string {
    const json = JSON.stringify(payload);
    // Workers / browsers expose btoa; Node 22 too. Use base64url-style encoding.
    const b64 = typeof btoa === "function"
        ? btoa(json)
        : Buffer.from(json, "utf-8").toString("base64");
    return b64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCursor(cursor: string): TCursorPayload {
    try {
        let b64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
        while (b64.length % 4 !== 0) b64 += "=";
        const json = typeof atob === "function"
            ? atob(b64)
            : Buffer.from(b64, "base64").toString("utf-8");
        const parsed = JSON.parse(json) as TCursorPayload;
        if (typeof parsed !== "object" || parsed === null || !("col" in parsed) || !("pk" in parsed)) {
            throw new Error("malformed cursor payload");
        }
        return parsed;
    } catch {
        throw new Error(`paginateCursor: invalid cursor "${cursor}"`);
    }
}

export type TPaginationResult<TModel> = {
    data: Collection<TModel>;
    total: number;
    page: number;
    perPage: number;
    lastPage: number;
};

/**
 * Options for `qb.paginateCursor()` — keyset pagination opts.
 */
export type TCursorPaginateOpts = {
    /** Page size (default 20). */
    perPage?: number;
    /**
     * Column to order by. Combined with the model's primary key as a
     * tiebreaker so identical column values still page deterministically.
     * Multi-column orderBy isn't supported in cursor pagination — use
     * `paginate()` (offset) when you need multi-column ordering.
     */
    orderBy: string;
    /** Sort direction (default `'desc'`). */
    direction?: "asc" | "desc";
    /** Cursor from a previous page's `nextCursor` — advance one page forward. */
    after?: string;
    /** Cursor from a previous page's `prevCursor` — go one page back. */
    before?: string;
};

/**
 * Result envelope from `qb.paginateCursor()`. Use `nextCursor` / `prevCursor`
 * for the next request; both are `null` at boundaries.
 *
 * Unlike offset pagination, this is consistent under concurrent writes (no
 * skipped or duplicated rows when new data arrives between pages) and
 * doesn't require a COUNT query — `hasMore` is derived by overfetching one row.
 */
export type TCursorPaginationResult<TModel> = {
    data: Collection<TModel>;
    nextCursor: string | null;
    prevCursor: string | null;
    hasMore: boolean;
};

/**
 * A per-relation constraint applied to a constrained eager load — receives the
 * batch query builder for the related model (already scoped by `whereIn(parentKeys)`)
 * and may add `where` / `orderBy` / `select` / `limit` etc.
 *
 * Caveats: a `select()` must still include the grouping/foreign key used to
 * distribute rows back to parents; `limit()` applies per batch-chunk, not
 * per-parent.
 */
export type TEagerConstraint = (q: QueryBuilder<any, any>) => unknown;

type TEagerLoader<TModel> = (db: D1Database, models: TModel[], constraint?: TEagerConstraint) => Promise<void>;

/** Module-scoped cache for auto-derived eager loaders (avoids mutating model constructors). */
const derivedLoaderCache = new WeakMap<object, Record<string, (db: D1Database, models: any[]) => Promise<void>>>();

export class QueryBuilder<
    TModel extends { toObject(): object },
    TRelations extends string = string
> {
    private table: string;
    private readonly modelCtor: TModelCtor<TModel>;
    private _defaultDb: D1Database | undefined;
    private _connectionName: string | undefined;

    private selects: string[] = ["*"];
    private wheres: TWhereClause[] = [];
    private orders: Array<{ col: string; dir: TOrderDirection }> = [];
    private limitCount: number | null = null;
    private offsetCount: number | null = null;
    private joins: Array<{ type: "INNER" | "LEFT"; table: string; on: string }> = [];
    private groups: string[] = [];

    private includeTrashed: boolean = false;
    private onlyTrashedRows: boolean = false;
    private skippedGlobalScopes: Set<string> = new Set();
    private skipAllGlobalScopes: boolean = false;

    private _distinct: boolean = false;
    private havings: THavingClause[] = [];
    private selectSubBindings: unknown[] = [];
    private unions: Array<{ sql: string; bindings: unknown[]; op: "UNION" | "UNION ALL" | "INTERSECT" | "EXCEPT" }> = [];
    private ctes: TCteClause[] = [];
    private indexHint: TIndexHint | null = null;

    // D1 Sessions (read replicas) — opt-in via withSession()
    private _sessionConstraint: TSessionConstraint | undefined;
    private _activeSession: TD1SessionLike | null = null;
    private _lastBookmark: string | null = null;
    private _lastMeta: TD1ResultMeta | null = null;

    private eagerLoaders: Map<string, TEagerLoader<TModel>> = new Map();
    private eagerConstraints: Map<string, TEagerConstraint> = new Map();
    private unknownRelations: string[] = [];

    /**
     * Merged cast map for this builder's model, resolved lazily on first
     * where-value dehydration and cached for the life of the builder. `null`
     * means "not yet resolved"; an empty object means "no casts" (e.g. a
     * table-only / dummy ctor with no `casts` configured).
     */
    private _whereCastMap: Record<string, AttributeCast> | null = null;

    public constructor(modelCtor: TModelCtor<TModel>) {
        this.modelCtor = modelCtor;
        this.table = modelCtor.table;
    }

    public setDefaultDb(db: D1Database): this {
        this._defaultDb = db;
        return this;
    }

    /**
     * Route this query through a named connection previously registered via
     * `configure(env, { connections: { ... } })` or `registerConnection()`.
     *
     * Goes through the registry, so test mode (`NODE_ENV=test`) still routes
     * to `TEST_DB` — useful for keeping multi-DB code testable. To bypass the
     * registry entirely (and the test-mode redirect), use `Model.query(db)` or
     * pass `db` explicitly to a terminal method instead.
     *
     * Resolution priority within a query:
     * 1. Explicit `db` argument to a terminal method
     * 2. `Model.query(db)` / `setDefaultDb(db)` raw bindings
     * 3. `qb.on(name)` named connection (this method)
     * 4. Model's `static connection`
     * 5. The `"default"` connection from `configure(env)`
     *
     * @example
     * await Event.query().on('analytics').whereEq('user_id', uid).get()
     */
    public on(name: string): this {
        this._connectionName = name;
        return this;
    }

    /**
     * Use a D1 read-replica session for all queries on this builder.
     *
     * @param constraint
     *   - `'first-unconstrained'` (default): start a new session, accept any replica
     *   - `'first-primary'`: force the primary; gives sequential consistency
     *   - a bookmark string from a previous session: continue where the prior request left off
     *
     * After running queries, call `getBookmark()` to read the latest position
     * and pass it to the next request to maintain read-your-writes consistency.
     *
     * @see https://developers.cloudflare.com/d1/best-practices/read-replication/
     *
     * @example
     * // Request 1 — write + read with primary
     * const qb = User.query().withSession('first-primary');
     * await User.create({ ... });
     * const bookmark = qb.getBookmark();
     * // … send bookmark to the client …
     *
     * @example
     * // Request 2 — continue session, reads see prior writes
     * const qb = User.query().withSession(req.headers.get('x-bookmark'));
     * const users = await qb.get(db);
     */
    public withSession(constraint: TSessionConstraint = "first-unconstrained"): this {
        this._sessionConstraint = constraint;
        this._activeSession = null; // lazily recreated on next query
        return this;
    }

    /**
     * Returns the most recent D1 session bookmark from a query executed on this
     * builder, or `null` if no session is active.
     */
    public getBookmark(): string | null {
        return this._activeSession?.getBookmark() ?? this._lastBookmark;
    }

    /**
     * Returns the D1 result metadata from the most recent query — `rows_read`,
     * `rows_written`, `duration`, `changes`, `last_row_id`, etc. Returns `null`
     * before any query has run.
     */
    public lastMeta(): TD1ResultMeta | null {
        return this._lastMeta;
    }

    /**
     * Resolve the executor (DB or active session) for a query. Lazily creates
     * the session on first use so all queries on this builder share one
     * bookmark progression.
     */
    private prepareSource(db: D1Database): D1Database | TD1SessionLike {
        if (!this._sessionConstraint) return db;
        if (this._activeSession) return this._activeSession;

        const withSession = (db as TD1DatabaseWithSession).withSession;
        if (typeof withSession !== "function") {
            // Older workers-types or non-D1 binding — fall back transparently.
            return db;
        }
        this._activeSession = withSession.call(db, this._sessionConstraint);
        return this._activeSession;
    }

    /**
     * Capture meta + bookmark after a query runs.
     */
    private recordMeta(meta: TD1ResultMeta | null | undefined): void {
        if (meta) this._lastMeta = meta;
        if (this._activeSession) {
            this._lastBookmark = this._activeSession.getBookmark();
        }
    }

    /**
     * Override the FROM table for this query (and any subsequent
     * insert/update/delete on the builder). Useful for archive / shadow
     * tables sharing the same schema.
     *
     * SECURITY: `table` is emitted verbatim into SQL — never pass
     * user-controlled input without wrapping it with `safeIdent()` first.
     */
    public from(table: string): this {
        this.table = table;
        return this;
    }

    public select(cols: string[] | string): this {
        this.selects = Array.isArray(cols) ? cols : [cols];
        this.selectSubBindings = [];
        return this;
    }

    /**
     * Add raw SQL expressions to the SELECT clause.
     *
     * @example
     * Post.query().selectRaw("COUNT(*) as post_count, user_id").groupBy("user_id")
     */
    public selectRaw(expression: string): this {
        if (this.selects.length === 1 && this.selects[0] === "*") {
            this.selects = [expression];
        } else {
            this.selects.push(expression);
        }
        return this;
    }

    /**
     * Add a subquery to the SELECT clause.
     *
     * @example
     * const sub = Comment.query().select(["COUNT(*)"]).whereColumn("comments.post_id", "posts.id");
     * Post.query().select(["id", "title"]).selectSub(sub, "comment_count")
     * // SELECT id, title, (SELECT COUNT(*) FROM comments WHERE comments.post_id = posts.id) AS comment_count FROM posts
     */
    public selectSub(query: QueryBuilder<any>, alias: string): this {
        const sub = query.toSelectSql();
        this.selectSubBindings.push(...sub.bindings);
        if (this.selects.length === 1 && this.selects[0] === "*") {
            this.selects = [`(${sub.sql}) AS ${alias}`];
        } else {
            this.selects.push(`(${sub.sql}) AS ${alias}`);
        }
        return this;
    }

    /**
     * Add DISTINCT modifier to the SELECT clause.
     *
     * @example
     * User.query().distinct().select(["email"]).get(db)
     */
    public distinct(): this {
        this._distinct = true;
        return this;
    }

    private pushWhere(clause: TWhereClause): this {
        this.wheres.push(clause);
        return this;
    }

    public where(col: string, op: TWhereOp, val: unknown): this {
        QueryBuilder.assertOp(op);
        return this.pushWhere({ kind: "basic", join: "AND", col, op, val });
    }

    public orWhere(col: string, op: TWhereOp, val: unknown): this {
        QueryBuilder.assertOp(op);
        return this.pushWhere({ kind: "basic", join: "OR", col, op, val });
    }

    public whereEq(col: string, val: unknown): this {
        return this.where(col, "=", val);
    }

    public orWhereEq(col: string, val: unknown): this {
        return this.orWhere(col, "=", val);
    }

    public whereLike(col: string, pattern: string): this {
        return this.where(col, "LIKE", pattern);
    }

    /**
     * FTS5 MATCH filter — apply to a virtual FTS5 table created with
     * `schema.createFts5Table()` or a column thereof.
     *
     * @example
     * // Whole-table search (matches against any indexed column)
     * Post.query().from("posts_search").whereMatch("posts_search", "rust workers")
     *   .orderByRank().limit(20).get(db)
     *
     * @example
     * // Column-scoped search
     * Post.query().from("posts_search").whereMatch("title", "claude")
     */
    public whereMatch(col: string, pattern: string): this {
        return this.pushWhere({ kind: "match", join: "AND", col, pattern });
    }

    public orWhereMatch(col: string, pattern: string): this {
        return this.pushWhere({ kind: "match", join: "OR", col, pattern });
    }

    /**
     * Order by FTS5 ranking — wraps `ORDER BY rank` (FTS5's implicit BM25 column).
     * Use after `whereMatch()` on an FTS5 virtual table.
     */
    public orderByRank(dir: TOrderDirection = "asc"): this {
        this.orders.push({ col: "rank", dir: QueryBuilder.assertDir(dir) });
        return this;
    }

    /**
     * Filter rows where a JSON column's value at `path` matches `value`.
     * Uses SQLite's `json_extract()` — note the path must include the leading `$`
     * for top-level keys (e.g. `'$.role'`).
     *
     * @example
     * User.query().whereJsonPath("settings", "$.role", "=", "admin")
     * User.query().whereJsonPath("config", "$.notifications.email", "=", 1)
     */
    public whereJsonPath(col: string, path: string, op: TWhereOp, value: unknown): this {
        return this.pushWhere({
            kind: "raw",
            join: "AND",
            sql: `json_extract(${col}, ?) ${op} ?`,
            bindings: [path, value],
        });
    }

    public orWhereJsonPath(col: string, path: string, op: TWhereOp, value: unknown): this {
        return this.pushWhere({
            kind: "raw",
            join: "OR",
            sql: `json_extract(${col}, ?) ${op} ?`,
            bindings: [path, value],
        });
    }

    /**
     * Filter rows where a JSON array column contains `value`. Uses `json_each()`
     * to expand the array; equality is by JSON value.
     *
     * @example
     * Post.query().whereJsonContains("tags", "rust")
     * Post.query().whereJsonContains("metadata.tags", "rust", "$.tags") // explicit path
     */
    public whereJsonContains(col: string, value: unknown, path?: string): this {
        const subject = path ? `json_extract(${col}, ?)` : col;
        const bindings: unknown[] = [];
        if (path) bindings.push(path);
        bindings.push(value);
        return this.pushWhere({
            kind: "raw",
            join: "AND",
            sql: `EXISTS (SELECT 1 FROM json_each(${subject}) WHERE json_each.value = ?)`,
            bindings,
        });
    }

    public orWhereJsonContains(col: string, value: unknown, path?: string): this {
        const subject = path ? `json_extract(${col}, ?)` : col;
        const bindings: unknown[] = [];
        if (path) bindings.push(path);
        bindings.push(value);
        return this.pushWhere({
            kind: "raw",
            join: "OR",
            sql: `EXISTS (SELECT 1 FROM json_each(${subject}) WHERE json_each.value = ?)`,
            bindings,
        });
    }

    /**
     * Filter rows by the length of a JSON array column.
     *
     * @example
     * Post.query().whereJsonLength("tags", ">=", 3)
     */
    public whereJsonLength(col: string, op: TWhereOp, length: number, path?: string): this {
        const subject = path ? `json_extract(${col}, ?)` : col;
        const bindings: unknown[] = [];
        if (path) bindings.push(path);
        bindings.push(length);
        return this.pushWhere({
            kind: "raw",
            join: "AND",
            sql: `json_array_length(${subject}) ${op} ?`,
            bindings,
        });
    }

    /**
     * Add a `json_extract(col, path) AS alias` expression to the SELECT clause.
     */
    public selectJsonExtract(col: string, path: string, alias: string): this {
        const expr = `json_extract(${col}, '${path.replaceAll("'", "''")}') AS ${alias}`;
        if (this.selects.length === 1 && this.selects[0] === "*") {
            this.selects = [expr];
        } else {
            this.selects.push(expr);
        }
        return this;
    }

    /**
     * Add a `json_group_array(<expr>) AS alias` aggregate to the SELECT clause.
     * Use with `groupBy()` to roll non-aggregated rows into JSON arrays.
     *
     * @example
     * // Tags per post:
     * Post.query()
     *   .select(['posts.id'])
     *   .selectJsonGroupArray('tags.name', 'tag_names')
     *   .join('tags', 'tags.post_id = posts.id')
     *   .groupBy('posts.id')
     *   .get()
     *
     * // Aggregate the result of json_extract to build arrays of nested values:
     * Order.query()
     *   .selectJsonGroupArray("json_extract(line_items, '$.sku')", 'skus')
     *   .groupBy('customer_id')
     *   .get()
     */
    public selectJsonGroupArray(expr: string, alias: string): this {
        const sql = `json_group_array(${expr}) AS ${alias}`;
        if (this.selects.length === 1 && this.selects[0] === "*") {
            this.selects = [sql];
        } else {
            this.selects.push(sql);
        }
        return this;
    }

    /**
     * Add a `json_group_object(<keyExpr>, <valueExpr>) AS alias` aggregate to
     * the SELECT clause. Use with `groupBy()` to fold rows into key→value JSON.
     *
     * @example
     * // Settings per user as a single JSON object:
     * UserSetting.query()
     *   .select(['user_id'])
     *   .selectJsonGroupObject('key', 'value', 'settings')
     *   .groupBy('user_id')
     *   .get()
     */
    public selectJsonGroupObject(keyExpr: string, valueExpr: string, alias: string): this {
        const sql = `json_group_object(${keyExpr}, ${valueExpr}) AS ${alias}`;
        if (this.selects.length === 1 && this.selects[0] === "*") {
            this.selects = [sql];
        } else {
            this.selects.push(sql);
        }
        return this;
    }

    /**
     * Order by a path inside a JSON column. The path is parameter-bound;
     * `col` is emitted verbatim — wrap untrusted column names with `safeIdent()`.
     *
     * @example
     * User.query().orderByJsonPath('settings', '$.priority', 'desc').get()
     */
    public orderByJsonPath(col: string, path: string, dir: TOrderDirection = "asc"): this {
        // We can't use the standard "orders" structure (which compiles col + dir)
        // because we need json_extract(col, ?) with a binding. Stuff into orders
        // as a raw column expression and rely on the parameter being inlined
        // safely below — paths are application-controlled strings.
        const safePath = path.replaceAll("'", "''");
        this.orders.push({
            col: `json_extract(${col}, '${safePath}')`,
            dir: QueryBuilder.assertDir(dir),
        });
        return this;
    }

    /**
     * WHERE col IN (...) — accepts an array of values or a subquery builder.
     *
     * @example
     * // Array
     * query.whereIn("id", ["a", "b", "c"])
     * // Subquery
     * query.whereIn("user_id", User.query().select("id").where("active", "=", 1))
     */
    public whereIn(col: string, vals: unknown[] | QueryBuilder<any>): this {
        if (vals instanceof QueryBuilder) {
            const sub = vals.toSelectSql();
            return this.pushWhere({ kind: "sub_in", join: "AND", col, negated: false, sql: sub.sql, bindings: sub.bindings });
        }
        return this.pushWhere({ kind: "in", join: "AND", col, vals });
    }

    public orWhereIn(col: string, vals: unknown[] | QueryBuilder<any>): this {
        if (vals instanceof QueryBuilder) {
            const sub = vals.toSelectSql();
            return this.pushWhere({ kind: "sub_in", join: "OR", col, negated: false, sql: sub.sql, bindings: sub.bindings });
        }
        return this.pushWhere({ kind: "in", join: "OR", col, vals });
    }

    public whereNotIn(col: string, vals: unknown[] | QueryBuilder<any>): this {
        if (vals instanceof QueryBuilder) {
            const sub = vals.toSelectSql();
            return this.pushWhere({ kind: "sub_in", join: "AND", col, negated: true, sql: sub.sql, bindings: sub.bindings });
        }
        return this.pushWhere({ kind: "not_in", join: "AND", col, vals });
    }

    public orWhereNotIn(col: string, vals: unknown[] | QueryBuilder<any>): this {
        if (vals instanceof QueryBuilder) {
            const sub = vals.toSelectSql();
            return this.pushWhere({ kind: "sub_in", join: "OR", col, negated: true, sql: sub.sql, bindings: sub.bindings });
        }
        return this.pushWhere({ kind: "not_in", join: "OR", col, vals });
    }

    public whereNull(col: string): this {
        return this.pushWhere({ kind: "null", join: "AND", col, negated: false });
    }

    public whereNotNull(col: string): this {
        return this.pushWhere({ kind: "null", join: "AND", col, negated: true });
    }

    public orWhereNull(col: string): this {
        return this.pushWhere({ kind: "null", join: "OR", col, negated: false });
    }

    public orWhereNotNull(col: string): this {
        return this.pushWhere({ kind: "null", join: "OR", col, negated: true });
    }

    public whereBetween(col: string, range: [unknown, unknown]): this {
        return this.pushWhere({ kind: "between", join: "AND", col, range, negated: false });
    }

    public whereNotBetween(col: string, range: [unknown, unknown]): this {
        return this.pushWhere({ kind: "between", join: "AND", col, range, negated: true });
    }

    public orWhereBetween(col: string, range: [unknown, unknown]): this {
        return this.pushWhere({ kind: "between", join: "OR", col, range, negated: false });
    }

    public orWhereNotBetween(col: string, range: [unknown, unknown]): this {
        return this.pushWhere({ kind: "between", join: "OR", col, range, negated: true });
    }

    public whereRaw(sql: string, bindings: unknown[] = []): this {
        return this.pushWhere({ kind: "raw", join: "AND", sql, bindings });
    }

    public orWhereRaw(sql: string, bindings: unknown[] = []): this {
        return this.pushWhere({ kind: "raw", join: "OR", sql, bindings });
    }

    /**
     * Filter on the DATE part of a datetime/date column — `WHERE date(<col>) op ?`.
     * Two-arg form uses `=`; three-arg takes an operator. Accepts a `Date`
     * (formatted to `YYYY-MM-DD`) or a `YYYY-MM-DD` string. `col` is emitted
     * verbatim — wrap untrusted input with `safeIdent()`.
     *
     * A `Date` is formatted in **UTC** (matching this ORM's UTC-ISO storage), so a
     * Date built from LOCAL components (`new Date(2026, 0, 16)`) in a non-UTC zone
     * can land on a different calendar day than intended — pass a `YYYY-MM-DD`
     * string, or a UTC-parsed Date, to avoid the ambiguity.
     *
     * @example
     * Post.query().whereDate('created_at', '2026-01-15')
     * Post.query().whereDate('created_at', '>=', new Date('2026-01-01'))
     */
    public whereDate(col: string, opOrValue: string | Date, value?: string | Date): this {
        const [op, v] = arguments.length < 3 ? ["=", opOrValue] : [opOrValue as string, value];
        QueryBuilder.assertOp(op as string);
        const s = v instanceof Date ? v.toISOString().slice(0, 10) : v;
        return this.whereRaw(`date(${col}${this.epochModifier(col)}) ${op} ?`, [s]);
    }

    /** Filter on the TIME part — `WHERE time(<col>) op ?` (`HH:MM:SS`). See {@link whereDate}. */
    public whereTime(col: string, opOrValue: string | Date, value?: string | Date): this {
        const [op, v] = arguments.length < 3 ? ["=", opOrValue] : [opOrValue as string, value];
        QueryBuilder.assertOp(op as string);
        const s = v instanceof Date ? v.toISOString().slice(11, 19) : v;
        return this.whereRaw(`time(${col}${this.epochModifier(col)}) ${op} ?`, [s]);
    }

    /** Filter on the 4-digit year — `WHERE strftime('%Y', <col>) = ?`. */
    public whereYear(col: string, year: number | string): this {
        // strftime('%Y') is 4-digit zero-padded, so pad the bound value to match
        // (years < 1000 would otherwise never compare equal).
        return this.whereRaw(`strftime('%Y', ${col}${this.epochModifier(col)}) = ?`, [String(year).padStart(4, "0")]);
    }

    /** Filter on the 2-digit month `01`–`12` — `WHERE strftime('%m', <col>) = ?`. */
    public whereMonth(col: string, month: number | string): this {
        return this.whereRaw(`strftime('%m', ${col}${this.epochModifier(col)}) = ?`, [String(month).padStart(2, "0")]);
    }

    /** Filter on the 2-digit day of month `01`–`31` — `WHERE strftime('%d', <col>) = ?`. */
    public whereDay(col: string, day: number | string): this {
        return this.whereRaw(`strftime('%d', ${col}${this.epochModifier(col)}) = ?`, [String(day).padStart(2, "0")]);
    }

    /**
     * SQLite modifier that makes date()/time()/strftime() read a `timestamp`-cast
     * column (stored as an integer unix-epoch) as a datetime - otherwise SQLite
     * treats the integer as a Julian day and the predicate silently matches nothing.
     * Empty for normal ISO-string datetime columns. Skipped for qualified columns
     * (`t.col`) since the cast map is keyed on bare names and could belong to a join.
     */
    private epochModifier(col: string): string {
        if (col.includes(".")) return "";
        const cast = this.resolveWhereCastMap()[col];
        return CastManager.isTimestampCast(cast) ? ", 'unixepoch'" : "";
    }

    /**
     * WHERE col1 op col2 — compare two column identifiers without parameter bindings.
     *
     * @example
     * query.whereColumn("price", ">", "cost")
     * query.whereColumn("updated_at", "created_at")  // defaults to =
     */
    public whereColumn(col1: string, col2: string): this;
    public whereColumn(col1: string, op: string, col2: string): this;
    public whereColumn(col1: string, opOrCol2: string, col2?: string): this {
        const op = col2 === undefined ? "=" : opOrCol2;
        const right = col2 === undefined ? opOrCol2 : col2;
        QueryBuilder.assertOp(op); // op is emitted unbound between two identifiers - validate it
        return this.pushWhere({ kind: "column", join: "AND", col1, op, col2: right });
    }

    /**
     * OR col1 op col2 — column-to-column comparison with OR join.
     */
    public orWhereColumn(col1: string, col2: string): this;
    public orWhereColumn(col1: string, op: string, col2: string): this;
    public orWhereColumn(col1: string, opOrCol2: string, col2?: string): this {
        const op = col2 === undefined ? "=" : opOrCol2;
        const right = col2 === undefined ? opOrCol2 : col2;
        QueryBuilder.assertOp(op); // op is emitted unbound between two identifiers - validate it
        return this.pushWhere({ kind: "column", join: "OR", col1, op, col2: right });
    }

    /**
     * AND group by default, but you can chain `orWhereGroup(...)` too.
     */
    public whereGroup(cb: (q: QueryBuilder<TModel, TRelations>) => void): this {
        const nested = new QueryBuilder<TModel, TRelations>(this.modelCtor);
        cb(nested);
        return this.pushWhere({ kind: "group", join: "AND", clauses: nested.wheres });
    }

    public orWhereGroup(cb: (q: QueryBuilder<TModel, TRelations>) => void): this {
        const nested = new QueryBuilder<TModel, TRelations>(this.modelCtor);
        cb(nested);
        return this.pushWhere({ kind: "group", join: "OR", clauses: nested.wheres });
    }

    /**
     * @internal Apply a user-supplied relation-constraint callback (from
     * `whereHas`/`whereDoesntHave`) onto this correlated subquery. If the
     * callback introduces a top-level OR, its predicates are wrapped in a
     * single group so they cannot decorrelate the parent-correlation `AND`
     * that precedes them; otherwise they are appended flat to preserve the
     * simple-case SQL shape.
     */
    public applyRelationConstraint(cb: (q: QueryBuilder<TModel, TRelations>) => void): this {
        const nested = new QueryBuilder<TModel, TRelations>(this.modelCtor);
        cb(nested);
        if (nested.wheres.length === 0) return this;
        const callbackHasTopLevelOr = nested.wheres.some((w, i) => i > 0 && w.join === "OR");
        if (callbackHasTopLevelOr) {
            return this.pushWhere({ kind: "group", join: "AND", clauses: nested.wheres });
        }
        for (const w of nested.wheres) this.pushWhere(w);
        return this;
    }

    /**
     * @internal Apply a constrained-eager-load callback to THIS batch-loader query.
     * Unlike a naive `constraint(this)`, it merges selectively so the callback can't
     * break result distribution:
     *  - the internal grouping columns the loader selected (`… as __pivot_fk` etc.)
     *    survive even when the callback calls `.select(...)`, and
     *  - a top-level OR in the callback is wrapped in an AND-group so it can't
     *    decorrelate the loader's `whereIn(parentKeys)` and leak other parents' rows.
     * Ordering / paging / grouping / joins the callback adds are carried through.
     */
    public applyEagerConstraint(constraint: (q: QueryBuilder<any, any>) => unknown): this {
        const groupingCols = this.selects.filter((s) => /\bas\s+__\w+\s*$/i.test(s));
        const probe = new QueryBuilder(this.modelCtor);
        constraint(probe as unknown as QueryBuilder<any, any>);

        if (probe.wheres.length > 0) {
            const hasTopLevelOr = probe.wheres.some((w, i) => i > 0 && w.join === "OR");
            if (hasTopLevelOr) this.pushWhere({ kind: "group", join: "AND", clauses: probe.wheres });
            else for (const w of probe.wheres) this.pushWhere(w);
        }

        const probeSelectsEverything = probe.selects.length === 1 && probe.selects[0] === "*";
        if (!probeSelectsEverything) {
            const merged = [...probe.selects];
            for (const g of groupingCols) if (!merged.includes(g)) merged.push(g);
            this.selects = merged;
        }

        this.orders.push(...probe.orders);
        if (probe.limitCount !== null) this.limitCount = probe.limitCount;
        if (probe.offsetCount !== null) this.offsetCount = probe.offsetCount;
        this.groups.push(...probe.groups);
        this.havings.push(...probe.havings);
        for (const j of probe.joins) this.joins.push(j);

        return this;
    }

    /**
     * Conditionally apply query clauses based on a runtime value.
     * When the condition is truthy, `ifTrue` is called with the query builder and the truthy value.
     * When falsy, `ifFalse` is called (if provided).
     */
    public when<T>(
        condition: T | false | null | undefined | 0 | "",
        ifTrue: (q: this, value: T) => void,
        ifFalse?: (q: this) => void,
    ): this {
        if (condition) {
            ifTrue(this, condition as T);
        } else if (ifFalse) {
            ifFalse(this);
        }
        return this;
    }

    /**
     * Low-level EXISTS clause. Prefer has()/whereHas() for relation-based queries.
     */
    public whereExists(sql: string, bindings: unknown[] = []): this {
        return this.pushWhere({ kind: "exists", join: "AND", not: false, sql, bindings });
    }

    public whereNotExists(sql: string, bindings: unknown[] = []): this {
        return this.pushWhere({ kind: "exists", join: "AND", not: true, sql, bindings });
    }

    /**
     * Filter by existence of related models.
     * Requires `static relations` to be defined on the model.
     *
     * @example
     * Post.query().has("comments").get(db)
     * // WHERE EXISTS (SELECT 1 FROM comments WHERE comments.post_id = posts.id)
     */
    public has(relation: string): this {
        return this.applyHas(relation, "AND", false);
    }

    /**
     * Filter by absence of related models.
     */
    public doesntHave(relation: string): this {
        return this.applyHas(relation, "AND", true);
    }

    /**
     * Filter by existence of related models with additional constraints.
     *
     * @example
     * Post.query().whereHas("comments", q => q.where("approved", "=", 1)).get(db)
     */
    public whereHas(relation: string, cb?: (q: QueryBuilder<any>) => void): this {
        return this.applyHas(relation, "AND", false, cb);
    }

    /**
     * Filter by absence of related models (or none matching constraints).
     */
    public whereDoesntHave(relation: string, cb?: (q: QueryBuilder<any>) => void): this {
        return this.applyHas(relation, "AND", true, cb);
    }

    /** OR variants */
    public orHas(relation: string): this {
        return this.applyHas(relation, "OR", false);
    }

    public orDoesntHave(relation: string): this {
        return this.applyHas(relation, "OR", true);
    }

    public orWhereHas(relation: string, cb?: (q: QueryBuilder<any>) => void): this {
        return this.applyHas(relation, "OR", false, cb);
    }

    public orWhereDoesntHave(relation: string, cb?: (q: QueryBuilder<any>) => void): this {
        return this.applyHas(relation, "OR", true, cb);
    }

    /**
     * Filter parents by a single condition on a related model — shorthand for
     * `whereHas(relation, q => q.where(column, op, value))`.
     *
     * Two-arg form uses `=`; three-arg form takes an explicit operator.
     *
     * @example
     * Post.query().whereRelation('comments', 'is_approved', false)
     * Post.query().whereRelation('comments', 'votes', '>', 5)
     */
    public whereRelation(relation: string, column: string, operatorOrValue: unknown, value?: unknown): this {
        // Discriminate the 2-value form `(rel, col, value)` from `(rel, col, op, value)`
        // by argument COUNT, not `value === undefined` — an explicitly-passed `undefined`
        // value must stay the value, not be mistaken for the operator.
        const [op, val] = arguments.length < 4 ? ["=", operatorOrValue] : [operatorOrValue as string, value];
        return this.whereHas(relation, (q) => q.where(column, op as TWhereOp, val));
    }

    /** `OR` variant of {@link whereRelation}. */
    public orWhereRelation(relation: string, column: string, operatorOrValue: unknown, value?: unknown): this {
        const [op, val] = arguments.length < 4 ? ["=", operatorOrValue] : [operatorOrValue as string, value];
        return this.orWhereHas(relation, (q) => q.where(column, op as TWhereOp, val));
    }

    private applyHas(
        relation: string,
        join: TWhereJoin,
        not: boolean,
        cb?: (q: QueryBuilder<any>) => void,
    ): this {
        const relations = this.modelCtor.relations;
        if (!relations || !relations[relation]) {
            throw new Error(
                `Unknown relation '${relation}' on ${this.modelCtor.table}. Define it in static relations.`,
            );
        }

        const def = relations[relation];
        const sub = buildExistsSubquery(def, this.modelCtor, cb);
        return this.pushWhere({ kind: "exists", join, not, sql: sub.sql, bindings: sub.bindings });
    }

    /**
     * Attach a `COUNT(*)` of a named relation as a virtual column on every row.
     * The default alias is `<relation>_count`; override via the second arg.
     *
     * Compiles to a correlated subquery in the SELECT list — one round-trip,
     * no N+1.
     *
     * @example
     * const users = await User.query().withCount('posts').get()
     * users[0].get('posts_count') // number
     *
     * // Custom alias
     * await User.query().withCount('posts', 'post_count').get()
     */
    public withCount(relation: string, as?: string): this {
        return this.applyRelationAgg(relation, "COUNT(*)", as ?? `${relation}_count`);
    }

    /**
     * Attach a `SUM(<col>)` of a named relation as a virtual column.
     * Default alias: `<relation>_<col>_sum`.
     *
     * @example
     * const users = await User.query().withSum('orders', 'total').get()
     * users[0].get('orders_total_sum') // number
     */
    public withSum(relation: string, col: string, as?: string): this {
        return this.applyRelationAgg(relation, `SUM(${col})`, as ?? `${relation}_${col}_sum`);
    }

    /**
     * Attach an `AVG(<col>)` of a named relation as a virtual column.
     * Default alias: `<relation>_<col>_avg`.
     *
     * @example
     * const users = await User.query().withAvg('orders', 'total').get()
     */
    public withAvg(relation: string, col: string, as?: string): this {
        return this.applyRelationAgg(relation, `AVG(${col})`, as ?? `${relation}_${col}_avg`);
    }

    /**
     * Attach `MIN(<col>)` of a named relation as a virtual column.
     * Default alias: `<relation>_<col>_min`.
     *
     * @example
     * await User.query().withMin('orders', 'total').get()  // → orders_total_min
     */
    public withMin(relation: string, col: string, as?: string): this {
        return this.applyRelationAgg(relation, `MIN(${col})`, as ?? `${relation}_${col}_min`);
    }

    /**
     * Attach `MAX(<col>)` of a named relation as a virtual column.
     * Default alias: `<relation>_<col>_max`.
     */
    public withMax(relation: string, col: string, as?: string): this {
        return this.applyRelationAgg(relation, `MAX(${col})`, as ?? `${relation}_${col}_max`);
    }

    /**
     * Attach a `0/1` existence flag for a named relation as a virtual column —
     * `1` when at least one related row matches, else `0`. Default alias:
     * `<relation>_exists`. Compiled as a correlated `COUNT(*) > 0` subquery.
     *
     * @example
     * const users = await User.query().withExists('posts').get()
     * Boolean(users[0].get('posts_exists'))  // has any post?
     */
    public withExists(relation: string, as?: string): this {
        return this.applyRelationAgg(relation, "COUNT(*) > 0", as ?? `${relation}_exists`);
    }

    private applyRelationAgg(relation: string, aggExpr: string, alias: string): this {
        const relations = this.modelCtor.relations;
        if (!relations || !relations[relation]) {
            throw new Error(
                `Unknown relation '${relation}' on ${this.modelCtor.table}. Define it in static relations.`,
            );
        }
        const def = relations[relation];
        const sub = buildAggregateSubquery(def, this.modelCtor, aggExpr);
        this.selectSubBindings.push(...sub.bindings);
        const expr = `(${sub.sql}) AS ${alias}`;
        if (this.selects.length === 1 && this.selects[0] === "*") {
            // Keep the model's own columns AND the new aggregate — qualify * with parent table
            this.selects = [`${this.modelCtor.table}.*`, expr];
        } else {
            this.selects.push(expr);
        }
        return this;
    }

    public join(table: string, on: string): this {
        this.joins.push({ type: "INNER", table, on });
        return this;
    }

    public leftJoin(table: string, on: string): this {
        this.joins.push({ type: "LEFT", table, on });
        return this;
    }

    public groupBy(...cols: string[]): this {
        this.groups.push(...cols);
        return this;
    }

    /**
     * HAVING col op val — filter grouped results.
     *
     * @example
     * query.groupBy("status").having("count", ">", 5)
     */
    public having(col: string, op: TWhereOp, val: unknown): this {
        QueryBuilder.assertOp(op);
        this.havings.push({ kind: "basic", join: "AND", col, op, val });
        return this;
    }

    public orHaving(col: string, op: TWhereOp, val: unknown): this {
        QueryBuilder.assertOp(op);
        this.havings.push({ kind: "basic", join: "OR", col, op, val });
        return this;
    }

    /**
     * HAVING raw SQL expression with bindings.
     *
     * @example
     * query.groupBy("user_id").havingRaw("COUNT(*) > ?", [5])
     */
    public havingRaw(sql: string, bindings: unknown[] = []): this {
        this.havings.push({ kind: "raw", join: "AND", sql, bindings });
        return this;
    }

    public orHavingRaw(sql: string, bindings: unknown[] = []): this {
        this.havings.push({ kind: "raw", join: "OR", sql, bindings });
        return this;
    }

    /**
     * Combine results with another query using UNION (removes duplicates).
     * Union clauses compile after LIMIT/OFFSET.
     * Each unioned query compiles independently (including its own soft-delete scope).
     *
     * @example
     * const admins = User.query().where("role", "=", "admin");
     * const active = User.query().where("active", "=", 1);
     * admins.union(active).get(db) // returns admins + active users (deduplicated)
     */
    public union(query: QueryBuilder<any>): this {
        const sub = query.toSelectSql();
        this.unions.push({ sql: sub.sql, bindings: sub.bindings, op: "UNION" });
        return this;
    }

    /**
     * Combine results with another query using UNION ALL (keeps duplicates).
     *
     * @example
     * query1.unionAll(query2).get(db)
     */
    public unionAll(query: QueryBuilder<any>): this {
        const sub = query.toSelectSql();
        this.unions.push({ sql: sub.sql, bindings: sub.bindings, op: "UNION ALL" });
        return this;
    }

    /**
     * Keep only rows present in BOTH this query and `query` (SQLite `INTERSECT`,
     * which deduplicates). SQLite has no `INTERSECT ALL`.
     *
     * @example
     * activeUsers.intersect(premiumUsers).get(db)
     */
    public intersect(query: QueryBuilder<any>): this {
        const sub = query.toSelectSql();
        this.unions.push({ sql: sub.sql, bindings: sub.bindings, op: "INTERSECT" });
        return this;
    }

    /**
     * Keep rows in this query that are NOT in `query` (SQLite `EXCEPT`, which
     * deduplicates). SQLite has no `EXCEPT ALL`.
     *
     * @example
     * allUsers.except(bannedUsers).get(db)
     */
    public except(query: QueryBuilder<any>): this {
        const sub = query.toSelectSql();
        this.unions.push({ sql: sub.sql, bindings: sub.bindings, op: "EXCEPT" });
        return this;
    }

    /**
     * Prepend a non-recursive Common Table Expression (`WITH name AS (...)`).
     * Multiple calls chain into a comma-separated WITH list.
     *
     * @example
     * const top = User.query().select(["id"]).orderBy("score", "desc").limit(10);
     * Post.query().withCte("top_users", top)
     *   .whereRaw("user_id IN (SELECT id FROM top_users)")
     *   .get(db);
     */
    public withCte(name: string, query: QueryBuilder<any>, columns?: string[]): this {
        const sub = query.toSelectSql();
        this.ctes.push({ name, recursive: false, sql: sub.sql, bindings: sub.bindings, columns });
        return this;
    }

    /**
     * Prepend a recursive CTE. Same surface as `withCte` but emits
     * `WITH RECURSIVE`. If multiple CTEs are added and any is recursive, the
     * compiled SQL uses `WITH RECURSIVE` for the whole list (SQLite syntax).
     */
    public withRecursive(name: string, query: QueryBuilder<any>, columns?: string[]): this {
        const sub = query.toSelectSql();
        this.ctes.push({ name, recursive: true, sql: sub.sql, bindings: sub.bindings, columns });
        return this;
    }

    /**
     * Suggest a specific index for this query (SQLite `INDEXED BY` hint).
     * Use sparingly — the SQLite planner is usually smarter.
     */
    public indexedBy(indexName: string): this {
        this.indexHint = { kind: "indexed", name: indexName };
        return this;
    }

    /**
     * Force the SQLite planner to avoid index usage on the primary FROM table.
     */
    public notIndexed(): this {
        this.indexHint = { kind: "not_indexed" };
        return this;
    }

    public orderBy(col: string, dir: TOrderDirection = "asc"): this {
        this.orders.push({ col, dir: QueryBuilder.assertDir(dir) });
        return this;
    }

    public limit(n: number): this {
        this.limitCount = QueryBuilder.assertRowCount(n, "LIMIT");
        return this;
    }

    public offset(n: number): this {
        this.offsetCount = QueryBuilder.assertRowCount(n, "OFFSET");
        return this;
    }

    /**
     * Validate a LIMIT/OFFSET operand at RUNTIME. These are interpolated verbatim
     * into the SQL tail (they aren't bound), and the `number` type is erased - so a
     * plain-JS caller forwarding an unparsed query-string value (`.limit(req.query.limit)`)
     * could otherwise inject SQL. Accept a non-negative integer (numeric strings are
     * coerced); anything else (a payload like `"10 UNION …"` → NaN) throws.
     */
    private static assertRowCount(n: number, clause: string): number {
        const v = Number(n);
        if (!Number.isInteger(v) || v < 0) {
            throw new Error(`Invalid ${clause} value: ${String(n)} (expected a non-negative integer)`);
        }
        return v;
    }

    /**
     * Eager loading — resolves loaders from explicit `eagerLoaders` first,
     * then falls back to auto-derived loaders from `static relations`.
     *
     * Two forms:
     * - **names**: `with(['author', 'comments'])`
     * - **constrained** (object map): `with({ comments: q => q.where('approved', '=', 1).orderBy('created_at', 'desc') })`
     *   — the callback scopes the batch query for that relation. Use `true` for an
     *   unconstrained relation in the object form. Constraints apply to
     *   auto-derived relations; a `static eagerLoaders` entry ignores them.
     *
     * @example
     * Post.query().with({ comments: q => q.where('approved', '=', 1), author: true }).get()
     */
    public with(relations: TRelations[]): this;
    public with(spec: Partial<Record<TRelations, TEagerConstraint | true>>): this;
    public with(relationsOrSpec: TRelations[] | Partial<Record<TRelations, TEagerConstraint | true>>): this {
        const entries: Array<[string, TEagerConstraint | undefined]> = Array.isArray(relationsOrSpec)
            ? relationsOrSpec.map((r) => [String(r), undefined])
            : Object.entries(relationsOrSpec).map(([k, v]) => [k, typeof v === "function" ? (v as TEagerConstraint) : undefined]);

        const explicit = this.modelCtor.eagerLoaders ?? {};
        const relDefs = this.modelCtor.relations;

        // Lazily derive loaders from static relations (cached per model constructor)
        let derived: Record<string, TEagerLoader<TModel>> | undefined;
        if (relDefs) {
            derived = derivedLoaderCache.get(this.modelCtor) as Record<string, TEagerLoader<TModel>> | undefined;
            if (!derived) {
                derived = deriveEagerLoaders(this.modelCtor, relDefs) as Record<string, TEagerLoader<TModel>>;
                derivedLoaderCache.set(this.modelCtor, derived);
            }
        }

        for (const [rel, constraint] of entries) {
            // Explicit eagerLoaders take precedence over auto-derived
            const loader = explicit[rel] ?? derived?.[rel];
            if (loader) {
                this.eagerLoaders.set(rel, loader);
                // Last write wins: re-registering a relation without a constraint
                // (e.g. the array form after an object-map form) must clear any prior
                // constraint, not silently keep it.
                if (constraint) this.eagerConstraints.set(rel, constraint);
                else this.eagerConstraints.delete(rel);
            } else {
                this.unknownRelations.push(rel);
            }
        }
        return this;
    }

    /** Clone only filter state (wheres, joins, trashed) — used by paginate for count queries. */
    private cloneFilters(): QueryBuilder<TModel, TRelations> {
        const qb = new QueryBuilder<TModel, TRelations>(this.modelCtor);
        qb.wheres = [...this.wheres];
        qb.joins = [...this.joins];
        qb.includeTrashed = this.includeTrashed;
        qb.onlyTrashedRows = this.onlyTrashedRows;
        qb.skippedGlobalScopes = new Set(this.skippedGlobalScopes);
        qb.skipAllGlobalScopes = this.skipAllGlobalScopes;
        qb._defaultDb = this._defaultDb;
        qb._connectionName = this._connectionName;
        qb.table = this.table;
        qb.ctes = [...this.ctes];
        qb.indexHint = this.indexHint;
        // Share session so paginate's count + data queries advance the same bookmark.
        qb._sessionConstraint = this._sessionConstraint;
        qb._activeSession = this._activeSession;
        return qb;
    }

    /** Full clone — preserves all query state for iteration methods like chunk(). */
    private clone(): QueryBuilder<TModel, TRelations> {
        const qb = this.cloneFilters();
        qb.selects = [...this.selects];
        qb.orders = [...this.orders];
        qb.groups = [...this.groups];
        qb._distinct = this._distinct;
        qb.havings = [...this.havings];
        qb.selectSubBindings = [...this.selectSubBindings];
        qb.unions = [...this.unions];
        qb.limitCount = this.limitCount;
        qb.offsetCount = this.offsetCount;
        qb.eagerLoaders = new Map(this.eagerLoaders);
        qb.eagerConstraints = new Map(this.eagerConstraints);
        qb.unknownRelations = [...this.unknownRelations];
        return qb;
    }

    private get modelId(): string {
        return this.modelCtor.modelName ?? this.modelCtor.table;
    }

    private resolveDb(db?: D1Database): D1Database {
        if (db) return db;
        if (this._defaultDb) return this._defaultDb;
        if (this._connectionName !== undefined) {
            return registryResolveDb(undefined, this._connectionName);
        }
        const conn = (this.modelCtor as unknown as { connection?: D1Database | string }).connection;
        return registryResolveDb(undefined, conn);
    }

    private isD1Database(val: unknown): val is D1Database {
        return typeof val === "object" && val !== null && "prepare" in val;
    }

    /**
     * Operators that compare against a text *pattern* rather than a typed
     * scalar. Values bound for these must stay raw — running a boolean/json/etc.
     * cast over a `LIKE` pattern would mangle it (e.g. turn the string `"%a%"`
     * into something else, or stringify it as JSON).
     */
    private static readonly PATTERN_OPS: ReadonlySet<string> = new Set([
        "LIKE",
        "NOT LIKE",
        "GLOB",
    ]);

    /**
     * Comparison operators accepted by `where()`/`orWhere()`. The op is emitted
     * verbatim into SQL, so it's validated at runtime — this closes the hole an
     * `as TWhereOp` cast (e.g. from `whereRelation`) or a plain-JS caller would
     * otherwise open to interpolate an arbitrary string into the compiled query.
     */
    private static readonly VALID_OPS: ReadonlySet<string> = new Set(WHERE_OPS);

    private static assertOp(op: string): void {
        // Accept the typed comparison ops (VALID_OPS, derived from TWhereOp) AND the
        // pattern ops (PATTERN_OPS: LIKE/NOT LIKE/GLOB) whose values stay raw - so a
        // JS/`as TWhereOp` caller using GLOB works instead of hitting a phantom throw.
        if (!QueryBuilder.VALID_OPS.has(op) && !QueryBuilder.PATTERN_OPS.has(op)) {
            const allowed = [...new Set([...QueryBuilder.VALID_OPS, ...QueryBuilder.PATTERN_OPS])];
            throw new Error(
                `Invalid SQL operator '${String(op)}'. Allowed: ${allowed.join(", ")}`,
            );
        }
    }

    /**
     * Validate + normalize an ORDER BY direction at RUNTIME. Like assertOp, the
     * direction is interpolated verbatim into the ORDER BY clause (it can't be a
     * bound parameter), and TOrderDirection is erased at runtime - so a plain-JS
     * caller or an `as TOrderDirection` cast could otherwise inject arbitrary SQL
     * (classic blind ORDER BY injection). Only 'asc'/'desc' pass.
     */
    private static assertDir(dir: string): "asc" | "desc" {
        const d = String(dir).toLowerCase();
        if (d !== "asc" && d !== "desc") {
            throw new Error(`Invalid order direction '${String(dir)}'. Allowed: asc, desc`);
        }
        return d;
    }

    /**
     * Resolve (and cache) the merged cast map for this builder's model.
     * Table-only / dummy ctors carry no `casts`, so the map is effectively a
     * no-op for dehydration of user columns.
     */
    private resolveWhereCastMap(): Record<string, AttributeCast> {
        if (this._whereCastMap === null) {
            this._whereCastMap = CastManager.resolveCastsFor(this.modelCtor);
        }
        return this._whereCastMap;
    }

    /**
     * Dehydrate a single where-value through the model's cast for `col`, the
     * same way writes are dehydrated. Returns the value untouched when:
     *  - the column is qualified (`table.col`) — casts are keyed on the bare
     *    column name; a qualified name could belong to a joined table, so we
     *    don't risk a cross-table cast mismatch;
     *  - the column has no cast in the merged map;
     *  - the operator is a text-pattern op (LIKE / NOT LIKE / GLOB).
     *
     * `CastManager.castSet` already no-ops on `null`/`undefined`, so null
     * values pass through unchanged.
     */
    private dehydrateWhereVal(col: string, op: string, val: unknown): unknown {
        if (val instanceof Placeholder) return val; // prepared-query placeholder — bound at execute time
        if (QueryBuilder.PATTERN_OPS.has(op)) return val;
        if (col.includes(".")) return val;
        const cast = this.resolveWhereCastMap()[col];
        if (!cast) return val;
        return CastManager.castSet(cast, val);
    }

    private compileWhere(clauses: TWhereClause[], bindings: unknown[]): string {
        const parts: string[] = [];

        for (let i = 0; i < clauses.length; i++) {
            const c = clauses[i];
            const prefix = i === 0 ? "" : ` ${c.join} `;

            if (c.kind === "basic") {
                bindings.push(this.dehydrateWhereVal(c.col, c.op, c.val));
                parts.push(`${prefix}${c.col} ${c.op} ?`);
            } else if (c.kind === "in") {
                // `col IN ()` is a SQLite syntax error. An empty set matches
                // nothing, so emit a constant-false predicate instead.
                if (c.vals.length === 0) {
                    parts.push(`${prefix}0 = 1`);
                } else {
                    const placeholders = c.vals.map(() => "?").join(", ");
                    bindings.push(...c.vals.map((v) => this.dehydrateWhereVal(c.col, "=", v)));
                    parts.push(`${prefix}${c.col} IN (${placeholders})`);
                }
            } else if (c.kind === "not_in") {
                // `col NOT IN ()` is a SQLite syntax error. An empty exclusion
                // set excludes nothing, so emit a constant-true predicate.
                if (c.vals.length === 0) {
                    parts.push(`${prefix}1 = 1`);
                } else {
                    const placeholders = c.vals.map(() => "?").join(", ");
                    bindings.push(...c.vals.map((v) => this.dehydrateWhereVal(c.col, "=", v)));
                    parts.push(`${prefix}${c.col} NOT IN (${placeholders})`);
                }
            } else if (c.kind === "sub_in") {
                bindings.push(...c.bindings);
                const op = c.negated ? "NOT IN" : "IN";
                parts.push(`${prefix}${c.col} ${op} (${c.sql})`);
            } else if (c.kind === "null") {
                parts.push(`${prefix}${c.col} ${c.negated ? "IS NOT NULL" : "IS NULL"}`);
            } else if (c.kind === "between") {
                bindings.push(
                    this.dehydrateWhereVal(c.col, "=", c.range[0]),
                    this.dehydrateWhereVal(c.col, "=", c.range[1]),
                );
                parts.push(`${prefix}${c.col} ${c.negated ? "NOT BETWEEN" : "BETWEEN"} ? AND ?`);
            } else if (c.kind === "raw") {
                bindings.push(...c.bindings);
                parts.push(`${prefix}(${c.sql})`);
            } else if (c.kind === "group") {
                const inner = this.compileWhere(c.clauses, bindings);
                parts.push(`${prefix}(${inner || "1=1"})`);
            } else if (c.kind === "exists") {
                bindings.push(...c.bindings);
                const op = c.not ? "NOT EXISTS" : "EXISTS";
                parts.push(`${prefix}${op} (${c.sql})`);
            } else if (c.kind === "column") {
                parts.push(`${prefix}${c.col1} ${c.op} ${c.col2}`);
            } else if (c.kind === "match") {
                bindings.push(c.pattern);
                parts.push(`${prefix}${c.col} MATCH ?`);
            }
        }

        return parts.join("");
    }

    /**
     * Compile the current WHERE clauses into a SQL fragment and bindings.
     * Does NOT inject soft-delete scope — used by update() and delete().
     */
    /**
     * Compile the active global scopes (honouring `withoutGlobalScope(s)`) into
     * self-contained AND-groups of where clauses. Each scope runs against a
     * throwaway builder, so `this.wheres` is never mutated.
     */
    private globalScopeGroups(): TWhereClause[] {
        if (this.skipAllGlobalScopes) return [];
        const groups: TWhereClause[] = [];
        for (const [name, fn] of Object.entries(this.modelCtor.globalScopes ?? {})) {
            if (this.skippedGlobalScopes.has(name)) continue;
            const tmp = new QueryBuilder(this.modelCtor);
            (fn as (q: QueryBuilder<any>) => void)(tmp);
            if (tmp.wheres.length > 0) groups.push({ kind: "group", join: "AND", clauses: [...tmp.wheres] });
        }
        return groups;
    }

    private compileWhereFragment(): { sql: string; bindings: unknown[] } | null {
        // Global scopes apply to writes too (bulk update/delete, updateReturning/
        // deleteReturning, the updateJson* variants, and increment/decrement) — so a
        // tenant-scoped model can never mutate another tenant's rows. Soft-delete is
        // intentionally NOT injected here: a write may legitimately target a trashed
        // row (e.g. purge/restore), so it stays a read-only scope in toSelectSql().
        const scopeGroups = this.globalScopeGroups();
        if (this.wheres.length === 0 && scopeGroups.length === 0) return null;
        // Same top-level-OR precedence guard as reads: wrap user predicates before
        // AND-appending a scope so `(a OR b) AND scope` can't leak across the OR.
        const hasTopLevelOr = this.wheres.some((w, i) => i > 0 && w.join === "OR");
        const allWheres: TWhereClause[] =
            scopeGroups.length > 0 && hasTopLevelOr
                ? [{ kind: "group", join: "AND", clauses: [...this.wheres] }]
                : [...this.wheres];
        allWheres.push(...scopeGroups);
        const bindings: unknown[] = [];
        const whereSql = this.compileWhere(allWheres, bindings);
        return { sql: ` WHERE ${whereSql}`, bindings };
    }

    private compileHaving(clauses: THavingClause[], bindings: unknown[]): string {
        const parts: string[] = [];
        for (let i = 0; i < clauses.length; i++) {
            const c = clauses[i];
            const prefix = i === 0 ? "" : ` ${c.join} `;
            if (c.kind === "basic") {
                bindings.push(c.val);
                parts.push(`${prefix}${c.col} ${c.op} ?`);
            } else if (c.kind === "raw") {
                bindings.push(...c.bindings);
                parts.push(`${prefix}(${c.sql})`);
            }
        }
        return parts.join("");
    }

    public toSelectSql(): TSelectQuery {
        const bindings: unknown[] = [];
        let sql = "";

        if (this.ctes.length > 0) {
            const recursive = this.ctes.some((c) => c.recursive);
            const withKeyword = recursive ? "WITH RECURSIVE" : "WITH";
            const parts = this.ctes.map((c) => {
                bindings.push(...c.bindings);
                const cols = c.columns && c.columns.length > 0 ? ` (${c.columns.join(", ")})` : "";
                return `${c.name}${cols} AS (${c.sql})`;
            });
            sql += `${withKeyword} ${parts.join(", ")} `;
        }

        bindings.push(...this.selectSubBindings);
        const distinct = this._distinct ? "DISTINCT " : "";
        sql += `SELECT ${distinct}${this.selects.join(", ")} FROM ${this.table}`;

        if (this.indexHint) {
            sql += this.indexHint.kind === "indexed"
                ? ` INDEXED BY ${this.indexHint.name}`
                : ` NOT INDEXED`;
        }

        for (const j of this.joins) {
            sql += ` ${j.type} JOIN ${j.table} ON ${j.on}`;
        }

        // Build WHERE clauses including soft-delete scope in a LOCAL copy (no mutation).
        // When an ORM-managed scope is AND-appended to user predicates that contain a
        // top-level OR, SQL precedence (AND binds tighter than OR) would bind the scope
        // to only the final OR branch — e.g. leaking soft-deleted rows. Wrap the user
        // predicates in a single group first so the scope applies to all of them.
        const scopeGroups = this.globalScopeGroups();
        const injectsScope =
            (this.modelCtor.softDeletes && (!this.includeTrashed || this.onlyTrashedRows)) ||
            scopeGroups.length > 0;
        const hasTopLevelOr = this.wheres.some((w, i) => i > 0 && w.join === "OR");
        const allWheres: TWhereClause[] =
            injectsScope && hasTopLevelOr
                ? [{ kind: "group", join: "AND", clauses: [...this.wheres] }]
                : [...this.wheres];
        // User-defined global scopes — each a self-contained AND-group (transient).
        allWheres.push(...scopeGroups);
        // When the query joins other tables (through-relations, belongsToMany pivots, …)
        // a bare `deleted_at` is ambiguous if a joined table also carries that column,
        // so qualify the soft-delete scope to THIS model's own table when joined;
        // single-table queries keep the unqualified column.
        //
        // Both the FROM source and each JOIN source are raw SQL fragments that may
        // carry an alias (`.from("memes m")`, `.join("memes m", …)`), and the model's
        // own table may be a JOIN rather than the FROM (e.g. searching an FTS virtual
        // table joined to `memes`). Qualifying with the raw FROM source alone breaks
        // both cases — `memes m.deleted_at` (invalid) or `memes_fts.deleted_at` (wrong
        // table). So find how the model's table is referenced across FROM + JOINs and
        // use its alias when present.
        const modelTable = this.modelCtor.table;
        const aliasOfModelTable = (source: string): string | null => {
            const tokens = source.trim().split(/\s+/);
            const first = tokens[0];
            if (!first) return null;
            // Accept the bare table (`posts`) OR a schema-qualified one (`main.posts`);
            // the `.` boundary avoids a false match on `line_items` for table `items`.
            if (first !== modelTable && !first.endsWith(`.${modelTable}`)) return null;
            // "posts p" / "posts AS p" / "main.posts p" -> alias; otherwise the source ref
            // itself (bare `posts`, or schema-qualified `main.posts` which is referenceable).
            return tokens.length > 1 ? (tokens[tokens.length - 1] ?? first) : first;
        };
        let tableRef = modelTable;
        for (const source of [this.table, ...this.joins.map((j) => j.table)]) {
            const ref = aliasOfModelTable(source);
            if (ref !== null) {
                tableRef = ref;
                break;
            }
        }
        const deletedAtCol = this.joins.length > 0 ? `${tableRef}.deleted_at` : "deleted_at";
        if (this.modelCtor.softDeletes && !this.includeTrashed) {
            allWheres.push({ kind: "raw", join: "AND", sql: `${deletedAtCol} IS NULL`, bindings: [] });
        }

        if (this.modelCtor.softDeletes && this.onlyTrashedRows) {
            allWheres.push({ kind: "raw", join: "AND", sql: `${deletedAtCol} IS NOT NULL`, bindings: [] });
        }

        if (allWheres.length > 0) {
            const whereSql = this.compileWhere(allWheres, bindings);
            sql += ` WHERE ${whereSql}`;
        }

        if (this.groups.length > 0) {
            sql += ` GROUP BY ${this.groups.join(", ")}`;
        }

        if (this.havings.length > 0) {
            const havingSql = this.compileHaving(this.havings, bindings);
            sql += ` HAVING ${havingSql}`;
        }

        if (this.orders.length > 0) {
            const orderSql = this.orders.map((o) => `${o.col} ${o.dir.toUpperCase()}`).join(", ");
            sql += ` ORDER BY ${orderSql}`;
        }

        if (this.limitCount !== null) sql += ` LIMIT ${this.limitCount}`;
        if (this.offsetCount !== null) sql += ` OFFSET ${this.offsetCount}`;

        for (const u of this.unions) {
            bindings.push(...u.bindings);
            sql += ` ${u.op} ${u.sql}`;
        }

        return { sql, bindings };
    }

    public async get(db?: D1Database): Promise<Collection<TModel>> {
        if (this.unknownRelations.length > 0) {
            throw new Error(
                `Unknown eager relation: '${this.unknownRelations[0]}'. Define it in static eagerLoaders.`
            );
        }
        const _db = this.resolveDb(db);
        const exec = this.prepareSource(_db);
        const q = this.toSelectSql();
        const res = await exec.prepare(q.sql).bind(...q.bindings).all<Record<string, unknown>>();
        this.recordMeta(res.meta as TD1ResultMeta | undefined);
        const items = (res.results ?? []).map((row) => {
            const model = new this.modelCtor(row as Partial<TModelAttrsOf<TModel>>);
            (model as unknown as { _persisted: boolean })._persisted = true;
            return typeof (model as unknown as BaseModel<any>).asProxy === "function"
                ? (model as unknown as BaseModel<any>).asProxy() as unknown as TModel
                : model;
        });

        const models = Collection.from(items);

        // Eager load after the base query. Sibling relations are independent - each
        // loader reads the shared `models` keys read-only and writes a DISTINCT
        // relation slot - so fire them concurrently (max-of-round-trips, not sum).
        await Promise.all(
            Array.from(this.eagerLoaders, ([rel, loader]) => loader(_db, models, this.eagerConstraints.get(rel))),
        );

        return models;
    }

    /**
     * Compile this query **once** into a reusable {@link PreparedQuery}. Use
     * `placeholder(name)` in filter values, then execute repeatedly with
     * different params — the SQL string is built a single time.
     *
     * @example
     * const byEmail = User.query().whereEq('email', placeholder('email')).prepare(env.DB)
     * const a = await byEmail.first({ email: 'a@x.com' })
     * const b = await byEmail.first({ email: 'b@x.com' })
     */
    public prepare(db?: D1Database): PreparedQuery<TModel> {
        // Validate eager relations at prepare time, mirroring get() — otherwise an
        // unknown `.with()` would be silently swallowed by the prepared path.
        if (this.unknownRelations.length > 0) {
            throw new Error(
                `Unknown eager relation: '${this.unknownRelations[0]}'. Define it in static eagerLoaders.`
            );
        }
        const q = this.toSelectSql();
        return new PreparedQuery<TModel>(
            this.modelCtor,
            q.sql,
            q.bindings,
            this.resolveDb(db),
            this.eagerLoaders,
            this.eagerConstraints,
        );
    }

    /**
     * Execute the query and return the data plus D1 result metadata and the
     * active session bookmark (when sessions are in use).
     *
     * @example
     * const { data, meta, bookmark } = await User.query().withSession().getWithMeta(db);
     * res.headers.set('x-bookmark', bookmark ?? '');
     * res.headers.set('x-rows-read', String(meta.rows_read ?? 0));
     */
    public async getWithMeta(db?: D1Database): Promise<TQueryResult<Collection<TModel>>> {
        const data = await this.get(db);
        return {
            data,
            meta: this._lastMeta ?? {},
            bookmark: this.getBookmark(),
        };
    }

    /**
     * Like `first()` but returns the model alongside D1 metadata and bookmark.
     */
    public async firstWithMeta(db?: D1Database): Promise<TQueryResult<TModel | null>> {
        const data = await this.first(db);
        return {
            data,
            meta: this._lastMeta ?? {},
            bookmark: this.getBookmark(),
        };
    }

    public async first(db?: D1Database): Promise<TModel | null> {
        this.limit(1);
        const rows = await this.get(db);
        return rows[0] ?? null;
    }

    /**
     * Add an equality (or explicit-operator) filter and return the first match —
     * shorthand for `.where(column, op, value).first()`.
     *
     * Two-arg form uses `=`; three-arg form takes an explicit operator. db-first
     * overloads are available, or set it via `Model.query(db)` / `configure(env)`.
     *
     * @example
     * await User.query().firstWhere('email', 'a@b.com')
     * await Post.query().firstWhere('votes', '>', 100)
     */
    public async firstWhere(column: string, operatorOrValue: unknown, value?: unknown): Promise<TModel | null>;
    public async firstWhere(db: D1Database, column: string, operatorOrValue: unknown, value?: unknown): Promise<TModel | null>;
    public async firstWhere(
        dbOrColumn: D1Database | string,
        columnOrOpVal?: unknown,
        opValOrVal?: unknown,
        value?: unknown,
    ): Promise<TModel | null> {
        const hasDb = this.isD1Database(dbOrColumn);
        const _db = hasDb ? (dbOrColumn as D1Database) : undefined;
        const column = (hasDb ? columnOrOpVal : dbOrColumn) as string;
        const opOrVal = hasDb ? opValOrVal : columnOrOpVal;
        const val = hasDb ? value : opValOrVal;
        // "value provided?" by arg count (db-aware), so an explicit `undefined` value
        // isn't misread as the operator.
        const valueProvided = hasDb ? arguments.length >= 4 : arguments.length >= 3;
        const [op, v] = valueProvided ? [opOrVal as string, val] : ["=", opOrVal];
        this.where(column, op as TWhereOp, v);
        return _db ? this.first(_db) : this.first();
    }

    public async firstOrFail(db?: D1Database): Promise<TModel> {
        const model = await this.first(db);
        if (!model) throw new ModelNotFoundException(this.modelId);
        return model;
    }

    public async sole(db?: D1Database): Promise<TModel> {
        this.limitCount = 2;
        const rows = await this.get(db);
        if (rows.length === 0) throw new ModelNotFoundException(this.modelId);
        if (rows.length > 1) throw new MultipleRecordsFoundException(this.modelId, rows.length);
        return rows[0];
    }

    public async count(db?: D1Database): Promise<number> {
        const _db = this.resolveDb(db);
        const exec = this.prepareSource(_db);
        // Snapshot/restore the SELECT list so count() doesn't permanently mutate the
        // builder to `COUNT(*)` - reusing the same instance for count() then get() was
        // a documented footgun (a list endpoint would serve `[{ c: N }]`).
        const savedSelects = this.selects;
        this.selects = ["COUNT(*) as c"];
        const q = this.toSelectSql();
        this.selects = savedSelects;
        const stmt = exec.prepare(q.sql).bind(...q.bindings);
        const res = await stmt.all<{ c: number }>();
        this.recordMeta(res.meta as TD1ResultMeta | undefined);
        return res.results?.[0]?.c ?? 0;
    }

    public async sum(col: string): Promise<number>;
    public async sum(db: D1Database, col: string): Promise<number>;
    public async sum(dbOrCol: D1Database | string, col?: string): Promise<number> {
        const _db = typeof dbOrCol === "string" ? this.resolveDb() : this.resolveDb(dbOrCol);
        const _col = typeof dbOrCol === "string" ? dbOrCol : col!;
        const exec = this.prepareSource(_db);
        const q = this.select([`SUM(${_col}) as _agg`]).toSelectSql();
        const res = await exec.prepare(q.sql).bind(...q.bindings).all<{ _agg: number | null }>();
        this.recordMeta(res.meta as TD1ResultMeta | undefined);
        return res.results?.[0]?._agg ?? 0;
    }

    public async avg(col: string): Promise<number | null>;
    public async avg(db: D1Database, col: string): Promise<number | null>;
    public async avg(dbOrCol: D1Database | string, col?: string): Promise<number | null> {
        const _db = typeof dbOrCol === "string" ? this.resolveDb() : this.resolveDb(dbOrCol);
        const _col = typeof dbOrCol === "string" ? dbOrCol : col!;
        const exec = this.prepareSource(_db);
        const q = this.select([`AVG(${_col}) as _agg`]).toSelectSql();
        const res = await exec.prepare(q.sql).bind(...q.bindings).all<{ _agg: number | null }>();
        this.recordMeta(res.meta as TD1ResultMeta | undefined);
        return res.results?.[0]?._agg ?? null;
    }

    public async min(col: string): Promise<unknown>;
    public async min(db: D1Database, col: string): Promise<unknown>;
    public async min(dbOrCol: D1Database | string, col?: string): Promise<unknown> {
        const _db = typeof dbOrCol === "string" ? this.resolveDb() : this.resolveDb(dbOrCol);
        const _col = typeof dbOrCol === "string" ? dbOrCol : col!;
        const exec = this.prepareSource(_db);
        const q = this.select([`MIN(${_col}) as _agg`]).toSelectSql();
        const res = await exec.prepare(q.sql).bind(...q.bindings).all<{ _agg: unknown }>();
        this.recordMeta(res.meta as TD1ResultMeta | undefined);
        return res.results?.[0]?._agg ?? null;
    }

    public async max(col: string): Promise<unknown>;
    public async max(db: D1Database, col: string): Promise<unknown>;
    public async max(dbOrCol: D1Database | string, col?: string): Promise<unknown> {
        const _db = typeof dbOrCol === "string" ? this.resolveDb() : this.resolveDb(dbOrCol);
        const _col = typeof dbOrCol === "string" ? dbOrCol : col!;
        const exec = this.prepareSource(_db);
        const q = this.select([`MAX(${_col}) as _agg`]).toSelectSql();
        const res = await exec.prepare(q.sql).bind(...q.bindings).all<{ _agg: unknown }>();
        this.recordMeta(res.meta as TD1ResultMeta | undefined);
        return res.results?.[0]?._agg ?? null;
    }

    // ── Scopes ───────────────────────────────────────────────────────────

    /**
     * Apply one or more named scopes defined in `static scopes` on the model.
     *
     * @example
     * class Post extends BaseModel<PostAttrs> {
     *   static scopes = {
     *     active: (q) => q.where("status", "=", "active"),
     *     recent: (q) => q.orderBy("created_at", "desc").limit(10),
     *   }
     * }
     * Post.query().scoped("active", "recent").get(db)
     */
    public scoped(...names: string[]): this {
        const scopes = this.modelCtor.scopes as Record<string, (q: this) => void> | undefined;
        for (const name of names) {
            const scope = scopes?.[name];
            if (!scope) {
                throw new Error(
                    `Unknown scope '${name}' on ${this.modelCtor.table}. Define it in static scopes.`,
                );
            }
            scope(this);
        }
        return this;
    }

    // ── Pagination ──────────────────────────────────────────────────────

    /**
     * Paginate results with a count query.
     *
     * @returns `{ data, total, page, perPage, lastPage }`
     *
     * @example
     * const result = await Post.query().paginate(db, 1, 20)
     * // result.data: Post[], result.total: number, result.lastPage: number
     */
    public async paginate(page: number, perPage?: number): Promise<TPaginationResult<TModel>>;
    public async paginate(db: D1Database, page: number, perPage?: number): Promise<TPaginationResult<TModel>>;
    public async paginate(
        dbOrPage: D1Database | number,
        pageOrPerPage?: number,
        perPage?: number,
    ): Promise<TPaginationResult<TModel>> {
        const _db = this.isD1Database(dbOrPage) ? this.resolveDb(dbOrPage) : this.resolveDb();
        const _page = Math.max(1, QueryBuilder.assertRowCount(this.isD1Database(dbOrPage) ? (pageOrPerPage ?? 1) : (dbOrPage as number), "page"));
        const _perPage = QueryBuilder.assertRowCount(this.isD1Database(dbOrPage) ? (perPage ?? 15) : (pageOrPerPage ?? 15), "perPage");

        // Count (filter-only clone) and the page data are independent queries - run
        // them concurrently instead of serializing two D1 round trips.
        this.limitCount = _perPage;
        this.offsetCount = (_page - 1) * _perPage;
        const [total, data] = await Promise.all([this.cloneFilters().count(_db), this.get(_db)]);

        return {
            data,
            total,
            page: _page,
            perPage: _perPage,
            lastPage: Math.max(1, Math.ceil(total / _perPage)),
        };
    }

    /**
     * Keyset / cursor pagination — stable under concurrent writes and faster
     * than offset pagination on large tables (no COUNT, no offset scan).
     *
     * The cursor encodes the last row's ORDER BY value plus its primary key
     * as a tiebreaker. Pass `nextCursor` from one response as `after` in the
     * next request to advance forward; `prevCursor` as `before` to step back.
     *
     * Only single-column ordering is supported — combined with the model PK
     * for determinism. Use `paginate()` (offset) when you need multi-column
     * ordering.
     *
     * @example
     * // First page
     * const page1 = await Post.query()
     *   .whereEq('user_id', uid)
     *   .paginateCursor({ orderBy: 'created_at', direction: 'desc', perPage: 20 });
     *
     * // Next page — pass page1.nextCursor as `after`
     * const page2 = await Post.query()
     *   .whereEq('user_id', uid)
     *   .paginateCursor({ orderBy: 'created_at', direction: 'desc', after: page1.nextCursor! });
     */
    public async paginateCursor(
        opts: TCursorPaginateOpts,
        db?: D1Database,
    ): Promise<TCursorPaginationResult<TModel>> {
        const _db = this.resolveDb(db);
        const perPage = opts.perPage ?? 20;
        const direction: "asc" | "desc" = opts.direction ?? "desc";
        const orderCol = opts.orderBy;
        const pkCol = this.modelCtor.primaryKey;
        const orderByPkOnly = orderCol === pkCol;

        if (opts.after && opts.before) {
            throw new Error("paginateCursor: pass either 'after' or 'before', not both.");
        }

        // Decode cursor if provided
        let cursorVals: { col: unknown; pk: unknown } | null = null;
        let goingBack = false;
        if (opts.after) {
            cursorVals = decodeCursor(opts.after);
        } else if (opts.before) {
            cursorVals = decodeCursor(opts.before);
            goingBack = true;
        }

        // Effective direction: if going back, flip comparison + sort then reverse data later
        const effDir: "asc" | "desc" = goingBack
            ? direction === "asc" ? "desc" : "asc"
            : direction;

        // Filter for compound comparison (col, pk) <effOp> (cursor.col, cursor.pk)
        if (cursorVals !== null) {
            const op = effDir === "asc" ? ">" : "<";
            if (orderByPkOnly) {
                this.pushWhere({
                    kind: "basic",
                    join: "AND",
                    col: pkCol,
                    op: op as TWhereOp,
                    val: cursorVals.pk,
                });
            } else {
                // (col, pk) > (cv, cpk) ≡ col > cv OR (col = cv AND pk > cpk)
                this.pushWhere({
                    kind: "raw",
                    join: "AND",
                    sql: `(${orderCol} ${op} ? OR (${orderCol} = ? AND ${pkCol} ${op} ?))`,
                    bindings: [cursorVals.col, cursorVals.col, cursorVals.pk],
                });
            }
        }

        // Order + tiebreaker
        this.orders = [];
        this.orderBy(orderCol, effDir);
        if (!orderByPkOnly) this.orderBy(pkCol, effDir);

        // Over-fetch by 1 to detect if there's more
        this.limitCount = perPage + 1;
        const fetched = await this.get(_db);

        const overfetched = fetched.length > perPage;
        const trimmed = overfetched ? fetched.slice(0, perPage) : fetched;
        if (goingBack) trimmed.reverse();

        // Build cursors from boundary rows
        const data = trimmed as unknown as Collection<TModel>;
        const last = trimmed[trimmed.length - 1];
        const first = trimmed[0];

        const encode = (row: TModel | undefined): string | null => {
            if (!row) return null;
            const r = row as unknown as { get(key: string): unknown };
            const col = r.get(orderCol);
            const pk = r.get(pkCol);
            return encodeCursor({ col, pk });
        };

        let nextCursor: string | null = null;
        let prevCursor: string | null = null;

        if (goingBack) {
            // Going back: hasMore == there were more rows in the "before" direction
            nextCursor = encode(last);
            prevCursor = overfetched ? encode(first) : null;
        } else {
            nextCursor = overfetched ? encode(last) : null;
            // Only emit prevCursor when we navigated forward via a cursor — first page has no prev
            prevCursor = cursorVals !== null ? encode(first) : null;
        }

        const hasMore = goingBack ? overfetched : overfetched;

        return { data, nextCursor, prevCursor, hasMore };
    }

    // ── Scalar results ──────────────────────────────────────────────────

    /**
     * Return a flat array of a single column's values.
     *
     * @example
     * const emails = await User.query().pluck(db, "email")
     * // ["alice@example.com", "bob@example.com"]
     */
    public async pluck(col: string): Promise<unknown[]>;
    public async pluck(db: D1Database, col: string): Promise<unknown[]>;
    public async pluck(dbOrCol: D1Database | string, col?: string): Promise<unknown[]> {
        const _db = typeof dbOrCol === "string" ? this.resolveDb() : this.resolveDb(dbOrCol);
        const _col = typeof dbOrCol === "string" ? dbOrCol : col!;
        const exec = this.prepareSource(_db);
        const q = this.select([_col]).toSelectSql();
        const res = await exec.prepare(q.sql).bind(...q.bindings).all<Record<string, unknown>>();
        this.recordMeta(res.meta as TD1ResultMeta | undefined);
        return (res.results ?? []).map((row) => row[_col]);
    }

    /**
     * Return a single scalar value (first row, single column).
     *
     * @example
     * const email = await User.query().whereEq("id", "u1").value(db, "email")
     * // "alice@example.com"
     */
    public async value(col: string): Promise<unknown>;
    public async value(db: D1Database, col: string): Promise<unknown>;
    public async value(dbOrCol: D1Database | string, col?: string): Promise<unknown> {
        const _db = typeof dbOrCol === "string" ? this.resolveDb() : this.resolveDb(dbOrCol);
        const _col = typeof dbOrCol === "string" ? dbOrCol : col!;
        this.limitCount = 1;
        const exec = this.prepareSource(_db);
        const q = this.select([_col]).toSelectSql();
        const res = await exec.prepare(q.sql).bind(...q.bindings).all<Record<string, unknown>>();
        this.recordMeta(res.meta as TD1ResultMeta | undefined);
        return res.results?.[0]?.[_col] ?? null;
    }

    // ── Chunked iteration ───────────────────────────────────────────────

    /**
     * Process query results in chunks to avoid loading all rows at once.
     *
     * @example
     * await Post.query().chunk(db, 100, async (posts) => {
     *   for (const post of posts) await processPost(post);
     * })
     */
    public async chunk(size: number, cb: (models: TModel[]) => Promise<void | false>): Promise<void>;
    public async chunk(db: D1Database, size: number, cb: (models: TModel[]) => Promise<void | false>): Promise<void>;
    public async chunk(
        dbOrSize: D1Database | number,
        sizeOrCb: number | ((models: TModel[]) => Promise<void | false>),
        cb?: (models: TModel[]) => Promise<void | false>,
    ): Promise<void> {
        const _db = this.isD1Database(dbOrSize) ? this.resolveDb(dbOrSize) : this.resolveDb();
        const _size = this.isD1Database(dbOrSize) ? (sizeOrCb as number) : (dbOrSize as number);
        const _cb = this.isD1Database(dbOrSize) ? cb! : (sizeOrCb as (models: TModel[]) => Promise<void | false>);

        let page = 0;
        while (true) {
            const qb = this.clone();

            qb.limit(_size).offset(page * _size);
            const rows = await qb.get(_db);
            if (rows.length === 0) break;

            const result = await _cb(rows);
            if (result === false) break;

            if (rows.length < _size) break; // last page
            page++;
        }
    }

    public toInsertPrepared(values: Record<string, unknown>): D1PreparedStatement;
    public toInsertPrepared(db: D1Database, values: Record<string, unknown>): D1PreparedStatement;
    public toInsertPrepared(dbOrValues: D1Database | Record<string, unknown>, values?: Record<string, unknown>): D1PreparedStatement {
        const _db = this.isD1Database(dbOrValues) ? this.resolveDb(dbOrValues) : this.resolveDb();
        const _values = this.isD1Database(dbOrValues) ? values! : dbOrValues;
        const cols = Object.keys(_values);
        const placeholders = cols.map(() => "?").join(", ");
        const sql = `INSERT INTO ${this.table} (${cols.join(", ")}) VALUES (${placeholders})`;
        const bindings = cols.map((k) => _values[k]);
        return _db.prepare(sql).bind(...bindings);
    }

    public toInsertOrIgnorePrepared(values: Record<string, unknown>): D1PreparedStatement;
    public toInsertOrIgnorePrepared(db: D1Database, values: Record<string, unknown>): D1PreparedStatement;
    public toInsertOrIgnorePrepared(dbOrValues: D1Database | Record<string, unknown>, values?: Record<string, unknown>): D1PreparedStatement {
        const _db = this.isD1Database(dbOrValues) ? this.resolveDb(dbOrValues) : this.resolveDb();
        const _values = this.isD1Database(dbOrValues) ? values! : dbOrValues;
        const cols = Object.keys(_values);
        const placeholders = cols.map(() => "?").join(", ");
        const sql = `INSERT OR IGNORE INTO ${this.table} (${cols.join(", ")}) VALUES (${placeholders})`;
        const bindings = cols.map((k) => _values[k]);
        return _db.prepare(sql).bind(...bindings);
    }

    public toUpsertPrepared(values: Record<string, unknown>, conflictCols: string[], updateCols?: string[]): D1PreparedStatement;
    public toUpsertPrepared(db: D1Database, values: Record<string, unknown>, conflictCols: string[], updateCols?: string[]): D1PreparedStatement;
    public toUpsertPrepared(
        dbOrValues: D1Database | Record<string, unknown>,
        valuesOrConflict: Record<string, unknown> | string[],
        conflictOrUpdate?: string[],
        updateCols?: string[],
    ): D1PreparedStatement {
        const _db = this.isD1Database(dbOrValues) ? this.resolveDb(dbOrValues) : this.resolveDb();
        const _values = this.isD1Database(dbOrValues) ? (valuesOrConflict as Record<string, unknown>) : (dbOrValues as Record<string, unknown>);
        const _conflictCols = this.isD1Database(dbOrValues) ? conflictOrUpdate! : (valuesOrConflict as string[]);
        const _updateCols = this.isD1Database(dbOrValues) ? updateCols : conflictOrUpdate;
        return this._buildUpsertPrepared(_db, _values, _conflictCols, _updateCols);
    }

    private _buildUpsertPrepared(
        db: D1Database,
        values: Record<string, unknown>,
        conflictCols: string[],
        updateCols?: string[],
    ): D1PreparedStatement {
        const cols = Object.keys(values);
        const placeholders = cols.map(() => "?").join(", ");
        const bindings = cols.map((k) => values[k]);

        const toUpdate = updateCols ?? cols.filter((c) => !conflictCols.includes(c));
        const setSql = toUpdate.map((c) => `${c} = excluded.${c}`).join(", ");

        const sql = setSql
            ? `INSERT INTO ${this.table} (${cols.join(", ")}) VALUES (${placeholders}) ON CONFLICT(${conflictCols.join(", ")}) DO UPDATE SET ${setSql}`
            : `INSERT INTO ${this.table} (${cols.join(", ")}) VALUES (${placeholders}) ON CONFLICT(${conflictCols.join(", ")}) DO NOTHING`;

        return db.prepare(sql).bind(...bindings);
    }

    public toUpdatePrepared(values: Record<string, unknown>): D1PreparedStatement;
    public toUpdatePrepared(db: D1Database, values: Record<string, unknown>): D1PreparedStatement;
    public toUpdatePrepared(dbOrValues: D1Database | Record<string, unknown>, values?: Record<string, unknown>): D1PreparedStatement {
        const _db = this.isD1Database(dbOrValues) ? this.resolveDb(dbOrValues) : this.resolveDb();
        const _values = this.isD1Database(dbOrValues) ? values! : dbOrValues;
        const cols = Object.keys(_values);
        const setSql = cols.map((c) => `${c} = ?`).join(", ");
        const bindings = cols.map((k) => _values[k]);

        let sql = `UPDATE ${this.table} SET ${setSql}`;

        const whereResult = this.compileWhereFragment();
        if (whereResult) {
            sql += whereResult.sql;
            bindings.push(...whereResult.bindings);
        }

        return _db.prepare(sql).bind(...bindings);
    }

    public toDeletePrepared(db?: D1Database): D1PreparedStatement {
        const _db = this.resolveDb(db);
        let sql = `DELETE FROM ${this.table}`;
        const bindings: unknown[] = [];

        const whereResult = this.compileWhereFragment();
        if (whereResult) {
            sql += whereResult.sql;
            bindings.push(...whereResult.bindings);
        }

        return _db.prepare(sql).bind(...bindings);
    }

    public async insert(values: Record<string, unknown>): Promise<void>;
    public async insert(db: D1Database, values: Record<string, unknown>): Promise<void>;
    public async insert(dbOrValues: D1Database | Record<string, unknown>, values?: Record<string, unknown>): Promise<void> {
        const _db = this.isD1Database(dbOrValues) ? this.resolveDb(dbOrValues) : this.resolveDb();
        const _values = this.isD1Database(dbOrValues) ? values! : dbOrValues;
        const cols = Object.keys(_values);
        const placeholders = cols.map(() => "?").join(", ");
        const sql = `INSERT INTO ${this.table} (${cols.join(", ")}) VALUES (${placeholders})`;
        const bindings = cols.map((k) => _values[k]);
        const exec = this.prepareSource(_db);
        const res = await exec.prepare(sql).bind(...bindings).run();
        this.recordMeta(res.meta as TD1ResultMeta | undefined);
    }

    public async insertOrIgnore(values: Record<string, unknown>): Promise<void>;
    public async insertOrIgnore(db: D1Database, values: Record<string, unknown>): Promise<void>;
    public async insertOrIgnore(dbOrValues: D1Database | Record<string, unknown>, values?: Record<string, unknown>): Promise<void> {
        const _db = this.isD1Database(dbOrValues) ? this.resolveDb(dbOrValues) : this.resolveDb();
        const _values = this.isD1Database(dbOrValues) ? values! : dbOrValues;
        const cols = Object.keys(_values);
        const placeholders = cols.map(() => "?").join(", ");
        const sql = `INSERT OR IGNORE INTO ${this.table} (${cols.join(", ")}) VALUES (${placeholders})`;
        const bindings = cols.map((k) => _values[k]);
        const exec = this.prepareSource(_db);
        const res = await exec.prepare(sql).bind(...bindings).run();
        this.recordMeta(res.meta as TD1ResultMeta | undefined);
    }

    /**
     * Insert a row and return the resulting row via SQLite's `RETURNING` clause
     * (SQLite ≥ 3.35 / D1 supported). Useful when the table has generated
     * columns, defaults, or triggers that compute values you need immediately.
     *
     * @param values Row to insert
     * @param returning Columns to return — defaults to `['*']`. Empty arrays
     *                  throw; pass `['*']` (or omit) to return every column.
     *
     * SECURITY: `returning` is emitted verbatim into SQL. Wrap untrusted
     * column names with `safeIdentList()` before passing.
     *
     * @example
     * const row = await User.query().insertReturning({
     *   id: crypto.randomUUID(), name: 'Alice',
     * });
     * // row.created_at is filled by the default in one round-trip
     */
    public async insertReturning(values: Record<string, unknown>, returning?: string[]): Promise<Record<string, unknown> | null>;
    public async insertReturning(db: D1Database, values: Record<string, unknown>, returning?: string[]): Promise<Record<string, unknown> | null>;
    public async insertReturning(
        dbOrValues: D1Database | Record<string, unknown>,
        valuesOrReturning?: Record<string, unknown> | string[],
        returning?: string[],
    ): Promise<Record<string, unknown> | null> {
        const _db = this.isD1Database(dbOrValues) ? this.resolveDb(dbOrValues) : this.resolveDb();
        const _values = (this.isD1Database(dbOrValues) ? valuesOrReturning : dbOrValues) as Record<string, unknown>;
        const _returning = (this.isD1Database(dbOrValues) ? returning : (valuesOrReturning as string[] | undefined)) ?? ["*"];
        if (_returning.length === 0) {
            throw new Error("insertReturning: `returning` must be a non-empty array or omitted (defaults to ['*']).");
        }
        const cols = Object.keys(_values);
        const placeholders = cols.map(() => "?").join(", ");
        const sql = `INSERT INTO ${this.table} (${cols.join(", ")}) VALUES (${placeholders}) RETURNING ${_returning.join(", ")}`;
        const bindings = cols.map((k) => _values[k]);
        const exec = this.prepareSource(_db);
        const res = await exec.prepare(sql).bind(...bindings).all<Record<string, unknown>>();
        this.recordMeta(res.meta as TD1ResultMeta | undefined);
        return res.results?.[0] ?? null;
    }

    /**
     * Insert or update a single row.
     *
     * Uses `INSERT ... ON CONFLICT(conflictCols) DO UPDATE SET ...`.
     * When `updateCols` is omitted, all non-conflict columns are updated.
     */
    public async upsert(values: Record<string, unknown>, conflictCols: string[], updateCols?: string[]): Promise<void>;
    public async upsert(db: D1Database, values: Record<string, unknown>, conflictCols: string[], updateCols?: string[]): Promise<void>;
    public async upsert(
        dbOrValues: D1Database | Record<string, unknown>,
        valuesOrConflict: Record<string, unknown> | string[],
        conflictOrUpdate?: string[],
        updateCols?: string[],
    ): Promise<void> {
        const _db = this.isD1Database(dbOrValues) ? this.resolveDb(dbOrValues) : this.resolveDb();
        const _values = this.isD1Database(dbOrValues) ? (valuesOrConflict as Record<string, unknown>) : (dbOrValues as Record<string, unknown>);
        const _conflictCols = this.isD1Database(dbOrValues) ? conflictOrUpdate! : (valuesOrConflict as string[]);
        const _updateCols = this.isD1Database(dbOrValues) ? updateCols : conflictOrUpdate;
        const res = await this._buildUpsertPrepared(_db, _values, _conflictCols, _updateCols).run();
        this.recordMeta(res.meta as TD1ResultMeta | undefined);
    }

    /**
     * Batch-insert multiple rows in a single statement.
     *
     * Uses D1's `db.batch()` to execute all inserts in one round-trip.
     */
    public async insertMany(rows: Record<string, unknown>[]): Promise<void>;
    public async insertMany(db: D1Database, rows: Record<string, unknown>[]): Promise<void>;
    public async insertMany(dbOrRows: D1Database | Record<string, unknown>[], rows?: Record<string, unknown>[]): Promise<void> {
        const _db = Array.isArray(dbOrRows) ? this.resolveDb() : this.resolveDb(dbOrRows);
        const _rows = Array.isArray(dbOrRows) ? dbOrRows : rows!;
        await this._batchInsert(_db, _rows, "INSERT");
    }

    /**
     * Batch-insert multiple rows, skipping rows that conflict.
     */
    public async insertOrIgnoreMany(rows: Record<string, unknown>[]): Promise<void>;
    public async insertOrIgnoreMany(db: D1Database, rows: Record<string, unknown>[]): Promise<void>;
    public async insertOrIgnoreMany(dbOrRows: D1Database | Record<string, unknown>[], rows?: Record<string, unknown>[]): Promise<void> {
        const _db = Array.isArray(dbOrRows) ? this.resolveDb() : this.resolveDb(dbOrRows);
        const _rows = Array.isArray(dbOrRows) ? dbOrRows : rows!;
        await this._batchInsert(_db, _rows, "INSERT OR IGNORE");
    }

    /**
     * Batch-upsert multiple rows.
     *
     * Uses `INSERT ... ON CONFLICT(conflictCols) DO UPDATE SET ...` for each row,
     * executed in a single `db.batch()` round-trip.
     * When `updateCols` is omitted, all non-conflict columns are updated.
     */
    public async upsertMany(rows: Record<string, unknown>[], conflictCols: string[], updateCols?: string[]): Promise<void>;
    public async upsertMany(db: D1Database, rows: Record<string, unknown>[], conflictCols: string[], updateCols?: string[]): Promise<void>;
    public async upsertMany(
        dbOrRows: D1Database | Record<string, unknown>[],
        rowsOrConflict: Record<string, unknown>[] | string[],
        conflictOrUpdate?: string[],
        updateCols?: string[],
    ): Promise<void> {
        const _db = this.isD1Database(dbOrRows) ? this.resolveDb(dbOrRows) : this.resolveDb();
        const _rows = this.isD1Database(dbOrRows) ? (rowsOrConflict as Record<string, unknown>[]) : (dbOrRows as Record<string, unknown>[]);
        const _conflictCols = this.isD1Database(dbOrRows) ? conflictOrUpdate! : (rowsOrConflict as string[]);
        const _updateCols = this.isD1Database(dbOrRows) ? updateCols : conflictOrUpdate;

        if (_rows.length === 0) return;
        const stmts = _rows.map((row) => this._buildUpsertPrepared(_db, row, _conflictCols, _updateCols));
        await _db.batch(stmts);
    }

    private async _batchInsert(db: D1Database, rows: Record<string, unknown>[], verb: string): Promise<void> {
        if (rows.length === 0) return;
        const cols = Object.keys(rows[0]);
        const placeholders = cols.map(() => "?").join(", ");
        const sql = `${verb} INTO ${this.table} (${cols.join(", ")}) VALUES (${placeholders})`;
        const stmts = rows.map((row) => {
            const bindings = cols.map((k) => row[k]);
            return db.prepare(sql).bind(...bindings);
        });
        await db.batch(stmts);
    }

    public async update(values: Record<string, unknown>): Promise<number>;
    public async update(db: D1Database, values: Record<string, unknown>): Promise<number>;
    public async update(dbOrValues: D1Database | Record<string, unknown>, values?: Record<string, unknown>): Promise<number> {
        const _db = this.isD1Database(dbOrValues) ? this.resolveDb(dbOrValues) : this.resolveDb();
        const _values = this.isD1Database(dbOrValues) ? values! : dbOrValues;
        const cols = Object.keys(_values);
        if (cols.length === 0) return 0;

        const setSql = cols.map((c) => `${c} = ?`).join(", ");
        const bindings = cols.map((k) => _values[k]);

        let sql = `UPDATE ${this.table} SET ${setSql}`;

        const whereResult = this.compileWhereFragment();
        if (whereResult) {
            sql += whereResult.sql;
            bindings.push(...whereResult.bindings);
        }

        const exec = this.prepareSource(_db);
        const res = await exec.prepare(sql).bind(...bindings).run();
        this.recordMeta(res.meta as TD1ResultMeta | undefined);
        // D1 returns changes in meta (best-effort)
        return res.meta?.changes ?? 0;
    }

    /**
     * Atomically increment a numeric column for every row matching the query:
     * `UPDATE <table> SET <column> = <column> + ? [, <extra> = ?] WHERE ...`.
     * `amount` defaults to 1; `extra` sets additional columns in the same UPDATE
     * (e.g. a timestamp). The column name is emitted verbatim — wrap untrusted
     * input with `safeIdent()`. Returns the affected row count.
     *
     * @example
     * await Post.query().whereEq('id', id).increment('views')
     * await Post.query().whereEq('id', id).increment('views', 10, { last_viewed_at: now })
     */
    public async increment(column: string, amount?: number, extra?: Record<string, unknown>): Promise<number>;
    public async increment(column: string, extra: Record<string, unknown>): Promise<number>;
    public async increment(db: D1Database, column: string, amount?: number, extra?: Record<string, unknown>): Promise<number>;
    public async increment(db: D1Database, column: string, extra: Record<string, unknown>): Promise<number>;
    public async increment(
        dbOrColumn: D1Database | string,
        columnOrAmount?: string | number | Record<string, unknown>,
        amountOrExtra?: number | Record<string, unknown>,
        extra?: Record<string, unknown>,
    ): Promise<number> {
        return this.stepColumn("+", dbOrColumn, columnOrAmount, amountOrExtra, extra);
    }

    /**
     * Atomically decrement a numeric column for every row matching the query.
     * Mirror of {@link increment}: `SET <column> = <column> - ?`.
     *
     * @example
     * await Product.query().whereEq('id', id).decrement('stock', qty)
     */
    public async decrement(column: string, amount?: number, extra?: Record<string, unknown>): Promise<number>;
    public async decrement(column: string, extra: Record<string, unknown>): Promise<number>;
    public async decrement(db: D1Database, column: string, amount?: number, extra?: Record<string, unknown>): Promise<number>;
    public async decrement(db: D1Database, column: string, extra: Record<string, unknown>): Promise<number>;
    public async decrement(
        dbOrColumn: D1Database | string,
        columnOrAmount?: string | number | Record<string, unknown>,
        amountOrExtra?: number | Record<string, unknown>,
        extra?: Record<string, unknown>,
    ): Promise<number> {
        return this.stepColumn("-", dbOrColumn, columnOrAmount, amountOrExtra, extra);
    }

    /** Shared compiler for increment()/decrement(): `SET col = col ± ? [, extra…]`. */
    private async stepColumn(
        op: "+" | "-",
        dbOrColumn: D1Database | string,
        columnOrAmount?: string | number | Record<string, unknown>,
        amountOrExtra?: number | Record<string, unknown>,
        extra?: Record<string, unknown>,
    ): Promise<number> {
        const hasDb = this.isD1Database(dbOrColumn);
        const _db = hasDb ? this.resolveDb(dbOrColumn as D1Database) : this.resolveDb();
        const column = (hasDb ? columnOrAmount : dbOrColumn) as string;
        const amountArg = hasDb ? amountOrExtra : columnOrAmount;
        // Forgiving parse: amount is a number (default 1); an object in the amount
        // slot is treated as `extra` (i.e. increment(col, { … }) shorthand).
        const amount = typeof amountArg === "number" ? amountArg : 1;
        const extraCols = (
            typeof amountArg === "object" && amountArg !== null ? amountArg : hasDb ? extra : amountOrExtra
        ) as Record<string, unknown> | undefined;

        const res = await this._buildStepStatement(op, _db, column, amount, extraCols).run();
        this.recordMeta(res.meta as TD1ResultMeta | undefined);
        return res.meta?.changes ?? 0;
    }

    /**
     * @internal Build (but do NOT run) the atomic step UPDATE shared by
     * increment()/decrement() and the prepared/transaction paths. Carries the
     * hardened semantics: COALESCE the target to 0 (NULL counter behaves as 0),
     * dehydrate `extra` values through the model's casts (so a Date binds as ISO),
     * and include the compiled WHERE (incl. soft-delete scope). `db` is already
     * resolved by the caller.
     */
    private _buildStepStatement(
        op: "+" | "-",
        db: D1Database,
        column: string,
        amount: number,
        extra?: Record<string, unknown>,
    ): D1PreparedStatement {
        const sets = [`${column} = COALESCE(${column}, 0) ${op} ?`];
        const bindings: unknown[] = [amount];
        const castMap = this.resolveWhereCastMap();
        for (const [k, v] of Object.entries(extra ?? {})) {
            sets.push(`${k} = ?`);
            const cast = castMap[k];
            bindings.push(cast ? CastManager.castSet(cast, v) : v);
        }
        let sql = `UPDATE ${this.table} SET ${sets.join(", ")}`;
        const whereResult = this.compileWhereFragment();
        if (whereResult) {
            sql += whereResult.sql;
            bindings.push(...whereResult.bindings);
        }
        return this.prepareSource(db).prepare(sql).bind(...bindings);
    }

    /**
     * Prepared form of {@link increment} - returns the UPDATE statement without
     * running it, so it can compose inside a `transaction()` batch (see `tx.increment`).
     * Shares increment()'s hardened COALESCE + cast-dehydration + WHERE semantics.
     */
    public toIncrementPrepared(db: D1Database, column: string, amount = 1, extra?: Record<string, unknown>): D1PreparedStatement {
        return this._buildStepStatement("+", this.resolveDb(db), column, amount, extra);
    }

    /** Prepared form of {@link decrement}. See {@link toIncrementPrepared}. */
    public toDecrementPrepared(db: D1Database, column: string, amount = 1, extra?: Record<string, unknown>): D1PreparedStatement {
        return this._buildStepStatement("-", this.resolveDb(db), column, amount, extra);
    }

    /**
     * Update a JSON column in place via SQLite's `json_set()` — sets the value
     * at `path` without rewriting the whole document. Path is parameter-bound;
     * `col` is emitted verbatim, so wrap untrusted column names with
     * `safeIdent()` first.
     *
     * Returns the affected row count.
     *
     * @example
     * await User.query().whereEq('id', uid).updateJsonSet('settings', '$.role', 'admin')
     * // UPDATE users SET settings = json_set(settings, ?, ?) WHERE id = ?
     */
    public async updateJsonSet(col: string, path: string, value: unknown): Promise<number>;
    public async updateJsonSet(db: D1Database, col: string, path: string, value: unknown): Promise<number>;
    public async updateJsonSet(
        dbOrCol: D1Database | string,
        colOrPath: string,
        pathOrValue: string | unknown,
        value?: unknown,
    ): Promise<number> {
        const isDb = this.isD1Database(dbOrCol);
        const _db = isDb ? this.resolveDb(dbOrCol) : this.resolveDb();
        const _col = isDb ? colOrPath : (dbOrCol as string);
        const _path = isDb ? (pathOrValue as string) : (colOrPath as string);
        const _value = isDb ? value : pathOrValue;

        const res = await this.toUpdateJsonSetPrepared(_db, _col, _path, _value).run();
        this.recordMeta(res.meta as TD1ResultMeta | undefined);
        return res.meta?.changes ?? 0;
    }

    /**
     * Build the `json_set()` UPDATE as a `D1PreparedStatement` without running
     * it — for use in `db.batch()` / transactions. Same SQL as `updateJsonSet`.
     */
    public toUpdateJsonSetPrepared(db: D1Database, col: string, path: string, value: unknown): D1PreparedStatement {
        let sql = `UPDATE ${this.table} SET ${col} = json_set(${col}, ?, ?)`;
        const bindings: unknown[] = [path, value];

        const whereResult = this.compileWhereFragment();
        if (whereResult) {
            sql += whereResult.sql;
            bindings.push(...whereResult.bindings);
        }

        return this.prepareSource(this.resolveDb(db)).prepare(sql).bind(...bindings);
    }

    /**
     * Merge a JSON patch into a JSON column via SQLite's `json_patch()` —
     * RFC 7396 merge semantics (nulls in patch delete keys; nested objects
     * merge deeply; arrays are replaced wholesale).
     *
     * @example
     * await User.query().whereEq('id', uid)
     *   .updateJsonPatch('settings', { theme: 'dark', notifications: { email: true } })
     */
    public async updateJsonPatch(col: string, patch: Record<string, unknown>): Promise<number>;
    public async updateJsonPatch(db: D1Database, col: string, patch: Record<string, unknown>): Promise<number>;
    public async updateJsonPatch(
        dbOrCol: D1Database | string,
        colOrPatch: string | Record<string, unknown>,
        patch?: Record<string, unknown>,
    ): Promise<number> {
        const isDb = this.isD1Database(dbOrCol);
        const _db = isDb ? this.resolveDb(dbOrCol) : this.resolveDb();
        const _col = isDb ? (colOrPatch as string) : (dbOrCol as string);
        const _patch = isDb ? patch! : (colOrPatch as Record<string, unknown>);

        const res = await this.toUpdateJsonPatchPrepared(_db, _col, _patch).run();
        this.recordMeta(res.meta as TD1ResultMeta | undefined);
        return res.meta?.changes ?? 0;
    }

    /**
     * Build the `json_patch()` UPDATE as a `D1PreparedStatement` without
     * running it — for use in `db.batch()` / transactions. Same SQL as
     * `updateJsonPatch`.
     */
    public toUpdateJsonPatchPrepared(db: D1Database, col: string, patch: Record<string, unknown>): D1PreparedStatement {
        let sql = `UPDATE ${this.table} SET ${col} = json_patch(${col}, ?)`;
        const bindings: unknown[] = [JSON.stringify(patch)];

        const whereResult = this.compileWhereFragment();
        if (whereResult) {
            sql += whereResult.sql;
            bindings.push(...whereResult.bindings);
        }

        return this.prepareSource(this.resolveDb(db)).prepare(sql).bind(...bindings);
    }

    /**
     * Remove one or more paths from a JSON column via SQLite's `json_remove()`.
     * Pass a single path or an array of paths.
     *
     * @example
     * await User.query().whereEq('id', uid).updateJsonRemove('settings', '$.legacy_field')
     * await Post.query().whereEq('id', pid).updateJsonRemove('metadata', ['$.draft', '$.tmp'])
     */
    public async updateJsonRemove(col: string, path: string | string[]): Promise<number>;
    public async updateJsonRemove(db: D1Database, col: string, path: string | string[]): Promise<number>;
    public async updateJsonRemove(
        dbOrCol: D1Database | string,
        colOrPath: string | string[],
        path?: string | string[],
    ): Promise<number> {
        const isDb = this.isD1Database(dbOrCol);
        const _db = isDb ? this.resolveDb(dbOrCol) : this.resolveDb();
        const _col = isDb ? (colOrPath as string) : (dbOrCol as string);
        const _paths = isDb ? path! : (colOrPath as string | string[]);

        const pathsArr = Array.isArray(_paths) ? _paths : [_paths];
        if (pathsArr.length === 0) return 0;

        const res = await this.toUpdateJsonRemovePrepared(_db, _col, pathsArr).run();
        this.recordMeta(res.meta as TD1ResultMeta | undefined);
        return res.meta?.changes ?? 0;
    }

    /**
     * Build the `json_remove()` UPDATE as a `D1PreparedStatement` without
     * running it — for use in `db.batch()` / transactions. Same SQL as
     * `updateJsonRemove`. Throws when `path` resolves to zero paths (there is
     * no valid statement to build).
     */
    public toUpdateJsonRemovePrepared(db: D1Database, col: string, path: string | string[]): D1PreparedStatement {
        const pathsArr = Array.isArray(path) ? path : [path];
        if (pathsArr.length === 0) {
            throw new Error("toUpdateJsonRemovePrepared: at least one JSON path is required.");
        }

        const placeholders = pathsArr.map(() => "?").join(", ");
        let sql = `UPDATE ${this.table} SET ${col} = json_remove(${col}, ${placeholders})`;
        const bindings: unknown[] = [...pathsArr];

        const whereResult = this.compileWhereFragment();
        if (whereResult) {
            sql += whereResult.sql;
            bindings.push(...whereResult.bindings);
        }

        return this.prepareSource(this.resolveDb(db)).prepare(sql).bind(...bindings);
    }

    /**
     * Update rows and return the affected rows via SQLite's `RETURNING` clause.
     *
     * SECURITY: `returning` is emitted verbatim into SQL. Wrap untrusted
     * column names with `safeIdentList()` before passing.
     *
     * @example
     * const updated = await User.query()
     *   .whereEq('id', userId)
     *   .updateReturning({ updated_at: new Date().toISOString() });
     * // updated: full rows post-update, including server-computed columns
     */
    public async updateReturning(values: Record<string, unknown>, returning?: string[]): Promise<Record<string, unknown>[]>;
    public async updateReturning(db: D1Database, values: Record<string, unknown>, returning?: string[]): Promise<Record<string, unknown>[]>;
    public async updateReturning(
        dbOrValues: D1Database | Record<string, unknown>,
        valuesOrReturning?: Record<string, unknown> | string[],
        returning?: string[],
    ): Promise<Record<string, unknown>[]> {
        const _db = this.isD1Database(dbOrValues) ? this.resolveDb(dbOrValues) : this.resolveDb();
        const _values = (this.isD1Database(dbOrValues) ? valuesOrReturning : dbOrValues) as Record<string, unknown>;
        const _returning = (this.isD1Database(dbOrValues) ? returning : (valuesOrReturning as string[] | undefined)) ?? ["*"];
        if (_returning.length === 0) {
            throw new Error("updateReturning: `returning` must be a non-empty array or omitted (defaults to ['*']).");
        }

        const cols = Object.keys(_values);
        if (cols.length === 0) return [];

        const setSql = cols.map((c) => `${c} = ?`).join(", ");
        const bindings = cols.map((k) => _values[k]);

        let sql = `UPDATE ${this.table} SET ${setSql}`;
        const whereResult = this.compileWhereFragment();
        if (whereResult) {
            sql += whereResult.sql;
            bindings.push(...whereResult.bindings);
        }
        sql += ` RETURNING ${_returning.join(", ")}`;

        const exec = this.prepareSource(_db);
        const res = await exec.prepare(sql).bind(...bindings).all<Record<string, unknown>>();
        this.recordMeta(res.meta as TD1ResultMeta | undefined);
        return res.results ?? [];
    }

    public async delete(db?: D1Database): Promise<number> {
        const _db = this.resolveDb(db);
        let sql = `DELETE FROM ${this.table}`;
        const bindings: unknown[] = [];

        const whereResult = this.compileWhereFragment();
        if (whereResult) {
            sql += whereResult.sql;
            bindings.push(...whereResult.bindings);
        }

        const exec = this.prepareSource(_db);
        const res = await exec.prepare(sql).bind(...bindings).run();
        this.recordMeta(res.meta as TD1ResultMeta | undefined);
        return res.meta?.changes ?? 0;
    }

    /**
     * Delete rows and return the deleted rows via SQLite's `RETURNING` clause.
     *
     * SECURITY: `returning` is emitted verbatim into SQL. Wrap untrusted
     * column names with `safeIdentList()` before passing.
     *
     * @example
     * const removed = await User.query()
     *   .whereEq('id', userId)
     *   .deleteReturning(['id', 'email']);
     */
    public async deleteReturning(returning?: string[]): Promise<Record<string, unknown>[]>;
    public async deleteReturning(db: D1Database, returning?: string[]): Promise<Record<string, unknown>[]>;
    public async deleteReturning(
        dbOrReturning?: D1Database | string[],
        returning?: string[],
    ): Promise<Record<string, unknown>[]> {
        const _db = this.isD1Database(dbOrReturning)
            ? this.resolveDb(dbOrReturning)
            : this.resolveDb();
        const _returning = (this.isD1Database(dbOrReturning) ? returning : (dbOrReturning as string[] | undefined)) ?? ["*"];
        if (_returning.length === 0) {
            throw new Error("deleteReturning: `returning` must be a non-empty array or omitted (defaults to ['*']).");
        }

        let sql = `DELETE FROM ${this.table}`;
        const bindings: unknown[] = [];

        const whereResult = this.compileWhereFragment();
        if (whereResult) {
            sql += whereResult.sql;
            bindings.push(...whereResult.bindings);
        }
        sql += ` RETURNING ${_returning.join(", ")}`;

        const exec = this.prepareSource(_db);
        const res = await exec.prepare(sql).bind(...bindings).all<Record<string, unknown>>();
        this.recordMeta(res.meta as TD1ResultMeta | undefined);
        return res.results ?? [];
    }

    public withTrashed(): this {
        this.includeTrashed = true;
        this.onlyTrashedRows = false;
        return this;
    }

    public onlyTrashed(): this {
        this.includeTrashed = true;
        this.onlyTrashedRows = true;
        return this;
    }

    /**
     * Skip a named `static globalScopes` entry for this query only.
     *
     * @example
     * Tenant.query().withoutGlobalScope('current_tenant').get(db)
     */
    public withoutGlobalScope(name: string): this {
        this.skippedGlobalScopes.add(name);
        return this;
    }

    /** Skip ALL of the model's `static globalScopes` for this query only. */
    public withoutGlobalScopes(): this {
        this.skipAllGlobalScopes = true;
        return this;
    }
}

/**
 * A query compiled once via `QueryBuilder.prepare()`. Executes the same SQL
 * repeatedly with different `placeholder()` values — no rebuild per call.
 */
export class PreparedQuery<TModel extends { toObject(): object }> {
    constructor(
        private readonly modelCtor: TModelCtor<TModel>,
        private readonly sql: string,
        private readonly bindings: readonly unknown[],
        private readonly db: D1Database,
        private readonly eagerLoaders: Map<string, TEagerLoader<TModel>> = new Map(),
        private readonly eagerConstraints: Map<string, TEagerConstraint> = new Map(),
    ) {}

    private resolveBindings(params: Record<string, unknown>): unknown[] {
        return this.bindings.map((b) => {
            if (b instanceof Placeholder) {
                if (!Object.prototype.hasOwnProperty.call(params, b.name)) {
                    throw new Error(`Missing value for placeholder '${b.name}'`);
                }
                return params[b.name];
            }
            return b;
        });
    }

    private hydrate(row: Record<string, unknown>): TModel {
        const model = new this.modelCtor(row as Partial<TModelAttrsOf<TModel>>);
        (model as unknown as { _persisted: boolean })._persisted = true;
        const asProxy = (model as unknown as { asProxy?: () => unknown }).asProxy;
        return typeof asProxy === "function" ? (asProxy.call(model) as TModel) : model;
    }

    /** Run the carried-over eager loaders (`.with()`) against the hydrated models. */
    private async loadEager(models: Collection<TModel>, db: D1Database): Promise<void> {
        // Independent sibling loaders - run concurrently (see get()).
        await Promise.all(
            Array.from(this.eagerLoaders, ([rel, loader]) => loader(db, models, this.eagerConstraints.get(rel))),
        );
    }

    /** Execute with the given placeholder params and return raw rows. */
    public async all(params: Record<string, unknown> = {}, db?: D1Database): Promise<Record<string, unknown>[]> {
        const _db = db ?? this.db;
        const res = await _db.prepare(this.sql).bind(...this.resolveBindings(params)).all<Record<string, unknown>>();
        return res.results ?? [];
    }

    /** Execute and return hydrated, proxy-wrapped models — with eager relations loaded. */
    public async get(params: Record<string, unknown> = {}, db?: D1Database): Promise<Collection<TModel>> {
        const _db = db ?? this.db;
        const rows = await this.all(params, _db);
        const models = Collection.from(rows.map((row) => this.hydrate(row)));
        await this.loadEager(models, _db);
        return models;
    }

    /** Execute and return the first hydrated model, or `null` — eager relations loaded. */
    public async first(params: Record<string, unknown> = {}, db?: D1Database): Promise<TModel | null> {
        const _db = db ?? this.db;
        // Push LIMIT 1 into the DB rather than fetching every match and slicing.
        // Wrap as a subquery so an inner LIMIT/ORDER/compound (UNION) stays intact.
        const sql = `SELECT * FROM (${this.sql}) LIMIT 1`;
        const res = await _db.prepare(sql).bind(...this.resolveBindings(params)).all<Record<string, unknown>>();
        const row = (res.results ?? [])[0];
        if (!row) return null;
        const model = this.hydrate(row);
        if (this.eagerLoaders.size > 0) await this.loadEager(Collection.from([model]), _db);
        return model;
    }
}
