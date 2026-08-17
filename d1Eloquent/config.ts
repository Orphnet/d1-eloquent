import { registerConnection } from "./registry";

/**
 * Optional second argument to `configure()` — explicit multi-connection
 * registration for projects that bind more than one D1 database (analytics,
 * audit, tenant shards, …).
 */
export type TConfigureOpts = {
    /**
     * Named connections to register. Each value is either a `D1Database` binding
     * or a string alias for another connection previously registered (either
     * during this call or via auto-detection of `DB` / `DEFAULT_DB`).
     *
     * Aliases are resolved at registration time — `audit: 'analytics'` resolves
     * `analytics` and registers the same binding under the new name. Aliases
     * are not recursive; the target must already be registered.
     */
    connections?: Record<string, D1Database | string>;
};

/**
 * Configure d1-eloquent with Cloudflare Workers env bindings.
 *
 * Call this once at Worker startup (e.g. top of your fetch handler).
 * The following bindings are automatically detected from `env`:
 *
 * - `DEFAULT_DB` or `DB` → registered as the "default" connection
 * - `TEST_DB`            → registered as the "test" connection (used when NODE_ENV=test)
 *
 * Additional bindings can be registered explicitly via the `connections` option
 * — see [Multi-database setup](https://d1-eloquent.orph.dev/guide/configuration#multi-database).
 *
 * After calling configure(), all query methods (get, first, save, etc.) use
 * the configured database automatically when no db is passed explicitly. Pick
 * a specific named connection per-query with `qb.on(name)` (or per-model with
 * `static connection = name`).
 *
 * @example Auto-detection only
 * ```ts
 * import { configure } from "@orphnet/d1-eloquent"
 *
 * export default {
 *   async fetch(req, env) {
 *     configure(env)
 *     return app.fetch(req, env)
 *   }
 * }
 * ```
 *
 * @example Multi-DB setup with explicit names
 * ```ts
 * configure(env, {
 *   connections: {
 *     analytics: env.ANALYTICS_DB,   // separate D1 for high-volume events
 *     audit:     env.AUDIT_DB,
 *     read:      'default',          // alias — read-only routing for an Argus shadow
 *   },
 * });
 *
 * const events = await Event.query().on('analytics').get();
 * ```
 */
export function configure(env: Record<string, unknown>, opts?: TConfigureOpts): void {
    const defaultDb = (env["DEFAULT_DB"] ?? env["DB"]) as D1Database | undefined;
    if (defaultDb) registerConnection("default", defaultDb);

    const testDb = env["TEST_DB"] as D1Database | undefined;
    if (testDb) registerConnection("test", testDb);

    if (opts?.connections) {
        for (const [name, target] of Object.entries(opts.connections)) {
            registerConnection(name, target);
        }
    }
}
