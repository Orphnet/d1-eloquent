// coverage100.coreManagersB.test.ts
// Closes the remaining coverage gaps in:
// - d1Eloquent/managers/keyManager.ts   (keyStrategy 'uuid' fallback, pk cast
//                                        hydration branch in setRawField)
// - d1Eloquent/managers/timestampManager.ts
//                                       (uncast passthrough branch in setRawField)
// - d1Eloquent/proxy.ts                 (ownKeys appends fallback, symbol-key skip)
// - d1Eloquent/revisionManager.ts       (empty-diff fallback, disabled no-op)
// - d1Eloquent/kvCacheAdapter.ts        (findOrLoad miss: null result not cached)
// - d1Eloquent/collection.ts            (sum/max non-numeric skip branches)

import { describe, it, expect } from "vitest";
import { KeyManager } from "../managers/keyManager";
import type { TKeyModel } from "../managers/keyManager";
import { TimestampManager } from "../managers/timestampManager";
import type { TTimestampModel } from "../managers/timestampManager";
import { BaseModel } from "../baseModel";
import type { TModelCtor } from "../baseModel";
import { RevisionManager } from "../revisionManager";
import { KvCacheAdapter } from "../kvCacheAdapter";
import { Collection } from "../collection";
import type { CastDefinition } from "../castManager";
import type { TKeyStrategy } from "../idGenerator";

// ---- helpers ----

/** Minimal structural model for KeyManager tests. */
function keyModel(ctorOverrides?: {
    keyStrategy?: TKeyStrategy;
    casts?: Record<string, CastDefinition>;
}): TKeyModel {
    const model = {
        attrs: {} as Record<string, unknown>,
        dirty: new Set<string>(),
        lastChanges: {} as Record<string, unknown>,
        _accessorCache: new Map<string, unknown>(),
    };
    Object.defineProperty(model, "constructor", {
        value: {
            table: "widgets",
            primaryKey: "id",
            ...(ctorOverrides ?? {}),
        },
        enumerable: false,
    });
    return model as unknown as TKeyModel;
}

/** Minimal structural model for TimestampManager tests. */
function tsModel(ctorOverrides?: {
    timestamps?: boolean;
    casts?: Record<string, CastDefinition>;
}): TTimestampModel {
    const model = {
        attrs: {} as Record<string, unknown>,
        dirty: new Set<string>(),
        lastChanges: {} as Record<string, unknown>,
        _accessorCache: new Map<string, unknown>(),
    };
    Object.defineProperty(model, "constructor", {
        value: { timestamps: true, ...(ctorOverrides ?? {}) },
        enumerable: false,
    });
    return model as unknown as TTimestampModel;
}

/** Stub D1Database that records every prepare/bind/run without touching SQL. */
function stubDb() {
    const calls: { sql: string; bindings: unknown[] }[] = [];
    let runs = 0;
    const db = {
        prepare(sql: string) {
            return {
                bind(...args: unknown[]) {
                    calls.push({ sql, bindings: args });
                    return {
                        run: async () => {
                            runs++;
                            return { success: true };
                        },
                    };
                },
            };
        },
    } as unknown as D1Database;
    return { db, calls, runCount: () => runs };
}

/** Fake KV that stores values in a Map and records every operation. */
function fakeKv() {
    const store = new Map<string, string>();
    const ops: Array<{ kind: "get" | "put" | "delete"; key: string }> = [];
    return {
        kv: {
            async get(key: string) {
                ops.push({ kind: "get", key });
                return store.get(key) ?? null;
            },
            async put(key: string, value: string) {
                ops.push({ kind: "put", key });
                store.set(key, value);
            },
            async delete(key: string) {
                ops.push({ kind: "delete", key });
                store.delete(key);
            },
        },
        store,
        ops,
    };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

// ---- managers/keyManager.ts ----

describe("keyManager.ts - strategy fallback and cast hydration", () => {
    it("falls back to the 'uuid' strategy when ctor.keyStrategy is undefined", () => {
        const model = keyModel(); // no keyStrategy on the ctor at all
        KeyManager.applyKeyStrategy(model);

        // The fallback must actually generate a canonical uuid, mark the key
        // dirty, and record it in lastChanges.
        const id = model.attrs["id"];
        expect(typeof id).toBe("string");
        expect(id as string).toMatch(UUID_RE);
        expect(model.dirty.has("id")).toBe(true);
        expect(model.lastChanges["id"]).toBe(id);
    });

    it("hydrates a generated key through a primary-key cast", () => {
        // A custom cast on the pk column forces the `cast ? castGet : value`
        // ternary down its true side; the stored attr must be the cast output.
        const model = keyModel({
            keyStrategy: (ctx) => `gen-${ctx.table}-${ctx.keyName}`,
            casts: {
                id: {
                    get: (v) => `cast:${String(v)}`,
                    set: (v) => v,
                },
            },
        });
        model._accessorCache.set("stale", 1);

        KeyManager.applyKeyStrategy(model);

        expect(model.attrs["id"]).toBe("cast:gen-widgets-id");
        expect(model.lastChanges["id"]).toBe("cast:gen-widgets-id");
        expect(model.dirty.has("id")).toBe(true);
        // Accessor cache is invalidated by the raw write.
        expect(model._accessorCache.size).toBe(0);
    });
});

// ---- managers/timestampManager.ts ----

describe("timestampManager.ts - uncast timestamp passthrough", () => {
    it("writes the raw ISO string when the timestamp cast is shadowed to undefined", () => {
        // resolveCastsFor auto-installs datetime casts for created_at/updated_at,
        // but a JS consumer's `static casts` can shadow them with an undefined
        // entry (e.g. a conditionally built casts object). The manager must then
        // write the raw ISO string through unchanged instead of a Date.
        const model = tsModel({
            timestamps: true,
            casts: {
                created_at: undefined as unknown as CastDefinition,
                updated_at: undefined as unknown as CastDefinition,
            },
        });

        TimestampManager.applyTimestamps(model, true);

        expect(typeof model.attrs["created_at"]).toBe("string");
        expect(model.attrs["created_at"] as string).toMatch(ISO_RE);
        expect(model.attrs["created_at"]).not.toBeInstanceOf(Date);
        expect(typeof model.attrs["updated_at"]).toBe("string");
        expect(model.attrs["updated_at"]).not.toBeInstanceOf(Date);
        expect(model.dirty.has("created_at")).toBe(true);
        expect(model.dirty.has("updated_at")).toBe(true);
    });

    it("contrast: the default datetime cast hydrates timestamps to Date", () => {
        // Sanity companion proving the previous test's assertions are load
        // bearing: without the shadowing, the same call yields Date instances.
        const model = tsModel({ timestamps: true });
        TimestampManager.applyTimestamps(model, true);
        expect(model.attrs["created_at"]).toBeInstanceOf(Date);
        expect(model.attrs["updated_at"]).toBeInstanceOf(Date);
    });
});

// ---- proxy.ts ----

interface PlainAttrs {
    id?: string;
    name?: string;
}

class PlainModel extends BaseModel<PlainAttrs> {
    static table = "plain_things";
    static timestamps = false;
    // Deliberately NO `static appends` so the ownKeys trap takes the ?? []
    // fallback.
}

describe("proxy.ts - ownKeys fallbacks", () => {
    it("enumerates only attr keys when ctor.appends is undefined", () => {
        const model = new PlainModel({ id: "1", name: "gizmo" });
        const proxy = model.asProxy();

        // With no appends the enumerable surface is exactly the attrs.
        expect(Object.keys(proxy).sort()).toEqual(["id", "name"]);

        // Spread relies on the same trap set and must produce a plain object
        // with only the attribute values.
        const spread = { ...proxy };
        expect(spread).toEqual({ id: "1", name: "gizmo" });
    });

    it("skips symbol-keyed own properties of the target in ownKeys", () => {
        const model = new PlainModel({ id: "2", name: "widget" });
        const sym = Symbol("secret");
        (model as unknown as Record<symbol, unknown>)[sym] = 123;

        const proxy = model.asProxy();

        // The raw target really owns the symbol...
        expect(Reflect.ownKeys(model)).toContain(sym);
        // ...but the proxy's key set filters it out (string keys only), while
        // still exposing the attribute keys.
        const proxyKeys = Reflect.ownKeys(proxy);
        expect(proxyKeys).not.toContain(sym);
        expect(proxyKeys).toContain("id");
        expect(proxyKeys).toContain("name");
        // Enumeration is unaffected by the symbol.
        expect(Object.keys(proxy).sort()).toEqual(["id", "name"]);
    });
});

// ---- revisionManager.ts ----

describe("revisionManager.ts - diff fallback and disabled no-op", () => {
    it("serializes an empty object for diff_json when mode is 'diff' and no diff was provided", () => {
        const { db, calls } = stubDb();
        const stmt = RevisionManager.buildRevisionStatement({
            db,
            modelTable: "posts",
            modelPk: "id",
            modelId: "p1",
            action: "update",
            config: { enabled: true, mode: "diff" },
            // diff deliberately omitted -> filteredDiff is null -> `?? {}`
        });

        expect(stmt).not.toBeNull();
        expect(calls).toHaveLength(1);
        const b = calls[0].bindings;
        // bind order: id, model_table, model_pk, model_id, action,
        //             diff_json, before_json, after_json, ...
        expect(b[1]).toBe("posts");
        expect(b[3]).toBe("p1");
        expect(b[4]).toBe("update");
        expect(b[5]).toBe("{}"); // the fallback branch under test
        expect(b[6]).toBeNull(); // before_json not stored in diff mode
        expect(b[7]).toBeNull(); // after_json not stored in diff mode
    });

    it("serializes empty objects in 'diff+after' mode when diff and after are missing", () => {
        const { db, calls } = stubDb();
        const stmt = RevisionManager.buildRevisionStatement({
            db,
            modelTable: "posts",
            modelPk: "id",
            modelId: "p2",
            action: "create",
            config: { enabled: true, mode: "diff+after" },
        });

        expect(stmt).not.toBeNull();
        const b = calls[0].bindings;
        expect(b[5]).toBe("{}");
        expect(b[7]).toBe("{}");
    });

    it("writeRevision is a complete no-op when revisions are disabled", async () => {
        const { db, calls, runCount } = stubDb();

        await expect(
            RevisionManager.writeRevision({
                db,
                modelTable: "posts",
                modelPk: "id",
                modelId: "p3",
                action: "delete",
                config: { enabled: false, mode: "diff" },
                diff: { title: "gone" },
            }),
        ).resolves.toBeUndefined();

        // Nothing prepared, nothing run.
        expect(calls).toHaveLength(0);
        expect(runCount()).toBe(0);

        // Companion control: the same call with revisions enabled DOES run,
        // proving the spy harness would have caught a write above.
        await RevisionManager.writeRevision({
            db,
            modelTable: "posts",
            modelPk: "id",
            modelId: "p3",
            action: "delete",
            config: { enabled: true, mode: "diff" },
            diff: { title: "gone" },
        });
        expect(calls).toHaveLength(1);
        expect(runCount()).toBe(1);
    });
});

// ---- kvCacheAdapter.ts ----

describe("kvCacheAdapter.ts - findOrLoad miss is not cached", () => {
    it("returns null and skips the cache write when the record does not exist", async () => {
        const { kv, store, ops } = fakeKv();
        const cache = new KvCacheAdapter(kv);

        let findCalls = 0;
        const ghostCtor = {
            table: "ghosts",
            find: async (_id: string) => {
                findCalls++;
                return null;
            },
        } as unknown as TModelCtor<{ toObject(): object }> & {
            find(id: string): Promise<{ toObject(): object } | null>;
        };

        const result = await cache.findOrLoad(ghostCtor, "nope");
        expect(result).toBeNull();
        expect(findCalls).toBe(1);

        // The miss consulted KV but never wrote to it.
        expect(ops.some((o) => o.kind === "get")).toBe(true);
        expect(ops.some((o) => o.kind === "put")).toBe(false);
        expect(store.size).toBe(0);

        // A second lookup is NOT served from a poisoned cache: the loader
        // runs again, so a later insert would become visible.
        const again = await cache.findOrLoad(ghostCtor, "nope");
        expect(again).toBeNull();
        expect(findCalls).toBe(2);
    });
});

// ---- collection.ts ----

describe("collection.ts - non-numeric skip branches", () => {
    it("sum() skips values that are not numbers instead of coercing them", () => {
        const col = Collection.from([
            { total: 10 },
            { total: "20" }, // numeric string must NOT be coerced into the sum
            { total: null },
            { total: undefined },
            { total: 5 },
        ]);
        expect(col.sum("total")).toBe(15);
    });

    it("max() ignores non-numeric values even when they would compare larger", () => {
        const col = Collection.from([
            { v: 2 },
            { v: "99" }, // would win if coerced; must be skipped
            { v: null },
            { v: 7 },
        ]);
        expect(col.max("v")).toBe(7);
    });

    it("max() returns null when no value is numeric", () => {
        const col = Collection.from([{ v: "a" }, { v: null }, { v: {} }]);
        expect(col.max("v")).toBeNull();
    });
});
