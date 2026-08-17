// coverage100.coreManagersA.test.ts
// Closes the remaining coverage gaps in:
// - d1Eloquent/registry.ts            (test-env resolution branch, lines 75-80)
// - d1Eloquent/castManager.ts         (enumCast null passthrough, unknown cast
//                                      type, array cast null fallback)
// - d1Eloquent/managers/attributeManager.ts
//                                     (toJSON relation serialization branches,
//                                      non-Error mutator/accessor throws,
//                                      fan-out unchanged-value branch)
// - d1Eloquent/managers/dirtyManager.ts
//                                     (cloneAttr structuredClone fallback, line 24)

import { describe, it, expect } from "vitest";
import {
    registerConnection,
    unregisterConnection,
    getConnection,
    resolveDb,
} from "../registry";
import { CastManager, enumCast } from "../castManager";
import type { CastDefinition } from "../castManager";
import { AttributeManager } from "../managers/attributeManager";
import { DirtyManager, snapshotOriginal } from "../managers/dirtyManager";
import type { TDirtyModel } from "../managers/dirtyManager";
import type { TModelInternals } from "../managers/types";
import { Attribute } from "../attribute";

// ---- helpers ----

function fakeDb(tag: string): D1Database {
    return { _tag: tag, prepare: () => ({}) } as unknown as D1Database;
}

/** Force isTestEnv() in registry.ts to return true for the duration of fn. */
function withVitestGlobal<T>(fn: () => T): T {
    const g = globalThis as Record<string, unknown>;
    const had = "__vitest__" in g;
    g["__vitest__"] = true;
    try {
        return fn();
    } finally {
        if (!had) delete g["__vitest__"];
    }
}

/** Save and restore the registry's "test" connection around fn. */
function withTestConnection<T>(replacement: D1Database | null, fn: () => T): T {
    const prior = getConnection("test");
    if (replacement) registerConnection("test", replacement);
    else unregisterConnection("test");
    try {
        return fn();
    } finally {
        if (prior) registerConnection("test", prior);
        else unregisterConnection("test");
    }
}

function createModel(
    attrs: Record<string, unknown> = {},
    overrides?: Partial<{
        accessors: Record<string, Attribute>;
        appends: string[];
        hidden: string[];
        fillable: string[];
        guarded: string[];
        casts: Record<string, CastDefinition>;
        relations: Record<string, unknown>;
    }>,
): TModelInternals {
    const model = {
        attrs: { ...attrs },
        original: { ...attrs },
        dirty: new Set<string>(),
        lastChanges: {} as Record<string, unknown>,
        _persisted: false,
        _wasRecentlyCreated: false,
        _accessorCache: new Map<string, unknown>(),
        relations: overrides?.relations ?? {},
    };
    Object.defineProperty(model, "constructor", {
        value: {
            table: "test",
            primaryKey: "id",
            accessors: overrides?.accessors,
            appends: overrides?.appends,
            hidden: overrides?.hidden,
            fillable: overrides?.fillable,
            guarded: overrides?.guarded,
            casts: overrides?.casts,
        },
        enumerable: false,
    });
    return model as unknown as TModelInternals;
}

// ---- registry.ts ----

describe("registry.ts - resolveDb test-env branch", () => {
    it("returns the registered 'test' connection when running in a test env", () => {
        const testDb = fakeDb("the-test-db");
        const resolved = withVitestGlobal(() =>
            withTestConnection(testDb, () => resolveDb(undefined, undefined)),
        );
        expect(resolved).toBe(testDb);
    });

    it("throws a descriptive error in a test env when no 'test' connection exists", () => {
        withVitestGlobal(() => {
            withTestConnection(null, () => {
                // Even with a default and a model connection available, the test
                // env path throws first: tests must never silently hit prod-ish DBs.
                const other = fakeDb("model-conn");
                expect(() => resolveDb(undefined, other)).toThrow(
                    /No 'test' database configured/,
                );
            });
        });
    });

    it("an explicitly passed db still wins over the 'test' connection", () => {
        const testDb = fakeDb("registry-test-db");
        const explicit = fakeDb("explicit-db");
        const resolved = withVitestGlobal(() =>
            withTestConnection(testDb, () => resolveDb(explicit, undefined)),
        );
        expect(resolved).toBe(explicit);
    });
});

// ---- castManager.ts ----

describe("castManager.ts - remaining cast branches", () => {
    it("enumCast get() passes null and undefined through as null", () => {
        const cast = enumCast(["draft", "published"]);
        expect(cast.get(null)).toBeNull();
        expect(cast.get(undefined)).toBeNull();
        // sanity: a valid value still round-trips
        expect(cast.get("draft")).toBe("draft");
    });

    it("enumCast set() passes null and undefined through as null", () => {
        const cast = enumCast(["draft", "published"]);
        expect(cast.set(null)).toBeNull();
        expect(cast.set(undefined)).toBeNull();
        // sanity: an invalid write still throws (writes stay strict)
        expect(() => cast.set("bogus" as unknown as "draft")).toThrow(/Invalid enum value/);
    });

    it("resolveCastsFor throws on an unknown string cast type", () => {
        expect(() =>
            CastManager.resolveCastsFor({
                timestamps: false,
                casts: { status: "bogus" as unknown as CastDefinition },
            }),
        ).toThrow('Unknown cast type: "bogus"');
    });

    it("array cast set() serializes null/undefined to an empty JSON array", () => {
        const resolved = CastManager.resolveCastsFor({
            timestamps: false,
            casts: { tags: "array" },
        });
        const tags = resolved["tags"];
        expect(tags).toBeDefined();
        expect(tags?.set(null)).toBe("[]");
        expect(tags?.set(undefined)).toBe("[]");
        // and the stored "[]" hydrates back to a real empty array
        expect(tags?.get("[]")).toEqual([]);
    });
});

// ---- managers/attributeManager.ts ----

describe("managers/attributeManager.ts - toJSON relation serialization", () => {
    it("serializes null and undefined relations as-is", () => {
        const model = createModel(
            { id: "1", name: "Alice" },
            { relations: { parent: null, ghost: undefined } },
        );
        const json = AttributeManager.toJSON(model);
        expect(json).toHaveProperty("parent", null);
        expect(json).toHaveProperty("ghost", undefined);
        expect("ghost" in json).toBe(true);
    });

    it("serializes array relation items via toObject() when they lack toJSON()", () => {
        const model = createModel(
            { id: "1" },
            {
                relations: {
                    things: [
                        { toObject: () => ({ kind: "widget", n: 1 }) },
                        { toObject: () => ({ kind: "gadget", n: 2 }) },
                    ],
                },
            },
        );
        const json = AttributeManager.toJSON(model);
        expect(json["things"]).toEqual([
            { kind: "widget", n: 1 },
            { kind: "gadget", n: 2 },
        ]);
    });

    it("serializes a single relation via its toJSON()", () => {
        const model = createModel(
            { id: "1" },
            { relations: { author: { toJSON: () => ({ id: "a1", name: "Bob" }) } } },
        );
        const json = AttributeManager.toJSON(model);
        expect(json["author"]).toEqual({ id: "a1", name: "Bob" });
    });

    it("serializes a single relation via toObject() when it lacks toJSON()", () => {
        const model = createModel(
            { id: "1" },
            { relations: { profile: { toObject: () => ({ bio: "hi" }) } } },
        );
        const json = AttributeManager.toJSON(model);
        expect(json["profile"]).toEqual({ bio: "hi" });
    });
});

describe("managers/attributeManager.ts - non-Error throw wrapping", () => {
    it("wraps a non-Error thrown by a mutator using String(err)", () => {
        const model = createModel(
            { id: "1", nick: "" },
            {
                accessors: {
                    nick: Attribute.set(() => {
                        // biome-ignore lint/style/useThrowOnlyError: intentionally a non-Error throw
                        throw "mutator exploded";
                    }),
                },
            },
        );
        expect(() => AttributeManager.set(model, "nick", "x")).toThrow(
            "Mutator error for key 'nick': mutator exploded",
        );
    });

    it("wraps a non-Error thrown by an accessor getter using String(err)", () => {
        const model = createModel(
            { id: "1", shout: "hey" },
            {
                accessors: {
                    shout: Attribute.get(() => {
                        // biome-ignore lint/style/useThrowOnlyError: intentionally a non-Error throw
                        throw 42;
                    }),
                },
            },
        );
        expect(() => AttributeManager.get(model, "shout")).toThrow(
            "Accessor error for key 'shout': 42",
        );
    });
});

describe("managers/attributeManager.ts - fan-out unchanged-value branch", () => {
    it("marks an unchanged fan-out key dirty but omits it from lastChanges", () => {
        const model = createModel(
            { id: "1", first_name: "John", last_name: "Doe" },
            {
                accessors: {
                    fullName: Attribute.set((value: unknown) => {
                        const [first, ...rest] = String(value).split(" ");
                        return { first_name: first, last_name: rest.join(" ") };
                    }),
                },
            },
        );

        // first_name resolves to the identical current value ("John"), so the
        // Object.is(prev, hydrated) guard skips its lastChanges entry;
        // last_name actually changes and must be recorded.
        AttributeManager.set(model, "fullName", "John Smith");

        expect(model.attrs["first_name"]).toBe("John");
        expect(model.attrs["last_name"]).toBe("Smith");
        expect(model.dirty.has("first_name")).toBe(true);
        expect(model.dirty.has("last_name")).toBe(true);
        expect(Object.keys(model.lastChanges)).toEqual(["last_name"]);
        expect(model.lastChanges["last_name"]).toBe("Smith");
    });
});

// ---- managers/dirtyManager.ts ----

describe("managers/dirtyManager.ts - cloneAttr structuredClone fallback", () => {
    it("snapshotOriginal keeps the original reference for non-cloneable values", () => {
        const cfg = { cb: () => 1 }; // functions are not structured-cloneable
        const wm = new WeakMap(); // WeakMap is not structured-cloneable
        const plain = { a: 1 };

        const snap = snapshotOriginal({ cfg, wm, plain });

        // Non-cloneable values fall back to the live reference (line 24)
        expect(snap["cfg"]).toBe(cfg);
        expect(snap["wm"]).toBe(wm);
        // Cloneable values are deep-cloned: equal but not the same object
        expect(snap["plain"]).not.toBe(plain);
        expect(snap["plain"]).toEqual({ a: 1 });
    });

    it("syncOriginal preserves the reference of a non-cloneable attribute", () => {
        const handler = { onSave: () => "done" };
        const meta = { tags: ["a", "b"] };
        const state: TDirtyModel = {
            attrs: { id: "1", handler, meta },
            original: {},
            dirty: new Set(["handler", "meta"]),
            lastChanges: { handler, meta },
        };

        DirtyManager.syncOriginal(state);

        // fallback path: the function-bearing object could not be cloned
        expect(state.original["handler"]).toBe(handler);
        // normal path: the plain object was deep-cloned into the baseline
        expect(state.original["meta"]).not.toBe(meta);
        expect(state.original["meta"]).toEqual({ tags: ["a", "b"] });
        expect(state.dirty.size).toBe(0);
        expect(state.lastChanges).toEqual({});
    });
});
