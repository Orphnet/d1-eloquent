export const nowIso = (): string => new Date().toISOString();

export function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new Error(msg);
}

export const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export const toArray = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);

/**
 * Validates that a value is a safe SQL identifier or qualified identifier
 * (e.g. `users`, `users.id`). Throws `EloquentException` on rejection. Opt-in —
 * the QueryBuilder never auto-applies this; use it at boundaries that accept
 * untrusted column / table names (REST handlers, GraphQL resolvers).
 *
 * The accepted grammar:
 *   - Bare identifier:   `[A-Za-z_][A-Za-z0-9_]*`
 *   - Qualified:         `ident.ident`
 *
 * Rejects whitespace, quotes, parens, semicolons, comments, dashes, and any
 * other characters typical of SQL injection payloads.
 *
 * @throws Error with message `Unsafe identifier: <value>` when the input is
 *         not a single bare/qualified identifier.
 *
 * @example
 * const sortCol = safeIdent(req.query.sort ?? "created_at");
 * Post.query().orderBy(sortCol).get(db);
 */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/;

export function safeIdent(value: string): string {
    if (typeof value !== "string" || !IDENT_RE.test(value)) {
        throw new Error(`Unsafe identifier: ${JSON.stringify(value)}`);
    }
    return value;
}

/**
 * Validate every entry in a list of identifiers. Returns the array unchanged
 * if all are safe; throws on the first violation.
 *
 * @example
 * const cols = safeIdentList(req.body.select ?? ['id', 'title']);
 * Post.query().select(cols).get(db);
 */
export function safeIdentList(values: readonly string[]): string[] {
    return values.map((v) => safeIdent(v));
}
