const registry = new Map<string, D1Database>();

/**
 * Register a named D1 connection in the module-scoped registry. After
 * registration the name can be used as a per-model `static connection` value,
 * per-query via `qb.on(name)`, or as an alias target for another connection.
 *
 * @param name   Logical name for this connection (e.g. `"analytics"`).
 * @param target Either a `D1Database` binding or the name of an already-registered
 *               connection to alias. Aliases are resolved at registration time and
 *               are not recursive — the target must already exist.
 *
 * @throws Error when `target` is a string but no connection with that name is
 *         currently registered.
 */
export function registerConnection(name: string, target: D1Database | string): void {
    if (typeof target === "string") {
        const aliased = registry.get(target);
        if (!aliased) {
            throw new Error(
                `Cannot register "${name}" as an alias for "${target}": no such connection.`,
            );
        }
        registry.set(name, aliased);
        return;
    }
    registry.set(name, target);
}

/**
 * Remove a named connection from the registry. Useful for test teardown and
 * for tenant-scoped applications that swap connections at runtime.
 */
export function unregisterConnection(name: string): void {
    registry.delete(name);
}

/**
 * Drop every connection from the registry. Intended for test fixtures —
 * production code should use `unregisterConnection()` to remove specific names.
 */
export function clearConnections(): void {
    registry.clear();
}

/**
 * Returns the list of currently-registered connection names. Order matches
 * registration order. Primarily useful for diagnostics and tooling.
 */
export function listConnections(): string[] {
    return [...registry.keys()];
}

/**
 * Look up a connection by name. Returns `undefined` when the name is not
 * registered. Prefer `resolveDb()` in query paths — it handles fallbacks.
 */
export function getConnection(name: string): D1Database | undefined {
    return registry.get(name);
}

function isTestEnv(): boolean {
    return (
        (typeof process !== "undefined" && process.env?.NODE_ENV === "test") ||
        (typeof globalThis !== "undefined" && "__vitest__" in globalThis)
    );
}

export function resolveDb(
    explicit: D1Database | undefined,
    modelConn: D1Database | string | undefined,
): D1Database {
    if (explicit) return explicit;

    if (isTestEnv()) {
        const testDb = registry.get("test");
        if (testDb) return testDb;
        throw new Error(
            "No 'test' database configured. Call configure(env) with an env that includes TEST_DB.",
        );
    }

    if (modelConn !== undefined) {
        if (typeof modelConn !== "string") return modelConn;
        const named = registry.get(modelConn);
        if (named) return named;
        throw new Error(
            `Unknown connection: "${modelConn}". Register it via configure(env) or check the binding name.`,
        );
    }

    const defaultDb = registry.get("default");
    if (defaultDb) return defaultDb;

    throw new Error(
        "No database configured. Call configure(env) at Worker startup, or pass db explicitly to query methods.",
    );
}
