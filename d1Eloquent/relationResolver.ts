import type { TModelCtor } from "./types";
import type {
    TRelationDefinition,
    TBelongsToDefinition,
    THasManyDefinition,
    THasOneDefinition,
    TBelongsToManyDefinition,
    THasManyThroughDefinition,
    THasOneThroughDefinition,
    TMorphToDefinition,
    TMorphManyDefinition,
    TMorphOneDefinition,
    TMorphToManyDefinition,
    TMorphedByManyDefinition,
} from "./relationTypes";
import { QueryBuilder } from "./queryBuilder";
import type { TEagerConstraint } from "./queryBuilder";
import type { TPivotMethods, TPivotSyncResult, TRelationship } from "./relationships";
import { resolveDb as registryResolveDb } from "./registry";

/** Compute the morph columns for a `morphTo` / `morphMany` / `morphOne` definition. */
function morphCols(def: { morphName: string; typeColumn?: string; idColumn?: string }): {
    typeCol: string;
    idCol: string;
} {
    return {
        typeCol: def.typeColumn ?? `${def.morphName}_type`,
        idCol: def.idColumn ?? `${def.morphName}_id`,
    };
}

/** Structural type for model instances within eager loading — narrows `any` in Maps. */
interface EagerModel {
    get(key: string): unknown;
    setRelation(name: string, value: unknown): unknown;
}

// ── Resolve a relation definition into a TRelationship ─────────────────

/**
 * Given a relation definition and the parent model's primary key value,
 * returns a TRelationship with query/get/first — same shape as the legacy
 * belongsTo/hasMany/hasOne/belongsToMany helpers.
 *
 * For `morphTo`, the parent instance is passed via `parentModel` so the
 * type-discriminator column can be read to pick the related model class.
 */
export function resolveRelation(
    def: TRelationDefinition,
    parentCtor: TModelCtor<any>,
    localValue: unknown,
    parentModel?: { get(key: string): unknown },
): TRelationship<any> {
    switch (def.type) {
        case "belongsTo":
            return resolveBelongsTo(def, localValue);
        case "hasMany":
            return resolveHasMany(def, localValue);
        case "hasOne":
            return resolveHasOne(def, localValue);
        case "belongsToMany":
            return resolveBelongsToMany(def, localValue);
        case "hasManyThrough":
        case "hasOneThrough":
            return resolveHasManyThrough(def, localValue);
        case "morphTo":
            return resolveMorphTo(def, parentModel);
        case "morphMany":
        case "morphOne":
            return resolveMorphMany(def, parentCtor, localValue);
        case "morphToMany":
            return resolveMorphToMany(def, parentCtor, localValue);
        case "morphedByMany":
            return resolveMorphedByMany(def, parentCtor, localValue);
    }
}

/**
 * Build pivot-management helpers (`attach` / `detach` / `sync` / `toggle`) for
 * pivot-backed relations. The four params describe the pivot row shape:
 *
 *   pivotTable        — pivot table name (e.g. `'user_roles'`)
 *   localCol          — pivot column holding the parent's PK (e.g. `'user_id'`)
 *   localValue        — the parent's PK value (concrete, captured at resolve time)
 *   relatedCol        — pivot column holding the related model's PK (e.g. `'role_id'`)
 *   fixedExtras       — extra columns that must always be set on every pivot row
 *                       (used by morph relations to bake in `<morph>_type`)
 */
function buildPivotMethods(args: {
    pivotTable: string;
    localCol: string;
    localValue: unknown;
    relatedCol: string;
    fixedExtras?: Record<string, unknown>;
}): TPivotMethods {
    const { pivotTable, localCol, localValue, relatedCol, fixedExtras = {} } = args;
    const fixedKeys = Object.keys(fixedExtras);

    const resolveExecDb = (db?: D1Database): D1Database => registryResolveDb(db, undefined);

    const toArray = (ids: string | number | (string | number)[]): (string | number)[] =>
        Array.isArray(ids) ? ids : [ids];

    const baseWhere = () => {
        let sql = `WHERE ${localCol} = ?`;
        const bindings: unknown[] = [localValue];
        for (const k of fixedKeys) {
            sql += ` AND ${k} = ?`;
            bindings.push(fixedExtras[k]);
        }
        return { sql, bindings };
    };

    return {
        async attach(ids, opts) {
            const list = toArray(ids);
            if (list.length === 0) return 0;
            const db = resolveExecDb(opts?.db);
            const extras = { ...fixedExtras, ...(opts?.extras ?? {}) };
            const extraKeys = Object.keys(extras);
            const cols = [localCol, relatedCol, ...extraKeys];
            const placeholders = cols.map(() => "?").join(", ");
            const sql = `INSERT OR IGNORE INTO ${pivotTable} (${cols.join(", ")}) VALUES (${placeholders})`;
            const stmts = list.map((id) =>
                db
                    .prepare(sql)
                    .bind(localValue, id, ...extraKeys.map((k) => extras[k])),
            );
            const results = await db.batch(stmts);
            return results.reduce(
                (acc, r: unknown) => acc + ((r as { meta?: { changes?: number } }).meta?.changes ?? 0),
                0,
            );
        },

        async detach(ids, opts) {
            const db = resolveExecDb(opts?.db);
            if (ids === undefined) {
                const { sql, bindings } = baseWhere();
                const res = await db
                    .prepare(`DELETE FROM ${pivotTable} ${sql}`)
                    .bind(...bindings)
                    .run();
                return res.meta?.changes ?? 0;
            }
            const list = toArray(ids);
            if (list.length === 0) return 0;
            const { sql, bindings } = baseWhere();
            const placeholders = list.map(() => "?").join(", ");
            const res = await db
                .prepare(
                    `DELETE FROM ${pivotTable} ${sql} AND ${relatedCol} IN (${placeholders})`,
                )
                .bind(...bindings, ...list)
                .run();
            return res.meta?.changes ?? 0;
        },

        async sync(ids, opts): Promise<TPivotSyncResult> {
            const db = resolveExecDb(opts?.db);
            const target = new Set(ids.map(String));

            // Fetch current set
            const { sql: whereSql, bindings: whereBindings } = baseWhere();
            const cur = await db
                .prepare(`SELECT ${relatedCol} FROM ${pivotTable} ${whereSql}`)
                .bind(...whereBindings)
                .all<Record<string, unknown>>();
            const current = new Set((cur.results ?? []).map((r) => String(r[relatedCol])));

            const toAttach: (string | number)[] = [];
            const toDetach: (string | number)[] = [];
            for (const id of ids) if (!current.has(String(id))) toAttach.push(id);
            for (const id of current) if (!target.has(id)) toDetach.push(id);

            const attached: string[] = [];
            const detached: string[] = [];

            if (toAttach.length) {
                await this.attach!(toAttach, { extras: opts?.extras, db: opts?.db });
                for (const id of toAttach) attached.push(String(id));
            }
            if (toDetach.length) {
                await this.detach!(toDetach, { db: opts?.db });
                for (const id of toDetach) detached.push(String(id));
            }
            return { attached, detached };
        },

        async toggle(ids, opts): Promise<TPivotSyncResult> {
            const db = resolveExecDb(opts?.db);
            const list = toArray(ids);
            if (list.length === 0) return { attached: [], detached: [] };

            const { sql: whereSql, bindings: whereBindings } = baseWhere();
            const placeholders = list.map(() => "?").join(", ");
            const cur = await db
                .prepare(
                    `SELECT ${relatedCol} FROM ${pivotTable} ${whereSql} AND ${relatedCol} IN (${placeholders})`,
                )
                .bind(...whereBindings, ...list)
                .all<Record<string, unknown>>();
            const present = new Set((cur.results ?? []).map((r) => String(r[relatedCol])));

            const toAttach: (string | number)[] = [];
            const toDetach: (string | number)[] = [];
            for (const id of list) {
                if (present.has(String(id))) toDetach.push(id);
                else toAttach.push(id);
            }

            const attached: string[] = [];
            const detached: string[] = [];
            if (toAttach.length) {
                await this.attach!(toAttach, { extras: opts?.extras, db: opts?.db });
                for (const id of toAttach) attached.push(String(id));
            }
            if (toDetach.length) {
                await this.detach!(toDetach, { db: opts?.db });
                for (const id of toDetach) detached.push(String(id));
            }
            return { attached, detached };
        },
    };
}

function resolveMorphToMany(
    def: TMorphToManyDefinition,
    parentCtor: TModelCtor<any>,
    localValue: unknown,
): TRelationship<any> {
    const relatedCtor = def.model();
    const relatedKey = def.relatedKey ?? relatedCtor.primaryKey;
    const { typeCol, idCol } = morphCols(def);
    const on = `${def.pivot}.${def.relatedPivotKey} = ${relatedCtor.table}.${relatedKey}`;

    const query = new QueryBuilder(relatedCtor)
        .select([`${relatedCtor.table}.*`])
        .join(def.pivot, on)
        .whereEq(`${def.pivot}.${typeCol}`, def.typeValue)
        .whereEq(`${def.pivot}.${idCol}`, localValue);

    const pivot = buildPivotMethods({
        pivotTable: def.pivot,
        localCol: idCol,
        localValue,
        relatedCol: def.relatedPivotKey,
        fixedExtras: { [typeCol]: def.typeValue },
    });

    return {
        query,
        get: (db) => query.get(db),
        first: (db) => query.first(db),
        ...pivot,
    };
}

function resolveMorphedByMany(
    def: TMorphedByManyDefinition,
    parentCtor: TModelCtor<any>,
    localValue: unknown,
): TRelationship<any> {
    // Inverse direction: from the related-side (e.g. Tag) we look up parents
    // (e.g. Post) of a specific type via the same pivot table.
    const ownerCtor = def.model();
    const ownerKey = def.relatedKey ?? ownerCtor.primaryKey;
    const { typeCol, idCol } = morphCols(def);
    const on = `${def.pivot}.${idCol} = ${ownerCtor.table}.${ownerKey}`;

    const query = new QueryBuilder(ownerCtor)
        .select([`${ownerCtor.table}.*`])
        .join(def.pivot, on)
        .whereEq(`${def.pivot}.${typeCol}`, def.typeValue)
        .whereEq(`${def.pivot}.${def.relatedPivotKey}`, localValue);

    // Inverse pivot ops — `attach(parentId)` inserts a pivot row pointing
    // FROM this related-side TO the parent. The local column on the pivot
    // is the related-pivot column; the "related" column is the morph idCol.
    const pivot = buildPivotMethods({
        pivotTable: def.pivot,
        localCol: def.relatedPivotKey,
        localValue,
        relatedCol: idCol,
        fixedExtras: { [typeCol]: def.typeValue },
    });

    return {
        query,
        get: (db) => query.get(db),
        first: (db) => query.first(db),
        ...pivot,
    };
}

function resolveBelongsTo(def: TBelongsToDefinition, localValue: unknown): TRelationship<any> {
    const relatedCtor = def.model();
    const ownerKey = def.ownerKey ?? relatedCtor.primaryKey;
    const query = new QueryBuilder(relatedCtor).whereEq(ownerKey, localValue);
    return { query, get: (db) => query.get(db), first: (db) => query.first(db) };
}

function resolveHasMany(def: THasManyDefinition, localValue: unknown): TRelationship<any> {
    const relatedCtor = def.model();
    const query = new QueryBuilder(relatedCtor).whereEq(def.foreignKey, localValue);
    return { query, get: (db) => query.get(db), first: (db) => query.first(db) };
}

function resolveHasOne(def: THasOneDefinition, localValue: unknown): TRelationship<any> {
    const relatedCtor = def.model();
    const query = new QueryBuilder(relatedCtor).whereEq(def.foreignKey, localValue);
    return { query, get: (db) => query.get(db), first: (db) => query.first(db) };
}

function resolveBelongsToMany(def: TBelongsToManyDefinition, localValue: unknown): TRelationship<any> {
    const relatedCtor = def.model();
    const relatedKey = def.relatedKey ?? relatedCtor.primaryKey;
    const on = `${def.pivot}.${def.relatedPivotKey} = ${relatedCtor.table}.${relatedKey}`;
    const query = new QueryBuilder(relatedCtor)
        .select([`${relatedCtor.table}.*`])
        .join(def.pivot, on)
        .whereEq(`${def.pivot}.${def.foreignPivotKey}`, localValue);

    const pivot = buildPivotMethods({
        pivotTable: def.pivot,
        localCol: def.foreignPivotKey,
        localValue,
        relatedCol: def.relatedPivotKey,
    });

    return {
        query,
        get: (db) => query.get(db),
        first: (db) => query.first(db),
        ...pivot,
    };
}

function resolveMorphTo(
    def: TMorphToDefinition,
    parentModel?: { get(key: string): unknown },
): TRelationship<any> {
    if (!parentModel) {
        throw new Error(
            `morphTo '${def.morphName}': cannot resolve without parent model instance. ` +
                `Use model.related('${def.morphName}') instead of static helpers.`,
        );
    }
    const { typeCol, idCol } = morphCols(def);
    const typeValue = parentModel.get(typeCol) as string | null | undefined;
    const idValue = parentModel.get(idCol);

    // No type or id → empty relationship that returns null
    if (typeValue == null || idValue == null) {
        const empty = new QueryBuilder({ table: "__morph_empty__", primaryKey: "id" } as any);
        return { query: empty, get: async () => [] as any, first: async () => null };
    }

    const factory = def.morphMap[typeValue];
    if (!factory) {
        throw new Error(
            `morphTo '${def.morphName}': unknown type '${typeValue}'. Add it to morphMap.`,
        );
    }
    const relatedCtor = factory();
    const query = new QueryBuilder(relatedCtor).whereEq(relatedCtor.primaryKey, idValue);
    return { query, get: (db) => query.get(db), first: (db) => query.first(db) };
}

function resolveMorphMany(
    def: TMorphManyDefinition | TMorphOneDefinition,
    parentCtor: TModelCtor<any>,
    localValue: unknown,
): TRelationship<any> {
    const relatedCtor = def.model();
    const { typeCol, idCol } = morphCols(def);
    const query = new QueryBuilder(relatedCtor)
        .whereEq(typeCol, def.typeValue)
        .whereEq(idCol, localValue);
    if (def.type === "morphOne") query.limit(1);
    return { query, get: (db) => query.get(db), first: (db) => query.first(db) };
}

// ── Eager-load batching ────────────────────────────────────────────────

/**
 * Cloudflare D1 caps a single statement at 100 bound parameters. Eager loaders
 * pass every parent key into one `whereIn(...)`, so loading more than ~100
 * parents would otherwise throw "too many SQL variables". Batch parent keys
 * under this limit (leaving headroom for any other bound params in the query).
 *
 * @internal exported for testing.
 */
export const EAGER_WHERE_IN_CHUNK = 90;

/** Split an array into chunks of at most `size`. @internal exported for testing. */
export function chunkKeys<T>(keys: T[], size: number = EAGER_WHERE_IN_CHUNK): T[][] {
    if (keys.length <= size) return [keys];
    const out: T[][] = [];
    for (let i = 0; i < keys.length; i += size) out.push(keys.slice(i, i + size));
    return out;
}

/**
 * Run `build(chunk)` once per batch of keys and concatenate the rows, so an
 * eager load over many parents never exceeds D1's bound-parameter cap. For
 * key counts at or below the chunk size this issues exactly one query, matching
 * the previous behaviour.
 */
async function getInChunks(
    db: D1Database,
    keys: unknown[],
    build: (chunk: unknown[]) => QueryBuilder<any>,
    constraint?: TEagerConstraint,
): Promise<EagerModel[]> {
    const out: EagerModel[] = [];
    for (const chunk of chunkKeys(keys)) {
        const rows = await withEagerConstraint(build(chunk), constraint).get(db);
        for (const r of rows) out.push(r as EagerModel);
    }
    return out;
}

// ── Auto-derive eager loaders from static relations ────────────────────

/** Loader signature — accepts an optional per-relation constrained-eager-load callback. */
type EagerLoaderFn = (db: D1Database, models: any[], constraint?: TEagerConstraint) => Promise<void>;

/** Apply a constrained-eager-load callback to a batch query builder (if present). */
function withEagerConstraint<Q extends QueryBuilder<any>>(q: Q, constraint?: TEagerConstraint): Q {
    if (constraint) q.applyEagerConstraint(constraint as (q: QueryBuilder<any, any>) => unknown);
    return q;
}

/**
 * Build eager loader functions from a model's `static relations` metadata.
 * Each loader performs a batch fetch (whereIn) for all parent models,
 * then distributes results to each model via setRelation().
 */
// ── has-many-through / has-one-through ──────────────────────────────────

function resolveHasManyThrough(
    def: THasManyThroughDefinition | THasOneThroughDefinition,
    localValue: unknown,
): TRelationship<any> {
    const relatedCtor = def.model();
    const throughCtor = def.through();
    const secondLocalKey = def.secondLocalKey ?? throughCtor.primaryKey;
    const on = `${relatedCtor.table}.${def.secondKey} = ${throughCtor.table}.${secondLocalKey}`;
    const query = new QueryBuilder(relatedCtor)
        .select([`${relatedCtor.table}.*`])
        .join(throughCtor.table, on)
        .whereEq(`${throughCtor.table}.${def.firstKey}`, localValue);
    // Exclude children of soft-deleted through-rows (Laravel-parity). The RELATED
    // model's own soft-delete scope is injected by toSelectSql; the THROUGH model's
    // must be added explicitly on the join.
    if (throughCtor.softDeletes) query.whereRaw(`${throughCtor.table}.deleted_at IS NULL`);
    // hasOneThrough is single-valued — bound the lazy query to one row so related()
    // matches the eager with() / .first() shape (mirrors morphOne).
    if (def.type === "hasOneThrough") query.limit(1);
    return { query, get: (db) => query.get(db), first: (db) => query.first(db) };
}

function buildHasManyThroughLoader(
    parentCtor: TModelCtor<any>,
    name: string,
    def: THasManyThroughDefinition | THasOneThroughDefinition,
): (db: D1Database, models: any[], constraint?: TEagerConstraint) => Promise<void> {
    return async (db, models, constraint) => {
        if (models.length === 0) return;
        const localKey = def.localKey ?? parentCtor.primaryKey;
        const keys = models.map((m) => m.get(localKey)).filter((k: unknown) => k != null);
        if (keys.length === 0) return;

        const relatedCtor = def.model();
        const throughCtor = def.through();
        const secondLocalKey = def.secondLocalKey ?? throughCtor.primaryKey;
        const on = `${relatedCtor.table}.${def.secondKey} = ${throughCtor.table}.${secondLocalKey}`;

        // SELECT related.*, through.<firstKey> AS __through_fk
        // FROM related JOIN through ON related.<secondKey> = through.<secondLocalKey>
        // WHERE through.<firstKey> IN (parent keys)
        const results = await getInChunks(
            db,
            keys,
            (chunk) => {
                const q = new QueryBuilder(relatedCtor)
                    .select([`${relatedCtor.table}.*`, `${throughCtor.table}.${def.firstKey} as __through_fk`])
                    .join(throughCtor.table, on)
                    .whereIn(`${throughCtor.table}.${def.firstKey}`, chunk);
                // Exclude children of soft-deleted through-rows (Laravel-parity).
                if (throughCtor.softDeletes) q.whereRaw(`${throughCtor.table}.deleted_at IS NULL`);
                return q;
            },
            constraint,
        );

        if (def.type === "hasOneThrough") {
            const indexed = new Map<unknown, EagerModel>();
            for (const r of results) {
                const k = (r as EagerModel).get("__through_fk");
                if (!indexed.has(k)) indexed.set(k, r as EagerModel);
            }
            for (const m of models) m.setRelation(name, indexed.get(m.get(localKey)) ?? null);
            return;
        }

        const grouped = new Map<unknown, EagerModel[]>();
        for (const r of results) {
            const k = (r as EagerModel).get("__through_fk");
            const arr = grouped.get(k) ?? [];
            arr.push(r as EagerModel);
            grouped.set(k, arr);
        }
        for (const m of models) m.setRelation(name, grouped.get(m.get(localKey)) ?? []);
    };
}

function buildHasManyThroughAggregateSubquery(
    def: THasManyThroughDefinition | THasOneThroughDefinition,
    parentCtor: TModelCtor<any>,
    aggExpr: string,
): TExistsSubquery {
    const relatedCtor = def.model();
    const throughCtor = def.through();
    const localKey = def.localKey ?? parentCtor.primaryKey;
    const secondLocalKey = def.secondLocalKey ?? throughCtor.primaryKey;
    const on = `${relatedCtor.table}.${def.secondKey} = ${throughCtor.table}.${secondLocalKey}`;
    const sub = new QueryBuilder(relatedCtor)
        .selectRaw(aggExpr)
        .join(throughCtor.table, on)
        .whereRaw(`${throughCtor.table}.${def.firstKey} = ${parentCtor.table}.${localKey}`);
    // Don't count/aggregate children of soft-deleted through-rows.
    if (throughCtor.softDeletes) sub.whereRaw(`${throughCtor.table}.deleted_at IS NULL`);
    return sub.toSelectSql();
}

function buildHasManyThroughExistsSubquery(
    def: THasManyThroughDefinition | THasOneThroughDefinition,
    parentCtor: TModelCtor<any>,
    additionalWhere?: (q: QueryBuilder<any>) => void,
): TExistsSubquery {
    const relatedCtor = def.model();
    const throughCtor = def.through();
    const localKey = def.localKey ?? parentCtor.primaryKey;
    const secondLocalKey = def.secondLocalKey ?? throughCtor.primaryKey;
    const on = `${relatedCtor.table}.${def.secondKey} = ${throughCtor.table}.${secondLocalKey}`;
    const sub = new QueryBuilder(relatedCtor)
        .select(["1"])
        .join(throughCtor.table, on)
        .whereRaw(`${throughCtor.table}.${def.firstKey} = ${parentCtor.table}.${localKey}`);
    // whereHas / has / withExists must not match via soft-deleted through-rows.
    if (throughCtor.softDeletes) sub.whereRaw(`${throughCtor.table}.deleted_at IS NULL`);
    if (additionalWhere) sub.applyRelationConstraint(additionalWhere);
    const { sql, bindings } = sub.toSelectSql();
    return { sql, bindings };
}

export function deriveEagerLoaders(
    parentCtor: TModelCtor<any>,
    relations: Record<string, TRelationDefinition>,
): Record<string, EagerLoaderFn> {
    const loaders: Record<string, EagerLoaderFn> = {};

    for (const [name, def] of Object.entries(relations)) {
        loaders[name] = buildEagerLoader(parentCtor, name, def);
    }

    return loaders;
}

function buildEagerLoader(
    parentCtor: TModelCtor<any>,
    name: string,
    def: TRelationDefinition,
): EagerLoaderFn {
    switch (def.type) {
        case "hasMany":
            return buildHasManyLoader(parentCtor, name, def);
        case "hasOne":
            return buildHasOneLoader(parentCtor, name, def);
        case "belongsTo":
            return buildBelongsToLoader(parentCtor, name, def);
        case "belongsToMany":
            return buildBelongsToManyLoader(parentCtor, name, def);
        case "hasManyThrough":
        case "hasOneThrough":
            return buildHasManyThroughLoader(parentCtor, name, def);
        case "morphTo":
            return buildMorphToLoader(name, def);
        case "morphMany":
        case "morphOne":
            return buildMorphManyLoader(parentCtor, name, def);
        case "morphToMany":
            return buildMorphToManyLoader(parentCtor, name, def);
        case "morphedByMany":
            return buildMorphedByManyLoader(parentCtor, name, def);
    }
}

function buildMorphToManyLoader(
    parentCtor: TModelCtor<any>,
    name: string,
    def: TMorphToManyDefinition,
): EagerLoaderFn {
    return async (db, models, constraint) => {
        if (models.length === 0) return;
        const localKey = def.localKey ?? parentCtor.primaryKey;
        const keys = models.map((m) => m.get(localKey)).filter((k: unknown) => k != null);
        if (keys.length === 0) return;

        const relatedCtor = def.model();
        const relatedKey = def.relatedKey ?? relatedCtor.primaryKey;
        const { typeCol, idCol } = morphCols(def);
        const on = `${def.pivot}.${def.relatedPivotKey} = ${relatedCtor.table}.${relatedKey}`;

        const results = await getInChunks(db, keys, (chunk) =>
            new QueryBuilder(relatedCtor)
                .select([
                    `${relatedCtor.table}.*`,
                    `${def.pivot}.${idCol} as __morph_id`,
                ])
                .join(def.pivot, on)
                .whereEq(`${def.pivot}.${typeCol}`, def.typeValue)
                .whereIn(`${def.pivot}.${idCol}`, chunk), constraint);

        const grouped = new Map<unknown, EagerModel[]>();
        for (const r of results) {
            const k = (r as EagerModel).get("__morph_id");
            const arr = grouped.get(k) ?? [];
            arr.push(r as EagerModel);
            grouped.set(k, arr);
        }

        for (const m of models) {
            m.setRelation(name, grouped.get(m.get(localKey)) ?? []);
        }
    };
}

function buildMorphedByManyLoader(
    parentCtor: TModelCtor<any>,
    name: string,
    def: TMorphedByManyDefinition,
): EagerLoaderFn {
    return async (db, models, constraint) => {
        if (models.length === 0) return;
        const localKey = def.localKey ?? parentCtor.primaryKey;
        const keys = models.map((m) => m.get(localKey)).filter((k: unknown) => k != null);
        if (keys.length === 0) return;

        const ownerCtor = def.model();
        const ownerKey = def.relatedKey ?? ownerCtor.primaryKey;
        const { typeCol, idCol } = morphCols(def);
        const on = `${def.pivot}.${idCol} = ${ownerCtor.table}.${ownerKey}`;

        const results = await getInChunks(db, keys, (chunk) =>
            new QueryBuilder(ownerCtor)
                .select([
                    `${ownerCtor.table}.*`,
                    `${def.pivot}.${def.relatedPivotKey} as __related_pivot_fk`,
                ])
                .join(def.pivot, on)
                .whereEq(`${def.pivot}.${typeCol}`, def.typeValue)
                .whereIn(`${def.pivot}.${def.relatedPivotKey}`, chunk), constraint);

        const grouped = new Map<unknown, EagerModel[]>();
        for (const r of results) {
            const k = (r as EagerModel).get("__related_pivot_fk");
            const arr = grouped.get(k) ?? [];
            arr.push(r as EagerModel);
            grouped.set(k, arr);
        }

        for (const m of models) {
            m.setRelation(name, grouped.get(m.get(localKey)) ?? []);
        }
    };
}

function buildHasManyLoader(
    parentCtor: TModelCtor<any>,
    name: string,
    def: THasManyDefinition,
): EagerLoaderFn {
    return async (db, models, constraint) => {
        if (models.length === 0) return;
        const localKey = def.localKey ?? parentCtor.primaryKey;
        const keys = models.map((m) => m.get(localKey)).filter((k: unknown) => k != null);
        if (keys.length === 0) return;

        const relatedCtor = def.model();
        const related = await getInChunks(db, keys, (chunk) =>
            new QueryBuilder(relatedCtor)
                .select([`${relatedCtor.table}.*`, `${relatedCtor.table}.${def.foreignKey} as __hasmany_fk`])
                .whereIn(def.foreignKey, chunk), constraint);

        // Group by foreign key (aliased so it survives a constrained-eager `.select(...)`)
        const grouped = new Map<unknown, EagerModel[]>();
        for (const r of related) {
            const fk = (r as EagerModel).get("__hasmany_fk");
            const arr = grouped.get(fk) ?? [];
            arr.push(r as EagerModel);
            grouped.set(fk, arr);
        }

        for (const m of models) {
            m.setRelation(name, grouped.get(m.get(localKey)) ?? []);
        }
    };
}

function buildHasOneLoader(
    parentCtor: TModelCtor<any>,
    name: string,
    def: THasOneDefinition,
): EagerLoaderFn {
    return async (db, models, constraint) => {
        if (models.length === 0) return;
        const localKey = def.localKey ?? parentCtor.primaryKey;
        const keys = models.map((m) => m.get(localKey)).filter((k: unknown) => k != null);
        if (keys.length === 0) return;

        const relatedCtor = def.model();
        const related = await getInChunks(db, keys, (chunk) =>
            new QueryBuilder(relatedCtor)
                .select([`${relatedCtor.table}.*`, `${relatedCtor.table}.${def.foreignKey} as __hasone_fk`])
                .whereIn(def.foreignKey, chunk), constraint);

        // Index by foreign key (aliased so it survives a constrained-eager `.select(...)`; first match wins)
        const indexed = new Map<unknown, EagerModel>();
        for (const r of related) {
            const fk = (r as EagerModel).get("__hasone_fk");
            if (!indexed.has(fk)) indexed.set(fk, r as EagerModel);
        }

        for (const m of models) {
            m.setRelation(name, indexed.get(m.get(localKey)) ?? null);
        }
    };
}

function buildBelongsToLoader(
    _parentCtor: TModelCtor<any>,
    name: string,
    def: TBelongsToDefinition,
): EagerLoaderFn {
    return async (db, models, constraint) => {
        if (models.length === 0) return;
        const relatedCtor = def.model();
        const ownerKey = def.ownerKey ?? relatedCtor.primaryKey;

        // Collect foreign key values from parent models
        const fkValues = models.map((m) => m.get(def.foreignKey)).filter((k: unknown) => k != null);
        if (fkValues.length === 0) return;

        const related = await getInChunks(db, fkValues, (chunk) =>
            new QueryBuilder(relatedCtor)
                .select([`${relatedCtor.table}.*`, `${relatedCtor.table}.${ownerKey} as __belongsto_ok`])
                .whereIn(ownerKey, chunk), constraint);

        // Index by owner key (aliased so it survives a constrained-eager `.select(...)`)
        const indexed = new Map<unknown, EagerModel>();
        for (const r of related) {
            indexed.set((r as EagerModel).get("__belongsto_ok"), r as EagerModel);
        }

        for (const m of models) {
            m.setRelation(name, indexed.get(m.get(def.foreignKey)) ?? null);
        }
    };
}

function buildMorphManyLoader(
    parentCtor: TModelCtor<any>,
    name: string,
    def: TMorphManyDefinition | TMorphOneDefinition,
): EagerLoaderFn {
    return async (db, models, constraint) => {
        if (models.length === 0) return;
        const localKey = def.localKey ?? parentCtor.primaryKey;
        const keys = models.map((m) => m.get(localKey)).filter((k: unknown) => k != null);
        if (keys.length === 0) return;

        const relatedCtor = def.model();
        const { typeCol, idCol } = morphCols(def);

        const related = await getInChunks(db, keys, (chunk) =>
            new QueryBuilder(relatedCtor)
                .whereEq(typeCol, def.typeValue)
                .whereIn(idCol, chunk), constraint);

        if (def.type === "morphOne") {
            const indexed = new Map<unknown, EagerModel>();
            for (const r of related) {
                const k = (r as EagerModel).get(idCol);
                if (!indexed.has(k)) indexed.set(k, r as EagerModel);
            }
            for (const m of models) {
                m.setRelation(name, indexed.get(m.get(localKey)) ?? null);
            }
            return;
        }

        const grouped = new Map<unknown, EagerModel[]>();
        for (const r of related) {
            const k = (r as EagerModel).get(idCol);
            const arr = grouped.get(k) ?? [];
            arr.push(r as EagerModel);
            grouped.set(k, arr);
        }
        for (const m of models) {
            m.setRelation(name, grouped.get(m.get(localKey)) ?? []);
        }
    };
}

function buildMorphToLoader(
    name: string,
    def: TMorphToDefinition,
): EagerLoaderFn {
    return async (db, models, constraint) => {
        if (models.length === 0) return;
        const { typeCol, idCol } = morphCols(def);

        // Group parent rows by type discriminator
        const byType = new Map<string, { ids: unknown[]; parents: EagerModel[] }>();
        for (const m of models) {
            const t = m.get(typeCol) as string | null | undefined;
            const id = m.get(idCol);
            if (t == null || id == null) {
                (m as EagerModel).setRelation(name, null);
                continue;
            }
            const entry = byType.get(t) ?? { ids: [], parents: [] };
            entry.ids.push(id);
            entry.parents.push(m as EagerModel);
            byType.set(t, entry);
        }

        // For each type, batch-load the related rows and distribute
        for (const [t, { ids, parents }] of byType.entries()) {
            const factory = def.morphMap[t];
            if (!factory) {
                throw new Error(
                    `morphTo '${def.morphName}': unknown type '${t}' encountered during eager load. Add it to morphMap.`,
                );
            }
            const relatedCtor = factory();
            const related = await getInChunks(db, ids, (chunk) =>
                new QueryBuilder(relatedCtor).whereIn(relatedCtor.primaryKey, chunk), constraint);
            const indexed = new Map<unknown, EagerModel>();
            for (const r of related) {
                indexed.set((r as EagerModel).get(relatedCtor.primaryKey), r as EagerModel);
            }
            for (const p of parents) {
                p.setRelation(name, indexed.get(p.get(idCol)) ?? null);
            }
        }
    };
}

function buildBelongsToManyLoader(
    parentCtor: TModelCtor<any>,
    name: string,
    def: TBelongsToManyDefinition,
): EagerLoaderFn {
    return async (db, models, constraint) => {
        if (models.length === 0) return;
        const localKey = def.localKey ?? parentCtor.primaryKey;
        const keys = models.map((m) => m.get(localKey)).filter((k: unknown) => k != null);
        if (keys.length === 0) return;

        const relatedCtor = def.model();
        const relatedKey = def.relatedKey ?? relatedCtor.primaryKey;

        // Query: SELECT related.*, pivot.foreignPivotKey FROM related JOIN pivot ON ...
        // We need the pivot's foreignPivotKey to distribute results back to parents.
        const on = `${def.pivot}.${def.relatedPivotKey} = ${relatedCtor.table}.${relatedKey}`;
        const results = await getInChunks(db, keys, (chunk) =>
            new QueryBuilder(relatedCtor)
                .select([`${relatedCtor.table}.*`, `${def.pivot}.${def.foreignPivotKey} as __pivot_fk`])
                .join(def.pivot, on)
                .whereIn(`${def.pivot}.${def.foreignPivotKey}`, chunk), constraint);

        // Group by pivot foreign key
        const grouped = new Map<unknown, EagerModel[]>();
        for (const r of results) {
            const pivotFk = (r as EagerModel).get("__pivot_fk");
            const arr = grouped.get(pivotFk) ?? [];
            arr.push(r as EagerModel);
            grouped.set(pivotFk, arr);
        }

        for (const m of models) {
            m.setRelation(name, grouped.get(m.get(localKey)) ?? []);
        }
    };
}

// ── Build EXISTS subquery for has/whereHas ──────────────────────────────

export type TExistsSubquery = {
    sql: string;
    bindings: unknown[];
};

/**
 * Build an EXISTS subquery for a relation.
 * The subquery is correlated — it references the parent table's columns.
 *
 * @param def - The relation definition
 * @param parentCtor - The parent model constructor (for table name / primary key)
 * @param additionalWhere - Optional callback to add WHERE conditions to the subquery
 */
/**
 * Build a correlated aggregate subquery for a relation — used by
 * `qb.withCount()`, `qb.withSum()`, `qb.withAvg()` on the QueryBuilder.
 *
 * Produces the inner `SELECT <agg>(...) FROM <related> WHERE <correlation>`
 * fragment that the caller then wraps with `(<sql>) AS <alias>` in the
 * outer SELECT list. Subquery bindings flow through `selectSubBindings`.
 *
 * `aggExpr` should be a complete expression like `'COUNT(*)'`, `'SUM(total)'`,
 * `'AVG(score)'` — emitted verbatim, so column names must be safe.
 *
 * @throws on `morphTo` (the inverse spans multiple tables and can't be aggregated).
 */
export function buildAggregateSubquery(
    def: TRelationDefinition,
    parentCtor: TModelCtor<any>,
    aggExpr: string,
): TExistsSubquery {
    switch (def.type) {
        case "hasMany":
        case "hasOne":
            return buildHasAggregateSubquery(def, parentCtor, aggExpr);
        case "belongsTo":
            return buildBelongsToAggregateSubquery(def, parentCtor, aggExpr);
        case "belongsToMany":
            return buildBelongsToManyAggregateSubquery(def, parentCtor, aggExpr);
        case "hasManyThrough":
        case "hasOneThrough":
            return buildHasManyThroughAggregateSubquery(def, parentCtor, aggExpr);
        case "morphMany":
        case "morphOne":
            return buildMorphManyAggregateSubquery(def, parentCtor, aggExpr);
        case "morphToMany":
            return buildMorphToManyAggregateSubquery(def, parentCtor, aggExpr);
        case "morphedByMany":
            return buildMorphedByManyAggregateSubquery(def, parentCtor, aggExpr);
        case "morphTo":
            throw new Error(
                `Aggregate on 'morphTo' is not supported — the inverse side spans multiple tables. ` +
                    `Use withCount / withSum / withAvg on the owning morphMany side instead.`,
            );
    }
}

function buildHasAggregateSubquery(
    def: THasManyDefinition | THasOneDefinition,
    parentCtor: TModelCtor<any>,
    aggExpr: string,
): TExistsSubquery {
    const relatedCtor = def.model();
    const localKey = def.localKey ?? parentCtor.primaryKey;
    const sub = new QueryBuilder(relatedCtor)
        .selectRaw(aggExpr)
        .whereRaw(`${relatedCtor.table}.${def.foreignKey} = ${parentCtor.table}.${localKey}`);
    return sub.toSelectSql();
}

function buildBelongsToAggregateSubquery(
    def: TBelongsToDefinition,
    parentCtor: TModelCtor<any>,
    aggExpr: string,
): TExistsSubquery {
    const relatedCtor = def.model();
    const ownerKey = def.ownerKey ?? relatedCtor.primaryKey;
    const sub = new QueryBuilder(relatedCtor)
        .selectRaw(aggExpr)
        .whereRaw(`${relatedCtor.table}.${ownerKey} = ${parentCtor.table}.${def.foreignKey}`);
    return sub.toSelectSql();
}

function buildBelongsToManyAggregateSubquery(
    def: TBelongsToManyDefinition,
    parentCtor: TModelCtor<any>,
    aggExpr: string,
): TExistsSubquery {
    const relatedCtor = def.model();
    const localKey = def.localKey ?? parentCtor.primaryKey;
    const relatedKey = def.relatedKey ?? relatedCtor.primaryKey;
    const on = `${def.pivot}.${def.relatedPivotKey} = ${relatedCtor.table}.${relatedKey}`;
    const sub = new QueryBuilder(relatedCtor)
        .selectRaw(aggExpr)
        .join(def.pivot, on)
        .whereRaw(`${def.pivot}.${def.foreignPivotKey} = ${parentCtor.table}.${localKey}`);
    return sub.toSelectSql();
}

function buildMorphManyAggregateSubquery(
    def: TMorphManyDefinition | TMorphOneDefinition,
    parentCtor: TModelCtor<any>,
    aggExpr: string,
): TExistsSubquery {
    const relatedCtor = def.model();
    const localKey = def.localKey ?? parentCtor.primaryKey;
    const { typeCol, idCol } = morphCols(def);
    const sub = new QueryBuilder(relatedCtor)
        .selectRaw(aggExpr)
        .whereEq(`${relatedCtor.table}.${typeCol}`, def.typeValue)
        .whereRaw(`${relatedCtor.table}.${idCol} = ${parentCtor.table}.${localKey}`);
    return sub.toSelectSql();
}

function buildMorphToManyAggregateSubquery(
    def: TMorphToManyDefinition,
    parentCtor: TModelCtor<any>,
    aggExpr: string,
): TExistsSubquery {
    const relatedCtor = def.model();
    const localKey = def.localKey ?? parentCtor.primaryKey;
    const relatedKey = def.relatedKey ?? relatedCtor.primaryKey;
    const { typeCol, idCol } = morphCols(def);
    const on = `${def.pivot}.${def.relatedPivotKey} = ${relatedCtor.table}.${relatedKey}`;
    const sub = new QueryBuilder(relatedCtor)
        .selectRaw(aggExpr)
        .join(def.pivot, on)
        .whereEq(`${def.pivot}.${typeCol}`, def.typeValue)
        .whereRaw(`${def.pivot}.${idCol} = ${parentCtor.table}.${localKey}`);
    return sub.toSelectSql();
}

function buildMorphedByManyAggregateSubquery(
    def: TMorphedByManyDefinition,
    parentCtor: TModelCtor<any>,
    aggExpr: string,
): TExistsSubquery {
    const ownerCtor = def.model();
    const localKey = def.localKey ?? parentCtor.primaryKey;
    const ownerKey = def.relatedKey ?? ownerCtor.primaryKey;
    const { typeCol, idCol } = morphCols(def);
    const on = `${def.pivot}.${idCol} = ${ownerCtor.table}.${ownerKey}`;
    const sub = new QueryBuilder(ownerCtor)
        .selectRaw(aggExpr)
        .join(def.pivot, on)
        .whereEq(`${def.pivot}.${typeCol}`, def.typeValue)
        .whereRaw(`${def.pivot}.${def.relatedPivotKey} = ${parentCtor.table}.${localKey}`);
    return sub.toSelectSql();
}

export function buildExistsSubquery(
    def: TRelationDefinition,
    parentCtor: TModelCtor<any>,
    additionalWhere?: (q: QueryBuilder<any>) => void,
): TExistsSubquery {
    switch (def.type) {
        case "hasMany":
        case "hasOne":
            return buildHasExistsSubquery(def, parentCtor, additionalWhere);
        case "belongsTo":
            return buildBelongsToExistsSubquery(def, parentCtor, additionalWhere);
        case "belongsToMany":
            return buildBelongsToManyExistsSubquery(def, parentCtor, additionalWhere);
        case "hasManyThrough":
        case "hasOneThrough":
            return buildHasManyThroughExistsSubquery(def, parentCtor, additionalWhere);
        case "morphMany":
        case "morphOne":
            return buildMorphManyExistsSubquery(def, parentCtor, additionalWhere);
        case "morphToMany":
            return buildMorphToManyExistsSubquery(def, parentCtor, additionalWhere);
        case "morphedByMany":
            return buildMorphedByManyExistsSubquery(def, parentCtor, additionalWhere);
        case "morphTo":
            throw new Error(
                `whereHas/has on 'morphTo' is not supported — the inverse side spans multiple tables. ` +
                    `Use whereHas on the owning morphMany side instead.`,
            );
    }
}

function buildMorphToManyExistsSubquery(
    def: TMorphToManyDefinition,
    parentCtor: TModelCtor<any>,
    additionalWhere?: (q: QueryBuilder<any>) => void,
): TExistsSubquery {
    const relatedCtor = def.model();
    const localKey = def.localKey ?? parentCtor.primaryKey;
    const relatedKey = def.relatedKey ?? relatedCtor.primaryKey;
    const { typeCol, idCol } = morphCols(def);

    if (additionalWhere) {
        const on = `${def.pivot}.${def.relatedPivotKey} = ${relatedCtor.table}.${relatedKey}`;
        const sub = new QueryBuilder(relatedCtor)
            .select(["1"])
            .join(def.pivot, on)
            .whereEq(`${def.pivot}.${typeCol}`, def.typeValue)
            .whereRaw(`${def.pivot}.${idCol} = ${parentCtor.table}.${localKey}`);

        sub.applyRelationConstraint(additionalWhere);

        const { sql, bindings } = sub.toSelectSql();
        return { sql, bindings };
    }

    // Simple case: just check pivot for existence (cheaper)
    const sql =
        `SELECT 1 FROM ${def.pivot} ` +
        `WHERE ${def.pivot}.${typeCol} = ? ` +
        `AND ${def.pivot}.${idCol} = ${parentCtor.table}.${localKey}`;
    return { sql, bindings: [def.typeValue] };
}

function buildMorphedByManyExistsSubquery(
    def: TMorphedByManyDefinition,
    parentCtor: TModelCtor<any>,
    additionalWhere?: (q: QueryBuilder<any>) => void,
): TExistsSubquery {
    const ownerCtor = def.model();
    const localKey = def.localKey ?? parentCtor.primaryKey;
    const ownerKey = def.relatedKey ?? ownerCtor.primaryKey;
    const { typeCol, idCol } = morphCols(def);

    if (additionalWhere) {
        const on = `${def.pivot}.${idCol} = ${ownerCtor.table}.${ownerKey}`;
        const sub = new QueryBuilder(ownerCtor)
            .select(["1"])
            .join(def.pivot, on)
            .whereEq(`${def.pivot}.${typeCol}`, def.typeValue)
            .whereRaw(`${def.pivot}.${def.relatedPivotKey} = ${parentCtor.table}.${localKey}`);

        sub.applyRelationConstraint(additionalWhere);

        const { sql, bindings } = sub.toSelectSql();
        return { sql, bindings };
    }

    const sql =
        `SELECT 1 FROM ${def.pivot} ` +
        `WHERE ${def.pivot}.${typeCol} = ? ` +
        `AND ${def.pivot}.${def.relatedPivotKey} = ${parentCtor.table}.${localKey}`;
    return { sql, bindings: [def.typeValue] };
}

function buildMorphManyExistsSubquery(
    def: TMorphManyDefinition | TMorphOneDefinition,
    parentCtor: TModelCtor<any>,
    additionalWhere?: (q: QueryBuilder<any>) => void,
): TExistsSubquery {
    const relatedCtor = def.model();
    const localKey = def.localKey ?? parentCtor.primaryKey;
    const { typeCol, idCol } = morphCols(def);

    const sub = new QueryBuilder(relatedCtor)
        .select(["1"])
        .whereEq(`${relatedCtor.table}.${typeCol}`, def.typeValue)
        .whereRaw(`${relatedCtor.table}.${idCol} = ${parentCtor.table}.${localKey}`);

    if (additionalWhere) sub.applyRelationConstraint(additionalWhere);

    const { sql, bindings } = sub.toSelectSql();
    return { sql, bindings };
}

function buildHasExistsSubquery(
    def: THasManyDefinition | THasOneDefinition,
    parentCtor: TModelCtor<any>,
    additionalWhere?: (q: QueryBuilder<any>) => void,
): TExistsSubquery {
    const relatedCtor = def.model();
    const localKey = def.localKey ?? parentCtor.primaryKey;

    const sub = new QueryBuilder(relatedCtor)
        .select(["1"])
        .whereRaw(`${relatedCtor.table}.${def.foreignKey} = ${parentCtor.table}.${localKey}`);

    if (additionalWhere) sub.applyRelationConstraint(additionalWhere);

    const { sql, bindings } = sub.toSelectSql();
    return { sql, bindings };
}

function buildBelongsToExistsSubquery(
    def: TBelongsToDefinition,
    parentCtor: TModelCtor<any>,
    additionalWhere?: (q: QueryBuilder<any>) => void,
): TExistsSubquery {
    const relatedCtor = def.model();
    const ownerKey = def.ownerKey ?? relatedCtor.primaryKey;

    const sub = new QueryBuilder(relatedCtor)
        .select(["1"])
        .whereRaw(`${relatedCtor.table}.${ownerKey} = ${parentCtor.table}.${def.foreignKey}`);

    if (additionalWhere) sub.applyRelationConstraint(additionalWhere);

    const { sql, bindings } = sub.toSelectSql();
    return { sql, bindings };
}

function buildBelongsToManyExistsSubquery(
    def: TBelongsToManyDefinition,
    parentCtor: TModelCtor<any>,
    additionalWhere?: (q: QueryBuilder<any>) => void,
): TExistsSubquery {
    const relatedCtor = def.model();
    const localKey = def.localKey ?? parentCtor.primaryKey;
    const relatedKey = def.relatedKey ?? relatedCtor.primaryKey;

    if (additionalWhere) {
        // Need to go through the related model to apply user conditions
        const on = `${def.pivot}.${def.relatedPivotKey} = ${relatedCtor.table}.${relatedKey}`;
        const sub = new QueryBuilder(relatedCtor)
            .select(["1"])
            .join(def.pivot, on)
            .whereRaw(`${def.pivot}.${def.foreignPivotKey} = ${parentCtor.table}.${localKey}`);

        sub.applyRelationConstraint(additionalWhere);

        const { sql, bindings } = sub.toSelectSql();
        return { sql, bindings };
    }

    // Simple case: just check pivot table for existence (more efficient)
    // We build raw SQL here since QueryBuilder is model-centric and pivot isn't a model
    const sql = `SELECT 1 FROM ${def.pivot} WHERE ${def.pivot}.${def.foreignPivotKey} = ${parentCtor.table}.${localKey}`;
    return { sql, bindings: [] };
}
