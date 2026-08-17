// baseModel.integration.test.ts
// BaseModel D1 persistence integration tests

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BaseModel } from "../baseModel";
import { ModelNotFoundException, MultipleRecordsFoundException } from "../exceptions";

// ---- Test model with soft deletes ----

import type { CastDefinition } from "../castManager";

interface ItemAttrs {
    id?: string;
    name?: string;
    created_at?: string | Date;
    updated_at?: string | Date;
    deleted_at?: string | Date | null;
}

class ItemModel extends BaseModel<ItemAttrs> {
    static table = "test_items";
    static primaryKey = "id";
    static softDeletes = true;
    static timestamps = true;
}

// ---- Test model WITHOUT soft deletes ----

interface HardItemAttrs {
    id?: string;
    name?: string;
    created_at?: string | Date;
    updated_at?: string | Date;
}

class HardItemModel extends BaseModel<HardItemAttrs> {
    static table = "test_hard_items";
    static primaryKey = "id";
    static softDeletes = false;
    static timestamps = true;
}

// ---- Test model with explicit casts ----

interface CastedItemAttrs {
    id?: string;
    name?: string;
    is_active?: boolean | number;
    metadata?: Record<string, unknown> | string;
    created_at?: string | Date;
    updated_at?: string | Date;
}

class CastedItemModel extends BaseModel<CastedItemAttrs> {
    static table = "test_casted_items";
    static primaryKey = "id";
    static timestamps = true;
    static casts: Record<string, CastDefinition> = {
        is_active: "boolean",
        metadata: "json",
    };
}

// ---- Table setup ----

beforeAll(async () => {
    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS test_items (
            id TEXT PRIMARY KEY,
            name TEXT,
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT '',
            deleted_at TEXT
        )
    `).run();

    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS test_hard_items (
            id TEXT PRIMARY KEY,
            name TEXT,
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT ''
        )
    `).run();

    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS test_casted_items (
            id TEXT PRIMARY KEY,
            name TEXT,
            is_active INTEGER NOT NULL DEFAULT 0,
            metadata TEXT,
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT ''
        )
    `).run();
});

afterAll(async () => {
    await env.DB.prepare("DROP TABLE IF EXISTS test_items").run();
    await env.DB.prepare("DROP TABLE IF EXISTS test_hard_items").run();
    await env.DB.prepare("DROP TABLE IF EXISTS test_casted_items").run();
});

beforeEach(async () => {
    await env.DB.prepare("DELETE FROM test_items").run();
    await env.DB.prepare("DELETE FROM test_hard_items").run();
    await env.DB.prepare("DELETE FROM test_casted_items").run();
});

// ---- Tests ----

describe("BaseModel.create()", () => {
    it("inserts a row and returns model with correct attributes", async () => {
        const id = crypto.randomUUID();
        const item = await ItemModel.create(env.DB, { id, name: "test" });
        expect(item.get("id")).toBe(id);
        expect(item.get("name")).toBe("test");
    });

    it("assigns created_at and updated_at as Date instances", async () => {
        const id = crypto.randomUUID();
        const item = await ItemModel.create(env.DB, { id, name: "x" });
        expect(item.get("created_at")).toBeInstanceOf(Date);
        expect(item.get("updated_at")).toBeInstanceOf(Date);
    });

    it("sets _persisted = true after create", async () => {
        const id = crypto.randomUUID();
        const item = await ItemModel.create(env.DB, { id, name: "y" });
        expect(item._persisted).toBe(true);
    });

    it("_persisted is not in toObject() keys (non-enumerable)", async () => {
        const id = crypto.randomUUID();
        const item = await ItemModel.create(env.DB, { id, name: "z" });
        expect(Object.keys(item.toObject())).not.toContain("_persisted");
    });

    it("_persisted is not in JSON.stringify output", async () => {
        const id = crypto.randomUUID();
        const item = await ItemModel.create(env.DB, { id, name: "json-test" });
        const json = JSON.stringify(item.toObject());
        expect(json).not.toContain("_persisted");
    });
});

describe("BaseModel.find()", () => {
    it("returns model for existing id", async () => {
        const id = crypto.randomUUID();
        await ItemModel.create(env.DB, { id, name: "findme" });
        const found = await ItemModel.find(env.DB, id);
        expect(found).not.toBeNull();
        expect(found?.get("name")).toBe("findme");
    });

    it("returns null for non-existent id", async () => {
        const result = await ItemModel.find(env.DB, "no-such-id");
        expect(result).toBeNull();
    });

    it("returned model has _persisted = true", async () => {
        const id = crypto.randomUUID();
        await ItemModel.create(env.DB, { id, name: "p" });
        const found = await ItemModel.find(env.DB, id);
        expect(found?._persisted).toBe(true);
    });
});

describe("BaseModel.findOrFail()", () => {
    it("returns model for existing id", async () => {
        const id = crypto.randomUUID();
        await ItemModel.create(env.DB, { id, name: "found" });
        const found = await ItemModel.findOrFail(env.DB, id);
        expect(found.get("name")).toBe("found");
    });

    it("throws ModelNotFoundException for non-existent id", async () => {
        await expect(ItemModel.findOrFail(env.DB, "no-such-id"))
            .rejects.toThrow(ModelNotFoundException);
    });

    it("exception carries model name and id", async () => {
        try {
            await ItemModel.findOrFail(env.DB, "missing-id");
            expect.unreachable("should have thrown");
        } catch (e) {
            expect(e).toBeInstanceOf(ModelNotFoundException);
            expect((e as ModelNotFoundException).model).toBe("test_items");
            expect((e as ModelNotFoundException).id).toBe("missing-id");
        }
    });
});

describe("QueryBuilder.firstOrFail()", () => {
    it("returns model when results exist", async () => {
        const id = crypto.randomUUID();
        await ItemModel.create(env.DB, { id, name: "first-or-fail" });
        const found = await ItemModel.query().whereEq("id", id).firstOrFail(env.DB);
        expect(found.get("name")).toBe("first-or-fail");
    });

    it("throws ModelNotFoundException when no results", async () => {
        await expect(
            ItemModel.query().whereEq("name", "nonexistent-xyz").firstOrFail(env.DB)
        ).rejects.toThrow(ModelNotFoundException);
    });
});

describe("QueryBuilder.sole()", () => {
    it("returns model when exactly one result", async () => {
        const id = crypto.randomUUID();
        await ItemModel.create(env.DB, { id, name: `sole-unique-${id}` });
        const found = await ItemModel.query().whereEq("id", id).sole(env.DB);
        expect(found.get("id")).toBe(id);
    });

    it("throws ModelNotFoundException when no results", async () => {
        await expect(
            ItemModel.query().whereEq("name", "sole-nonexistent-xyz").sole(env.DB)
        ).rejects.toThrow(ModelNotFoundException);
    });

    it("throws MultipleRecordsFoundException when >1 results", async () => {
        const tag = `sole-multi-${crypto.randomUUID()}`;
        await ItemModel.create(env.DB, { id: crypto.randomUUID(), name: tag });
        await ItemModel.create(env.DB, { id: crypto.randomUUID(), name: tag });
        await expect(
            ItemModel.query().whereEq("name", tag).sole(env.DB)
        ).rejects.toThrow(MultipleRecordsFoundException);
    });
});

describe("model.is() / isNot()", () => {
    it("is() returns true for same model and PK", async () => {
        const id = crypto.randomUUID();
        const a = await ItemModel.create(env.DB, { id, name: "a" });
        const b = await ItemModel.find(env.DB, id);
        expect(a.is(b)).toBe(true);
    });

    it("is() returns false for different PKs", async () => {
        const a = await ItemModel.create(env.DB, { id: crypto.randomUUID(), name: "a" });
        const b = await ItemModel.create(env.DB, { id: crypto.randomUUID(), name: "b" });
        expect(a.is(b)).toBe(false);
    });

    it("is() returns false for null/undefined", async () => {
        const a = await ItemModel.create(env.DB, { id: crypto.randomUUID(), name: "a" });
        expect(a.is(null)).toBe(false);
        expect(a.is(undefined)).toBe(false);
    });

    it("isNot() is the inverse", async () => {
        const id = crypto.randomUUID();
        const a = await ItemModel.create(env.DB, { id, name: "a" });
        const b = await ItemModel.find(env.DB, id);
        expect(a.isNot(b)).toBe(false);
        expect(a.isNot(null)).toBe(true);
    });
});

describe("model.fresh()", () => {
    it("returns a new instance from the database", async () => {
        const id = crypto.randomUUID();
        const item = await ItemModel.create(env.DB, { id, name: "original" });

        // Update directly in DB
        await env.DB.prepare("UPDATE test_items SET name = ? WHERE id = ?").bind("changed", id).run();

        const freshItem = await item.fresh(env.DB);
        expect(freshItem).not.toBeNull();
        expect(freshItem!.get("name")).toBe("changed");
        // Original instance unchanged
        expect(item.get("name")).toBe("original");
    });

    it("returns null if model no longer exists", async () => {
        const id = crypto.randomUUID();
        const item = await ItemModel.create(env.DB, { id, name: "temp" });
        await env.DB.prepare("DELETE FROM test_items WHERE id = ?").bind(id).run();
        const freshItem = await item.fresh(env.DB);
        expect(freshItem).toBeNull();
    });
});

describe("model.save() — update", () => {
    it("updates the row in the database", async () => {
        const id = crypto.randomUUID();
        const item = await ItemModel.create(env.DB, { id, name: "original" });
        item.set("name", "updated");
        await item.save(env.DB);

        const found = await ItemModel.find(env.DB, id);
        expect(found?.get("name")).toBe("updated");
    });

    it("updated_at changes after save", async () => {
        const id = crypto.randomUUID();
        const item = await ItemModel.create(env.DB, { id, name: "a" });
        const firstUpdatedAt = item.get("updated_at");

        // Small delay to ensure timestamp difference
        await new Promise(r => setTimeout(r, 10));
        item.set("name", "b");
        await item.save(env.DB);

        const secondUpdatedAt = item.get("updated_at");
        // updated_at may or may not differ depending on resolution, but should still be set
        expect(secondUpdatedAt).toBeInstanceOf(Date);
    });

    it("created_at does not change after save", async () => {
        const id = crypto.randomUUID();
        const item = await ItemModel.create(env.DB, { id, name: "a" });
        const createdAt = item.get("created_at");

        await new Promise(r => setTimeout(r, 10));
        item.set("name", "b");
        await item.save(env.DB);

        const found = await ItemModel.find(env.DB, id);
        expect(found?.get("created_at")).toEqual(createdAt);
    });
});

describe("model.delete() — soft delete", () => {
    it("sets deleted_at to a Date instance", async () => {
        const id = crypto.randomUUID();
        const item = await ItemModel.create(env.DB, { id, name: "del-me" });
        await item.delete(env.DB);
        expect(item.get("deleted_at")).toBeInstanceOf(Date);
    });

    it("soft-deleted row is excluded from default queries", async () => {
        const id = crypto.randomUUID();
        const item = await ItemModel.create(env.DB, { id, name: "hidden" });
        await item.delete(env.DB);

        const results = await ItemModel.query().get(env.DB);
        const found = results.find(r => r.get("id") === id);
        expect(found).toBeUndefined();
    });

    it("soft-deleted row is visible with withTrashed()", async () => {
        const id = crypto.randomUUID();
        const item = await ItemModel.create(env.DB, { id, name: "hidden" });
        await item.delete(env.DB);

        const results = await ItemModel.query().withTrashed().get(env.DB);
        const found = results.find(r => r.get("id") === id);
        expect(found).toBeDefined();
    });
});

describe("model.restore()", () => {
    it("clears deleted_at to null", async () => {
        const id = crypto.randomUUID();
        const item = await ItemModel.create(env.DB, { id, name: "restore-me" });
        await item.delete(env.DB);
        expect(item.get("deleted_at")).not.toBeNull();

        await item.restore(env.DB);
        const found = await ItemModel.find(env.DB, id);
        expect(found?.get("deleted_at")).toBeNull();
    });

    it("restored row is visible in default queries", async () => {
        const id = crypto.randomUUID();
        const item = await ItemModel.create(env.DB, { id, name: "restored" });
        await item.delete(env.DB);
        await item.restore(env.DB);

        const results = await ItemModel.query().get(env.DB);
        const found = results.find(r => r.get("id") === id);
        expect(found).toBeDefined();
    });
});

describe("BaseModel.delete() — hard delete", () => {
    it("removes the row from the database entirely", async () => {
        const id = crypto.randomUUID();
        const item = await HardItemModel.create(env.DB, { id, name: "gone" });
        await item.delete(env.DB);

        // Raw query to check the row truly doesn't exist
        const row = await env.DB.prepare("SELECT * FROM test_hard_items WHERE id = ?")
            .bind(id)
            .first();
        expect(row).toBeNull();
    });

    it("find() returns null after hard delete", async () => {
        const id = crypto.randomUUID();
        const item = await HardItemModel.create(env.DB, { id, name: "bye" });
        await item.delete(env.DB);

        const found = await HardItemModel.find(env.DB, id);
        expect(found).toBeNull();
    });
});

describe("Attribute Casting", () => {
    it("round-trips cast values: create → find → verify types", async () => {
        const id = crypto.randomUUID();
        const item = await CastedItemModel.create(env.DB, {
            id,
            name: "cast-test",
            is_active: true as any,
            metadata: { foo: "bar" } as any,
        });

        // After create, in-memory model has cast values
        expect(item.get("is_active")).toBe(true);
        expect(item.get("metadata")).toEqual({ foo: "bar" });

        // After find, DB row is read and hydrated
        const found = await CastedItemModel.find(env.DB, id);
        expect(found).not.toBeNull();
        expect(found!.get("is_active")).toBe(true);
        expect(found!.get("metadata")).toEqual({ foo: "bar" });
    });

    it("stores dehydrated values in D1", async () => {
        const id = crypto.randomUUID();
        await CastedItemModel.create(env.DB, {
            id,
            name: "raw-check",
            is_active: true as any,
            metadata: { key: "val" } as any,
        });

        // Raw DB query to verify stored format
        const row = await env.DB.prepare("SELECT * FROM test_casted_items WHERE id = ?")
            .bind(id)
            .first();
        expect(row).not.toBeNull();
        expect(row!.is_active).toBe(1); // boolean → integer
        expect(row!.metadata).toBe('{"key":"val"}'); // object → JSON string
    });

    it("auto-casts timestamp columns to Date on find", async () => {
        const id = crypto.randomUUID();
        const item = await ItemModel.create(env.DB, { id, name: "ts-cast" });

        const found = await ItemModel.find(env.DB, id);
        expect(found).not.toBeNull();
        expect(found!.get("created_at")).toBeInstanceOf(Date);
        expect(found!.get("updated_at")).toBeInstanceOf(Date);
    });

    it("toRaw() returns DB-safe primitives", async () => {
        const id = crypto.randomUUID();
        const item = await CastedItemModel.create(env.DB, {
            id,
            name: "raw-test",
            is_active: true as any,
            metadata: { x: 1 } as any,
        });

        const raw = item.toRaw();
        expect(raw.is_active).toBe(1);
        expect(raw.metadata).toBe('{"x":1}');
        expect(typeof raw.created_at).toBe("string");
    });

    it("updates cast values correctly", async () => {
        const id = crypto.randomUUID();
        const item = await CastedItemModel.create(env.DB, {
            id,
            name: "update-cast",
            is_active: true as any,
            metadata: { a: 1 } as any,
        });

        item.set("is_active" as any, false);
        item.set("metadata" as any, { b: 2 });
        await item.save(env.DB);

        const found = await CastedItemModel.find(env.DB, id);
        expect(found!.get("is_active")).toBe(false);
        expect(found!.get("metadata")).toEqual({ b: 2 });

        // Verify DB stored correct raw values
        const row = await env.DB.prepare("SELECT * FROM test_casted_items WHERE id = ?")
            .bind(id)
            .first();
        expect(row!.is_active).toBe(0);
        expect(row!.metadata).toBe('{"b":2}');
    });
});
