// autoResolve.integration.test.ts
// Tests that exercise the "no db" overload branches of QueryBuilder and BaseModel
// by registering a default connection via the registry.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { registerConnection } from "../registry";
import { QueryBuilder } from "../queryBuilder";
import { BaseModel } from "../baseModel";
import { ModelNotFoundException, MultipleRecordsFoundException } from "../exceptions";
import type { TRelationDefinition } from "../relationTypes";

// Register env.DB as the default connection for auto-resolution
beforeAll(async () => {
    registerConnection("default", env.DB);

    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS ar_items (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            score INTEGER NOT NULL DEFAULT 0,
            deleted_at TEXT
        )
    `).run();

    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS ar_tags (
            id TEXT PRIMARY KEY,
            item_id TEXT NOT NULL,
            label TEXT NOT NULL
        )
    `).run();
});

afterAll(async () => {
    await env.DB.prepare("DROP TABLE IF EXISTS ar_tags").run();
    await env.DB.prepare("DROP TABLE IF EXISTS ar_items").run();
});

beforeEach(async () => {
    await env.DB.prepare("DELETE FROM ar_tags").run();
    await env.DB.prepare("DELETE FROM ar_items").run();
});

class Item {
    static table = "ar_items";
    static primaryKey = "id";
    static softDeletes = false;
    attrs: Record<string, unknown>;
    constructor(attrs: Record<string, unknown> = {}) { this.attrs = attrs; }
    toObject() { return this.attrs; }
}

class ArTag extends BaseModel<{ id?: string; item_id?: string; label?: string }> {
    static table = "ar_tags";
    static primaryKey = "id";
    static timestamps = false;
}

class ArModel extends BaseModel<{
    id?: string;
    name?: string;
    score?: number;
    deleted_at?: string | null;
}> {
    static table = "ar_items";
    static primaryKey = "id";
    static timestamps = false;
    static softDeletes = false;
    static relations: Record<string, TRelationDefinition> = {
        tags: { type: "hasMany", model: () => ArTag, foreignKey: "item_id" },
    };
}

class ArSoftModel extends BaseModel<{
    id?: string;
    name?: string;
    score?: number;
    deleted_at?: string | null;
}> {
    static table = "ar_items";
    static primaryKey = "id";
    static timestamps = false;
    static softDeletes = true;
}

// ── QueryBuilder auto-resolve (no db arg) ────────────────────────────

describe("QueryBuilder methods without explicit db", () => {
    beforeEach(async () => {
        await env.DB.prepare("INSERT INTO ar_items (id, name, score) VALUES (?, ?, ?)").bind("a1", "Alice", 10).run();
        await env.DB.prepare("INSERT INTO ar_items (id, name, score) VALUES (?, ?, ?)").bind("a2", "Bob", 20).run();
        await env.DB.prepare("INSERT INTO ar_items (id, name, score) VALUES (?, ?, ?)").bind("a3", "Carol", 30).run();
    });

    it("get() auto-resolves db", async () => {
        const rows = await new QueryBuilder(Item).get();
        expect(rows.length).toBe(3);
    });

    it("first() auto-resolves db", async () => {
        const row = await new QueryBuilder(Item).whereEq("id", "a1").first();
        expect(row).not.toBeNull();
    });

    it("count() auto-resolves db", async () => {
        const c = await new QueryBuilder(Item).count();
        expect(c).toBe(3);
    });

    it("sum(col) auto-resolves db", async () => {
        const total = await new QueryBuilder(Item).sum("score");
        expect(total).toBe(60);
    });

    it("avg(col) auto-resolves db", async () => {
        const avg = await new QueryBuilder(Item).avg("score");
        expect(avg).toBe(20);
    });

    it("min(col) auto-resolves db", async () => {
        const min = await new QueryBuilder(Item).min("score");
        expect(min).toBe(10);
    });

    it("max(col) auto-resolves db", async () => {
        const max = await new QueryBuilder(Item).max("score");
        expect(max).toBe(30);
    });

    it("pluck(col) auto-resolves db", async () => {
        const names = await new QueryBuilder(Item).orderBy("name").pluck("name");
        expect(names).toEqual(["Alice", "Bob", "Carol"]);
    });

    it("value(col) auto-resolves db", async () => {
        const val = await new QueryBuilder(Item).whereEq("id", "a1").value("name");
        expect(val).toBe("Alice");
    });

    it("insert(values) auto-resolves db", async () => {
        await new QueryBuilder(Item).insert({ id: "i1", name: "New", score: 0 });
        const row = await env.DB.prepare("SELECT * FROM ar_items WHERE id = ?").bind("i1").first();
        expect(row!.name).toBe("New");
    });

    it("insertOrIgnore(values) auto-resolves db", async () => {
        await new QueryBuilder(Item).insertOrIgnore({ id: "a1", name: "Dup", score: 0 });
        const row = await env.DB.prepare("SELECT * FROM ar_items WHERE id = ?").bind("a1").first();
        expect(row!.name).toBe("Alice"); // unchanged
    });

    it("insertMany(rows) auto-resolves db", async () => {
        await new QueryBuilder(Item).insertMany([
            { id: "m1", name: "M1", score: 1 },
            { id: "m2", name: "M2", score: 2 },
        ]);
        const c = await env.DB.prepare("SELECT COUNT(*) as c FROM ar_items").first<{ c: number }>();
        expect(c!.c).toBe(5); // 3 existing + 2 new
    });

    it("insertOrIgnoreMany(rows) auto-resolves db", async () => {
        await new QueryBuilder(Item).insertOrIgnoreMany([
            { id: "a1", name: "Dup", score: 0 },
            { id: "im1", name: "New", score: 0 },
        ]);
        const row = await env.DB.prepare("SELECT * FROM ar_items WHERE id = ?").bind("im1").first();
        expect(row!.name).toBe("New");
    });

    it("upsert(values, conflict) auto-resolves db", async () => {
        await new QueryBuilder(Item).upsert({ id: "a1", name: "Upserted", score: 99 }, ["id"]);
        const row = await env.DB.prepare("SELECT * FROM ar_items WHERE id = ?").bind("a1").first();
        expect(row!.name).toBe("Upserted");
    });

    it("upsertMany(rows, conflict) auto-resolves db", async () => {
        await new QueryBuilder(Item).upsertMany([
            { id: "a1", name: "U1", score: 1 },
            { id: "a2", name: "U2", score: 2 },
        ], ["id"]);
        const row = await env.DB.prepare("SELECT * FROM ar_items WHERE id = ?").bind("a1").first();
        expect(row!.name).toBe("U1");
    });

    it("upsertMany with updateCols auto-resolves db", async () => {
        await new QueryBuilder(Item).upsertMany([
            { id: "a1", name: "Changed", score: 999 },
        ], ["id"], ["name"]);
        const row = await env.DB.prepare("SELECT * FROM ar_items WHERE id = ?").bind("a1").first();
        expect(row!.name).toBe("Changed");
        expect(row!.score).toBe(10); // score preserved
    });

    it("update(values) auto-resolves db", async () => {
        const changed = await new QueryBuilder(Item).whereEq("id", "a1").update({ name: "Updated" });
        expect(changed).toBe(1);
    });

    it("delete() auto-resolves db", async () => {
        const deleted = await new QueryBuilder(Item).whereEq("id", "a1").delete();
        expect(deleted).toBe(1);
    });

    it("paginate(page, perPage) auto-resolves db", async () => {
        const result = await new QueryBuilder(Item).orderBy("id").paginate(1, 2);
        expect(result.data.length).toBe(2);
        expect(result.total).toBe(3);
    });

    it("chunk(size, cb) auto-resolves db", async () => {
        const counts: number[] = [];
        await new QueryBuilder(Item).orderBy("id").chunk(2, async (models) => {
            counts.push(models.length);
        });
        expect(counts).toEqual([2, 1]);
    });

    // ── Prepared statements without explicit db ──────────────────────

    it("toInsertPrepared(values) auto-resolves db", async () => {
        const stmt = new QueryBuilder(Item).toInsertPrepared({ id: "tp1", name: "Prep", score: 0 });
        await stmt.run();
        const row = await env.DB.prepare("SELECT * FROM ar_items WHERE id = ?").bind("tp1").first();
        expect(row!.name).toBe("Prep");
    });

    it("toInsertOrIgnorePrepared(values) auto-resolves db", async () => {
        const stmt = new QueryBuilder(Item).toInsertOrIgnorePrepared({ id: "a1", name: "Dup", score: 0 });
        await stmt.run();
        const row = await env.DB.prepare("SELECT * FROM ar_items WHERE id = ?").bind("a1").first();
        expect(row!.name).toBe("Alice");
    });

    it("toUpsertPrepared(values, conflict) auto-resolves db", async () => {
        const stmt = new QueryBuilder(Item).toUpsertPrepared({ id: "a1", name: "Up", score: 0 }, ["id"]);
        await stmt.run();
        const row = await env.DB.prepare("SELECT * FROM ar_items WHERE id = ?").bind("a1").first();
        expect(row!.name).toBe("Up");
    });

    it("toUpdatePrepared(values) auto-resolves db", async () => {
        const stmt = new QueryBuilder(Item).whereEq("id", "a1").toUpdatePrepared({ name: "UPrep" });
        await stmt.run();
        const row = await env.DB.prepare("SELECT * FROM ar_items WHERE id = ?").bind("a1").first();
        expect(row!.name).toBe("UPrep");
    });

    it("toDeletePrepared() auto-resolves db", async () => {
        const stmt = new QueryBuilder(Item).whereEq("id", "a1").toDeletePrepared();
        await stmt.run();
        const row = await env.DB.prepare("SELECT * FROM ar_items WHERE id = ?").bind("a1").first();
        expect(row).toBeNull();
    });
});

// ── BaseModel auto-resolve ──────────────────────────────────────────

describe("BaseModel methods without explicit db", () => {
    it("find() auto-resolves db", async () => {
        await ArModel.create(env.DB, { id: "f1", name: "Find" });
        const found = await ArModel.find("f1");
        expect(found).not.toBeNull();
        expect(found!.get("name")).toBe("Find");
    });

    it("create() auto-resolves db", async () => {
        const m = await ArModel.create({ id: "c1", name: "Created", score: 5 });
        expect(m.get("name")).toBe("Created");
        const row = await env.DB.prepare("SELECT * FROM ar_items WHERE id = ?").bind("c1").first();
        expect(row!.name).toBe("Created");
    });

    it("all() auto-resolves db", async () => {
        await ArModel.create(env.DB, { id: "al1", name: "One" });
        await ArModel.create(env.DB, { id: "al2", name: "Two" });
        const all = await ArModel.all();
        expect(all.length).toBe(2);
    });

    it("save() auto-resolves db for update", async () => {
        const m = await ArModel.create(env.DB, { id: "sv1", name: "Before" });
        m.set("name", "After" as any);
        await m.save();
        const row = await env.DB.prepare("SELECT * FROM ar_items WHERE id = ?").bind("sv1").first();
        expect(row!.name).toBe("After");
    });

    it("delete() auto-resolves db", async () => {
        const m = await ArModel.create(env.DB, { id: "dl1", name: "ToDelete" });
        await m.delete();
        const row = await env.DB.prepare("SELECT * FROM ar_items WHERE id = ?").bind("dl1").first();
        expect(row).toBeNull();
    });

    it("refresh() auto-resolves db", async () => {
        const m = await ArModel.create(env.DB, { id: "rf1", name: "Original" });
        await env.DB.prepare("UPDATE ar_items SET name = ? WHERE id = ?").bind("Changed", "rf1").run();
        await m.refresh();
        expect(m.get("name")).toBe("Changed");
    });

    it("findOrFail() auto-resolves db — success", async () => {
        await ArModel.create(env.DB, { id: "fof1", name: "Found" });
        const m = await ArModel.findOrFail("fof1");
        expect(m.get("name")).toBe("Found");
    });

    it("findOrFail() auto-resolves db — throws", async () => {
        await expect(ArModel.findOrFail("nonexistent")).rejects.toThrow(ModelNotFoundException);
    });

    it("firstOrFail() auto-resolves db — success", async () => {
        await ArModel.create(env.DB, { id: "fof2", name: "First" });
        const m = await ArModel.query().whereEq("id", "fof2").firstOrFail();
        expect(m.get("name")).toBe("First");
    });

    it("firstOrFail() auto-resolves db — throws", async () => {
        await expect(
            ArModel.query().whereEq("name", "nope").firstOrFail()
        ).rejects.toThrow(ModelNotFoundException);
    });

    it("sole() auto-resolves db — success", async () => {
        await ArModel.create(env.DB, { id: "so1", name: "Sole" });
        const m = await ArModel.query().whereEq("id", "so1").sole();
        expect(m.get("name")).toBe("Sole");
    });

    it("sole() auto-resolves db — throws on empty", async () => {
        await expect(
            ArModel.query().whereEq("name", "nope").sole()
        ).rejects.toThrow(ModelNotFoundException);
    });

    it("sole() auto-resolves db — throws on multiple", async () => {
        await ArModel.create(env.DB, { id: "so2", name: "Dup" });
        await ArModel.create(env.DB, { id: "so3", name: "Dup" });
        await expect(
            ArModel.query().whereEq("name", "Dup").sole()
        ).rejects.toThrow(MultipleRecordsFoundException);
    });

    it("load() auto-resolves db", async () => {
        await ArModel.create(env.DB, { id: "ld1", name: "Parent" });
        await env.DB.prepare("INSERT INTO ar_tags (id, item_id, label) VALUES (?, ?, ?)").bind("t1", "ld1", "urgent").run();
        const m = await ArModel.find(env.DB, "ld1");
        await m!.load("tags");
        expect((m!.relations.tags as any[]).length).toBe(1);
    });

    it("fresh() auto-resolves db", async () => {
        const m = await ArModel.create(env.DB, { id: "fr1", name: "Original" });
        await env.DB.prepare("UPDATE ar_items SET name = ? WHERE id = ?").bind("Changed", "fr1").run();
        const f = await m.fresh();
        expect(f!.get("name")).toBe("Changed");
        expect(m.get("name")).toBe("Original");
    });

    it("trashed() on soft-delete model", async () => {
        const m = await ArSoftModel.create(env.DB, { id: "tr1", name: "Alive" });
        expect(m.trashed()).toBe(false);
        await m.delete(env.DB);
        expect(m.trashed()).toBe(true);
    });

    it("trashed() on non-soft-delete model always returns false", async () => {
        const m = await ArModel.create(env.DB, { id: "tr2", name: "Hard" });
        expect(m.trashed()).toBe(false);
    });
});
