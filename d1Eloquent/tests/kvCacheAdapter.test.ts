// kvCacheAdapter.test.ts
// Unit tests for KvCacheAdapter using a fake KV that records operations.

import { describe, it, expect, beforeEach } from "vitest";
import { KvCacheAdapter } from "../kvCacheAdapter";
import type { CacheInvalidationEvent } from "../cacheAdapter";
import { BaseModel } from "../baseModel";

interface UserAttrs {
    id: string;
    name: string;
    email: string;
}

class User extends BaseModel<UserAttrs> {
    static table = "users";
    static primaryKey = "id";
    static timestamps = false;
}

// Fake KV that stores values in a Map and records every operation
function fakeKv() {
    const store = new Map<string, { value: string; ttl?: number }>();
    const ops: Array<{ kind: "get" | "put" | "delete"; key: string; ttl?: number }> = [];

    return {
        kv: {
            async get(key: string) {
                ops.push({ kind: "get", key });
                const entry = store.get(key);
                return entry ? entry.value : null;
            },
            async put(key: string, value: string, opts?: { expirationTtl?: number }) {
                ops.push({ kind: "put", key, ttl: opts?.expirationTtl });
                store.set(key, { value, ttl: opts?.expirationTtl });
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

describe("KvCacheAdapter — keys and prefix", () => {
    it("uses 'd1e:' as the default prefix", async () => {
        const { kv, ops } = fakeKv();
        const cache = new KvCacheAdapter(kv);
        await cache.set("foo", { x: 1 });
        expect(ops[0].key).toBe("d1e:foo");
    });

    it("respects a custom prefix", async () => {
        const { kv, ops } = fakeKv();
        const cache = new KvCacheAdapter(kv, { prefix: "app:" });
        await cache.set("foo", { x: 1 });
        expect(ops[0].key).toBe("app:foo");
    });

    it("does not double-prefix keys that already start with the prefix", async () => {
        const { kv, ops } = fakeKv();
        const cache = new KvCacheAdapter(kv, { prefix: "d1e:" });
        await cache.set("d1e:users:123", { name: "Alice" });
        expect(ops[0].key).toBe("d1e:users:123");
    });

    it("cacheKey produces 'prefix:table:id'", () => {
        const cache = new KvCacheAdapter(fakeKv().kv);
        expect(cache.cacheKey("users", "abc")).toBe("d1e:users:abc");
    });
});

describe("KvCacheAdapter — get / set / delete", () => {
    it("round-trips JSON values", async () => {
        const cache = new KvCacheAdapter(fakeKv().kv);
        await cache.set("user:1", { id: "1", name: "Alice" });
        const out = await cache.get<{ id: string; name: string }>("user:1");
        expect(out).toEqual({ id: "1", name: "Alice" });
    });

    it("returns null on miss", async () => {
        const cache = new KvCacheAdapter(fakeKv().kv);
        expect(await cache.get("nope")).toBeNull();
    });

    it("returns null on parse failure", async () => {
        const { kv, store } = fakeKv();
        store.set("d1e:broken", { value: "{not-valid-json" });
        const cache = new KvCacheAdapter(kv);
        expect(await cache.get("broken")).toBeNull();
    });

    it("set passes ttl to KV.put.expirationTtl", async () => {
        const { kv, ops } = fakeKv();
        const cache = new KvCacheAdapter(kv);
        await cache.set("a", 1, 120);
        expect(ops[0].ttl).toBe(120);
    });

    it("set falls back to defaultTtl when no ttl is passed", async () => {
        const { kv, ops } = fakeKv();
        const cache = new KvCacheAdapter(kv, { defaultTtl: 300 });
        await cache.set("a", 1);
        expect(ops[0].ttl).toBe(300);
    });

    it("delete removes the entry", async () => {
        const { kv, store } = fakeKv();
        const cache = new KvCacheAdapter(kv);
        await cache.set("a", 1);
        await cache.delete("a");
        expect(store.has("d1e:a")).toBe(false);
    });
});

describe("KvCacheAdapter — remember (read-through)", () => {
    it("calls the loader on miss and caches the result", async () => {
        const { kv, ops, store } = fakeKv();
        const cache = new KvCacheAdapter(kv);
        let loaderCalls = 0;

        const v = await cache.remember("greeting", 60, async () => {
            loaderCalls++;
            return "hello";
        });

        expect(v).toBe("hello");
        expect(loaderCalls).toBe(1);
        expect(store.has("d1e:greeting")).toBe(true);
        expect(ops.find((o) => o.kind === "put")?.ttl).toBe(60);
    });

    it("returns cached value without calling the loader on hit", async () => {
        const { kv } = fakeKv();
        const cache = new KvCacheAdapter(kv);
        await cache.set("greeting", "hello", 60);

        let loaderCalls = 0;
        const v = await cache.remember("greeting", 60, async () => {
            loaderCalls++;
            return "world";
        });

        expect(v).toBe("hello");
        expect(loaderCalls).toBe(0);
    });

    it("does not cache null/undefined loader results", async () => {
        const { kv, store } = fakeKv();
        const cache = new KvCacheAdapter(kv);

        const v = await cache.remember<string | null>("missing", 60, async () => null);
        expect(v).toBeNull();
        expect(store.has("d1e:missing")).toBe(false);
    });
});

describe("KvCacheAdapter — CacheAdapter contract", () => {
    it("invalidate deletes the canonical key for create/update/delete events", async () => {
        const { kv, store, ops } = fakeKv();
        const cache = new KvCacheAdapter(kv);
        await cache.set("users:abc", { id: "abc" });
        expect(store.has("d1e:users:abc")).toBe(true);

        const event: CacheInvalidationEvent = { table: "users", id: "abc", action: "update" };
        await cache.invalidate(event);

        expect(store.has("d1e:users:abc")).toBe(false);
        expect(ops.at(-1)).toEqual({ kind: "delete", key: "d1e:users:abc" });
    });

    it("invalidationKey override can return multiple keys", async () => {
        const { kv, ops } = fakeKv();
        const cache = new KvCacheAdapter(kv, {
            invalidationKey: (e) => [
                `d1e:${e.table}:${e.id}`,
                `d1e:${e.table}:list`,
                `d1e:${e.table}:count`,
            ],
        });
        await cache.invalidate({ table: "posts", id: "p1", action: "create" });

        const deletedKeys = ops.filter((o) => o.kind === "delete").map((o) => o.key);
        expect(deletedKeys).toEqual([
            "d1e:posts:p1",
            "d1e:posts:list",
            "d1e:posts:count",
        ]);
    });
});

describe("KvCacheAdapter — findOrLoad", () => {
    it("returns cached attrs as a fresh model instance on hit", async () => {
        const { kv } = fakeKv();
        const cache = new KvCacheAdapter(kv);
        await cache.set("users:u1", { id: "u1", name: "Alice", email: "a@x" });

        const callsLoader = { count: 0 };
        const MockUser = Object.assign(
            class extends User {
                static async find(_id: string): Promise<User | null> {
                    callsLoader.count++;
                    return null;
                }
            },
            { table: "users" },
        );

        const out = await cache.findOrLoad<UserAttrs, User>(MockUser, "u1");
        expect(out).toBeInstanceOf(MockUser);
        expect(out?.get("name")).toBe("Alice");
        expect(callsLoader.count).toBe(0);
    });

    it("falls through to Model.find on miss and caches toRaw() output", async () => {
        const { kv, store } = fakeKv();
        const cache = new KvCacheAdapter(kv);
        const rawAttrs = { id: "u1", name: "Bob", email: "b@x" };

        const StaticUser = Object.assign(
            class extends User {
                static async find(_id: string): Promise<User | null> {
                    const u = new this(rawAttrs);
                    (u as unknown as { _persisted: boolean })._persisted = true;
                    return u as unknown as User;
                }
            },
            { table: "users" },
        );

        const out = await cache.findOrLoad<UserAttrs, User>(StaticUser, "u1", 30);
        expect(out?.get("name")).toBe("Bob");
        expect(store.has("d1e:users:u1")).toBe(true);
    });
});
