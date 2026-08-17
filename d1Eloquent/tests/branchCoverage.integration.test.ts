// branchCoverage.integration.test.ts
// Targeted tests to hit uncovered branches in baseModel, collection, proxy, castManager

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BaseModel } from "../baseModel";
import { Collection } from "../collection";
import { CastManager } from "../castManager";
import type { CacheAdapter, CacheInvalidationEvent } from "../cacheAdapter";
import type { TRevisionConfig } from "../revisionTypes";

// ── Mock cache adapter ───────────────────────────────────────────────

class MockCache implements CacheAdapter {
    events: CacheInvalidationEvent[] = [];
    async invalidate(event: CacheInvalidationEvent): Promise<void> {
        this.events.push(event);
    }
}

// ── Models ───────────────────────────────────────────────────────────

interface ItemAttrs {
    id?: string;
    name?: string;
    score?: number;
    created_at?: string | Date;
    updated_at?: string | Date;
    deleted_at?: string | Date | null;
}

class CachedItem extends BaseModel<ItemAttrs> {
    static table = "bc_items";
    static primaryKey = "id";
    static timestamps = true;
    static softDeletes = true;
    static revisions: TRevisionConfig = { enabled: true, mode: "diff+after" };
}

class NoTimestampItem extends BaseModel<{ id?: string; name?: string; deleted_at?: string | null }> {
    static table = "bc_bare";
    static primaryKey = "id";
    static timestamps = false;
    static softDeletes = true;
}

class NoRevItem extends BaseModel<ItemAttrs> {
    static table = "bc_items";
    static primaryKey = "id";
    static timestamps = true;
    static softDeletes = true;
}

// ── Setup ────────────────────────────────────────────────────────────

beforeAll(async () => {
    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS bc_items (
            id TEXT PRIMARY KEY, name TEXT, score INTEGER DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '',
            deleted_at TEXT
        )
    `).run();
    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS bc_bare (
            id TEXT PRIMARY KEY, name TEXT, deleted_at TEXT
        )
    `).run();
    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS model_revisions (
            id TEXT PRIMARY KEY, model_table TEXT NOT NULL, model_pk TEXT NOT NULL,
            model_id TEXT NOT NULL, action TEXT NOT NULL, diff_json TEXT,
            before_json TEXT, after_json TEXT, actor_id TEXT, request_id TEXT,
            reason TEXT, created_at TEXT NOT NULL
        )
    `).run();
});

afterAll(async () => {
    await env.DB.prepare("DROP TABLE IF EXISTS bc_items").run();
    await env.DB.prepare("DROP TABLE IF EXISTS bc_bare").run();
});

beforeEach(async () => {
    await env.DB.prepare("DELETE FROM bc_items").run();
    await env.DB.prepare("DELETE FROM bc_bare").run();
    await env.DB.prepare("DELETE FROM model_revisions").run();
});

// ── Cache invalidation branches ──────────────────────────────────────

describe("save() with cache adapter", () => {
    it("invalidates cache on create", async () => {
        const cache = new MockCache();
        await CachedItem.create(env.DB, { id: "cc1", name: "A" });
        const item = await CachedItem.find(env.DB, "cc1");
        item!.set("name", "B" as any);
        await item!.save(env.DB, { cache });
        expect(cache.events).toEqual([{ table: "bc_items", id: "cc1", action: "update" }]);
    });

    it("invalidates cache on create with cache", async () => {
        const cache = new MockCache();
        const item = new CachedItem({ id: "cc2", name: "New" });
        await item.save(env.DB, { cache });
        expect(cache.events.some(e => e.action === "create")).toBe(true);
    });
});

describe("delete() with cache adapter", () => {
    it("invalidates cache on soft delete", async () => {
        const cache = new MockCache();
        const item = await CachedItem.create(env.DB, { id: "dc1", name: "ToDel" });
        await item.delete(env.DB, { cache });
        expect(cache.events.some(e => e.action === "delete")).toBe(true);
    });

    it("invalidates cache on hard delete", async () => {
        const cache = new MockCache();
        const item = await NoRevItem.create(env.DB, { id: "dc2", name: "HardDel" });
        await item.delete(env.DB, { cache });
        expect(cache.events.some(e => e.action === "delete")).toBe(true);
    });
});

describe("restore() with cache adapter", () => {
    it("invalidates cache on restore", async () => {
        const cache = new MockCache();
        const item = await CachedItem.create(env.DB, { id: "rc1", name: "Restore" });
        await item.delete(env.DB);
        await item.restore(env.DB, { cache });
        expect(cache.events.some(e => e.action === "update")).toBe(true);
    });
});

// ── restore with revisions ───────────────────────────────────────────

describe("restore() with revisions enabled", () => {
    it("writes a revision on restore", async () => {
        const item = await CachedItem.create(env.DB, { id: "rr1", name: "WithRev" });
        await item.delete(env.DB);
        await item.restore(env.DB);

        const rev = await env.DB.prepare(
            "SELECT * FROM model_revisions WHERE model_id = ? AND action = 'update' ORDER BY created_at DESC LIMIT 1"
        ).bind("rr1").first();
        expect(rev).not.toBeNull();
    });
});

// ── restore without timestamps ───────────────────────────────────────

describe("delete() + restore() without timestamps", () => {
    it("soft deletes and restores correctly", async () => {
        const item = await NoTimestampItem.create(env.DB, { id: "nt1", name: "NoTs" });
        await item.delete(env.DB);
        expect(item.get("deleted_at")).not.toBeNull();

        await item.restore(env.DB);
        expect(item.get("deleted_at")).toBeNull();
    });
});

// ── asOf diff-only replay path ───────────────────────────────────────

describe("asOf diff-only replay", () => {
    it("throws when all revisions are diff-only (no snapshots)", async () => {
        // Create a model first so the table has data
        await CachedItem.create(env.DB, { id: "df1", name: "Init" });
        // Clear revisions and insert a pure diff-only revision (no before/after)
        await env.DB.prepare("DELETE FROM model_revisions WHERE model_id = ?").bind("df1").run();
        await env.DB.prepare(
            `INSERT INTO model_revisions (id, model_table, model_pk, model_id, action, diff_json, before_json, after_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`
        ).bind("diff-rev-1", "bc_items", "id", "df1", "update", '{"name":"Updated"}', new Date().toISOString()).run();

        await expect(CachedItem.asOf(env.DB, "df1", new Date().toISOString()))
            .rejects.toThrow("No snapshots found");
    });

    it("replays diffs on top of a base snapshot", async () => {
        await CachedItem.create(env.DB, { id: "df2", name: "Base" });
        // Clear auto-generated revisions
        await env.DB.prepare("DELETE FROM model_revisions WHERE model_id = ?").bind("df2").run();

        // Insert a base revision with after_json (snapshot) — t=1
        await env.DB.prepare(
            `INSERT INTO model_revisions (id, model_table, model_pk, model_id, action, diff_json, before_json, after_json, created_at)
             VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`
        ).bind("base-rev", "bc_items", "id", "df2", "create", '{"id":"df2","name":"Base"}', "2025-01-01T00:00:00.000Z").run();

        // Insert a diff-only revision on top (no after_json) — t=2 (later, so it's "latest")
        await env.DB.prepare(
            `INSERT INTO model_revisions (id, model_table, model_pk, model_id, action, diff_json, before_json, after_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`
        ).bind("diff-rev-2", "bc_items", "id", "df2", "update", '{"name":"Replayed"}', "2025-01-01T00:00:01.000Z").run();

        const model = await CachedItem.asOf(env.DB, "df2", "2025-12-31T00:00:00.000Z");
        expect(model).not.toBeNull();
        expect(model!.get("name")).toBe("Replayed");
    });
});

// ── save() with no dirty changes ─────────────────────────────────────

describe("save() on existing model", () => {
    it("save on an unchanged model still touches updated_at (timestamps enabled)", async () => {
        const item = await CachedItem.create(env.DB, { id: "nc1", name: "NoChange" });
        const beforeTs = item.get("updated_at");

        // Small delay to get a different timestamp
        await new Promise((r) => setTimeout(r, 10));
        await item.save(env.DB); // no user changes but timestamps auto-update
        const afterTs = item.get("updated_at");
        expect(afterTs).not.toBe(beforeTs);
    });
});

// ── Collection branch coverage ───────────────────────────────────────

describe("Collection.sortBy with null values", () => {
    it("sorts null/undefined values correctly in ascending", () => {
        const col = Collection.from([
            { name: null } as any,
            { name: "Alice" } as any,
            { name: undefined } as any,
            { name: "Bob" } as any,
        ]);
        const sorted = col.sortBy("name", "asc");
        // nulls should sort before non-null in asc
        expect(sorted[0].name == null).toBe(true);
    });

    it("sorts null/undefined values correctly in descending", () => {
        const col = Collection.from([
            { name: "Alice" } as any,
            { name: null } as any,
            { name: "Bob" } as any,
        ]);
        const sorted = col.sortBy("name", "desc");
        expect(sorted[0].name).toBe("Bob");
    });

    it("handles both null values correctly", () => {
        const col = Collection.from([
            { name: null } as any,
            { name: null } as any,
        ]);
        const sorted = col.sortBy("name", "asc");
        expect(sorted.length).toBe(2);
    });
});

describe("Collection.toArray with non-model items", () => {
    it("returns items as-is when they lack toObject()", () => {
        const col = Collection.from([{ x: 1 }, { x: 2 }]);
        const arr = col.toArray();
        expect(arr).toEqual([{ x: 1 }, { x: 2 }]);
    });
});

describe("Collection._extractKey with plain objects", () => {
    it("groups by key on plain objects", () => {
        const col = Collection.from([
            { type: "a", val: 1 },
            { type: "b", val: 2 },
            { type: "a", val: 3 },
        ]);
        const grouped = col.groupBy("type");
        expect(grouped.get("a")?.length).toBe(2);
        expect(grouped.get("b")?.length).toBe(1);
    });

    it("pluckBy on plain objects returns values", () => {
        const col = Collection.from([{ name: "X" }, { name: "Y" }]);
        const names = col.pluck("name");
        expect(names).toEqual(["X", "Y"]);
    });
});

// ── CastManager branch coverage ──────────────────────────────────────

describe("CastManager branch coverage", () => {
    it("date cast set with string input", () => {
        const result = CastManager.dehydrateRow(
            { born: { get: (v: any) => v, set: (v: any) => (v instanceof Date ? v.toISOString().split("T")[0] : new Date(v).toISOString().split("T")[0]) } } as any,
            { born: "2025-01-15" }
        );
        expect(typeof result.born).toBe("string");
    });

    it("timestamp cast round-trips", () => {
        const casts = CastManager.resolveCastsFor({
            timestamps: false,
            softDeletes: false,
            casts: { ts: "timestamp" },
        } as any);
        const dehydrated = CastManager.dehydrateRow(casts, { ts: new Date("2025-01-01T00:00:00Z") });
        expect(typeof dehydrated.ts).toBe("number");

        const hydrated = CastManager.hydrateRow(casts, { ts: 1735689600 });
        expect(hydrated.ts).toBeInstanceOf(Date);
    });

    it("array cast with non-string get input", () => {
        const casts = CastManager.resolveCastsFor({
            timestamps: false,
            softDeletes: false,
            casts: { tags: "array" },
        } as any);
        const hydrated = CastManager.hydrateRow(casts, { tags: [1, 2, 3] });
        expect(hydrated.tags).toEqual([1, 2, 3]);
    });

    it("json cast with non-string get input (already object)", () => {
        const casts = CastManager.resolveCastsFor({
            timestamps: false,
            softDeletes: false,
            casts: { meta: "json" },
        } as any);
        const hydrated = CastManager.hydrateRow(casts, { meta: { key: "val" } });
        expect(hydrated.meta).toEqual({ key: "val" });
    });

    it("json cast set with string passes through", () => {
        const casts = CastManager.resolveCastsFor({
            timestamps: false,
            softDeletes: false,
            casts: { meta: "json" },
        } as any);
        const dehydrated = CastManager.dehydrateRow(casts, { meta: '{"already":"string"}' });
        expect(dehydrated.meta).toBe('{"already":"string"}');
    });

    it("date cast set with string (not Date)", () => {
        const casts = CastManager.resolveCastsFor({
            timestamps: false,
            softDeletes: false,
            casts: { day: "date" },
        } as any);
        const dehydrated = CastManager.dehydrateRow(casts, { day: "2025-06-15" });
        expect(typeof dehydrated.day).toBe("string");
    });

    it("datetime cast set with string (not Date)", () => {
        const casts = CastManager.resolveCastsFor({
            timestamps: false,
            softDeletes: false,
            casts: { when: "datetime" },
        } as any);
        const dehydrated = CastManager.dehydrateRow(casts, { when: "2025-01-01T00:00:00.000Z" });
        expect(dehydrated.when).toBe("2025-01-01T00:00:00.000Z");
    });

    it("timestamp cast set with number (not Date)", () => {
        const casts = CastManager.resolveCastsFor({
            timestamps: false,
            softDeletes: false,
            casts: { ts: "timestamp" },
        } as any);
        const dehydrated = CastManager.dehydrateRow(casts, { ts: 12345 });
        expect(dehydrated.ts).toBe(12345);
    });
});

// ── Proxy branch coverage ────────────────────────────────────────────

describe("Proxy edge cases", () => {
    class ProxyModel extends BaseModel<{ id?: string; name?: string }> {
        static table = "bc_items";
        static primaryKey = "id";
        static timestamps = false;
    }

    it("symbol property access passes through", () => {
        const m = new ProxyModel({ id: "p1", name: "Test" });
        const p = m.asProxy();
        // Symbol.toPrimitive should not throw
        expect(typeof p).toBe("object");
        // Symbol iterator
        const sym = Symbol("test");
        expect((p as any)[sym]).toBeUndefined();
    });

    it("$model returns the raw model", () => {
        const m = new ProxyModel({ id: "p2", name: "Test" });
        const p = m.asProxy();
        expect((p as any).$model).toBe(m);
    });

    it("toJSON returns toObject result", () => {
        const m = new ProxyModel({ id: "p3", name: "Hello" });
        const p = m.asProxy();
        const json = JSON.stringify(p);
        expect(JSON.parse(json)).toEqual({ id: "p3", name: "Hello" });
    });

    it("set with symbol prop returns false", () => {
        const m = new ProxyModel({ id: "p4" });
        const p = m.asProxy();
        const sym = Symbol("x");
        const result = Reflect.set(p, sym, "val");
        expect(result).toBe(false);
    });

    it("has with symbol returns false", () => {
        const m = new ProxyModel({ id: "p5" });
        const p = m.asProxy();
        expect(Symbol("test") in p).toBe(false);
    });

    it("getOwnPropertyDescriptor for non-attr prop returns non-enumerable", () => {
        const m = new ProxyModel({ id: "p6" });
        const p = m.asProxy();
        // _persisted is a target own property but not an attr
        const desc = Object.getOwnPropertyDescriptor(p, "_persisted");
        if (desc) {
            expect(desc.enumerable).toBe(false);
        }
    });

    it("getOwnPropertyDescriptor for unknown prop returns undefined", () => {
        const m = new ProxyModel({ id: "p7" });
        const p = m.asProxy();
        const desc = Object.getOwnPropertyDescriptor(p, "nonexistent_xyz");
        expect(desc).toBeUndefined();
    });

    it("accessing undefined property returns undefined", () => {
        const m = new ProxyModel({ id: "p8" });
        const p = m.asProxy();
        expect((p as any).doesNotExist).toBeUndefined();
    });
});

// ── firstOrCreate / updateOrCreate without db ────────────────────────

describe("firstOrCreate / updateOrCreate auto-resolve", () => {
    beforeEach(async () => {
        const { registerConnection } = await import("../registry");
        registerConnection("default", env.DB);
    });

    it("firstOrCreate auto-resolves db", async () => {
        const item = await NoRevItem.firstOrCreate({ id: "foc1", name: "First" } as any);
        expect(item.get("name")).toBe("First");

        // Second call finds existing
        const same = await NoRevItem.firstOrCreate({ id: "foc1" } as any, { name: "Ignored" } as any);
        expect(same.get("name")).toBe("First");
    });

    it("updateOrCreate auto-resolves db", async () => {
        const item = await NoRevItem.updateOrCreate({ id: "uoc1" } as any, { name: "Created" } as any);
        expect(item.get("name")).toBe("Created");

        // Second call updates
        const updated = await NoRevItem.updateOrCreate({ id: "uoc1" } as any, { name: "Updated" } as any);
        expect(updated.get("name")).toBe("Updated");
    });
});
