import type { TModelCtor } from "./types";
import { QueryBuilder } from "./queryBuilder";

/**
 * Result of `sync()` / `toggle()` — IDs that were inserted or removed from
 * the pivot during the call.
 */
export type TPivotSyncResult = {
    attached: string[];
    detached: string[];
};

/**
 * Pivot-management helpers — present on relationships backed by a pivot
 * table (`belongsToMany`, `morphToMany`, `morphedByMany`). Not present on
 * other relation types; calling them on a non-pivot relationship throws.
 */
export type TPivotMethods = {
    /**
     * Insert pivot rows linking the parent to one or more related IDs.
     * Idempotent on the pivot's primary key — duplicates are skipped via
     * `INSERT OR IGNORE`. Optional `extras` adds extra pivot columns to
     * every inserted row (e.g. role, position, timestamps).
     *
     * Returns the number of pivot rows actually inserted.
     */
    attach: (
        ids: string | number | (string | number)[],
        opts?: { extras?: Record<string, unknown>; db?: D1Database },
    ) => Promise<number>;

    /**
     * Remove pivot rows. Pass:
     *   - a single id → remove that link
     *   - an array of ids → remove those links
     *   - nothing → remove **all** pivot rows for this parent
     * Returns the number of pivot rows removed.
     */
    detach: (
        ids?: string | number | (string | number)[],
        opts?: { db?: D1Database },
    ) => Promise<number>;

    /**
     * Make the pivot's set of related IDs match `ids` exactly — inserts
     * missing IDs and removes ones not in the target set. Returns the
     * diff applied.
     */
    sync: (
        ids: (string | number)[],
        opts?: { extras?: Record<string, unknown>; db?: D1Database },
    ) => Promise<TPivotSyncResult>;

    /**
     * Flip pivot membership for each ID — attach if absent, detach if
     * present. Useful for "favorite / unfavorite" style toggles.
     */
    toggle: (
        ids: string | number | (string | number)[],
        opts?: { extras?: Record<string, unknown>; db?: D1Database },
    ) => Promise<TPivotSyncResult>;
};

export type TRelationship<TModel extends { toObject(): object }> = {
    query: QueryBuilder<TModel>;
    get: (db?: D1Database) => Promise<TModel[]>;
    first: (db?: D1Database) => Promise<TModel | null>;
    /** Pivot management methods — present only on pivot-backed relationships. */
} & Partial<TPivotMethods>;

export const belongsTo = <TChild extends { toObject(): object }>(
    childCtor: TModelCtor<TChild>,
    opts: { foreignKey: string; ownerKey?: string; localValue: unknown },
): TRelationship<TChild> => {
    const ownerKey = opts.ownerKey ?? childCtor.primaryKey;
    const query = new QueryBuilder(childCtor).whereEq(ownerKey, opts.localValue);
    return { query, get: (db) => query.get(db), first: (db) => query.first(db) };
};

export const hasMany = <TChild extends { toObject(): object }>(
    childCtor: TModelCtor<TChild>,
    opts: { foreignKey: string; localValue: unknown },
): TRelationship<TChild> => {
    const query = new QueryBuilder(childCtor).whereEq(opts.foreignKey, opts.localValue);
    return { query, get: (db) => query.get(db), first: (db) => query.first(db) };
};

export const hasOne = <TChild extends { toObject(): object }>(
    childCtor: TModelCtor<TChild>,
    opts: { foreignKey: string; localValue: unknown },
): TRelationship<TChild> => {
    const query = new QueryBuilder(childCtor).whereEq(opts.foreignKey, opts.localValue);
    return { query, get: (db) => query.get(db), first: (db) => query.first(db) };
};

/**
 * Many-to-many relationship through a pivot table.
 * Emits a single JOIN query: SELECT related.* FROM related JOIN pivot ON pivot.relatedKey = related.pk WHERE pivot.foreignKey = localValue
 *
 * IMPORTANT: The pivot table must NOT have a `deleted_at` column. If the related model uses softDeletes,
 * the soft-delete scope appends `deleted_at IS NULL` without table qualification — this becomes ambiguous
 * if the pivot table also has `deleted_at`.
 *
 * Use .get(db) by convention (returns TRelated[]). .first(db) is available but unusual for many-to-many.
 */
export const belongsToMany = <TRelated extends { toObject(): object }>(
    relatedCtor: TModelCtor<TRelated>,
    opts: { pivot: string; foreignKey: string; relatedKey: string; localValue: unknown },
): TRelationship<TRelated> => {
    const on = `${opts.pivot}.${opts.relatedKey} = ${relatedCtor.table}.${relatedCtor.primaryKey}`;
    const query = new QueryBuilder(relatedCtor)
        .select([`${relatedCtor.table}.*`])
        .join(opts.pivot, on)
        .whereEq(`${opts.pivot}.${opts.foreignKey}`, opts.localValue);
    return { query, get: (db) => query.get(db), first: (db) => query.first(db) };
};

/**
 * Used for eager loading: fetch related rows for a set of keys.
 */
export const belongsToManyFetch = async <TChild extends { toObject(): object }>(
    db: D1Database,
    childCtor: TModelCtor<TChild>,
    ownerKey: string,
    ownerKeyValues: unknown[],
): Promise<TChild[]> => {
    if (ownerKeyValues.length === 0) return [];
    return new QueryBuilder(childCtor).whereIn(ownerKey, ownerKeyValues).get(db);
};
