export type TD1Row = Record<string, unknown>;

// TModelAttrsOf and TModelCtor are defined in baseModel.ts to avoid circular imports.
// Re-exported here for backward compatibility.
export type { TModelAttrsOf, TModelCtor, TModelRelationsOf, TRelations } from "./baseModel";

/**
 * Comparison operators accepted by where()/orWhere()/having()/whereColumn().
 * Single source of truth: TWhereOp is derived from this tuple and the query
 * builder's runtime allow-list (VALID_OPS) is built from it, so the compile-time
 * type and the runtime guard can never drift (pattern ops LIKE/NOT LIKE/GLOB are
 * handled separately in QueryBuilder.PATTERN_OPS).
 */
export const WHERE_OPS = ["=", "!=", ">", ">=", "<", "<=", "LIKE", "NOT LIKE", "IN"] as const;
export type TWhereOp = (typeof WHERE_OPS)[number];

export type TOrderDirection = "asc" | "desc" | "ASC" | "DESC";

/**
 * Subset of D1 result metadata surfaced by `qb.getWithMeta()`/`firstWithMeta()`.
 * Mirrors `D1Meta` from `@cloudflare/workers-types` but tolerates missing fields
 * so this type compiles even without the peer installed.
 */
export type TD1ResultMeta = {
    duration?: number;
    rows_read?: number;
    rows_written?: number;
    last_row_id?: number;
    changes?: number;
    served_by?: string;
    served_by_region?: string;
    served_by_primary?: boolean;
    size_after?: number;
    changed_db?: boolean;
    timings?: { sql_duration_ms?: number };
};

/**
 * Constraint passed to `qb.withSession()` — either a session-creation directive
 * (`'first-unconstrained'` / `'first-primary'`) or an opaque bookmark string
 * returned from a previous request's session.
 *
 * @see https://developers.cloudflare.com/d1/best-practices/read-replication/
 */
export type TSessionConstraint = "first-unconstrained" | "first-primary" | string;
