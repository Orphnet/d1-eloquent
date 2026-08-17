// dynamicModel.test.ts
// Tests for BaseModel.dynamic(), query(db?), from(), validateDynamicModel(), modelName

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BaseModel } from "../baseModel";
import type { TDynamicModelConfig } from "../baseModel";
import { validateDynamicModel } from "../baseModel";
import type { TModelCtor } from "../types";
import { ModelNotFoundException, MultipleRecordsFoundException, EloquentException } from "../exceptions";
import type { THooks } from "../hookTypes";
import type { CastDefinition } from "../castManager";

// ── Table setup ──────────────────────────────────────────────────────

beforeAll(async () => {
    await env.DB.batch([
        env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS dyn_items (
                id TEXT PRIMARY KEY,
                name TEXT,
                price REAL,
                is_active INTEGER DEFAULT 1,
                metadata TEXT,
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT '',
                deleted_at TEXT
            )
        `),
        env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS dyn_items_archive (
                id TEXT PRIMARY KEY,
                name TEXT,
                price REAL,
                is_active INTEGER DEFAULT 1,
                metadata TEXT,
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT '',
                deleted_at TEXT
            )
        `),
        env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS dyn_categories (
                id TEXT PRIMARY KEY,
                name TEXT,
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT ''
            )
        `),
        env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS dyn_item_categories (
                item_id TEXT NOT NULL,
                category_id TEXT NOT NULL,
                PRIMARY KEY (item_id, category_id)
            )
        `),
        env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS static_users (
                id TEXT PRIMARY KEY,
                name TEXT,
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT ''
            )
        `),
    ]);
});

afterAll(async () => {
    await env.DB.batch([
        env.DB.prepare("DROP TABLE IF EXISTS dyn_item_categories"),
        env.DB.prepare("DROP TABLE IF EXISTS dyn_items"),
        env.DB.prepare("DROP TABLE IF EXISTS dyn_items_archive"),
        env.DB.prepare("DROP TABLE IF EXISTS dyn_categories"),
        env.DB.prepare("DROP TABLE IF EXISTS static_users"),
    ]);
});

beforeEach(async () => {
    await env.DB.batch([
        env.DB.prepare("DELETE FROM dyn_item_categories"),
        env.DB.prepare("DELETE FROM dyn_items"),
        env.DB.prepare("DELETE FROM dyn_items_archive"),
        env.DB.prepare("DELETE FROM dyn_categories"),
        env.DB.prepare("DELETE FROM static_users"),
    ]);
});

// ── Static model for interop tests ───────────────────────────────────

interface UserAttrs {
    id?: string;
    name?: string;
    created_at?: string | Date;
    updated_at?: string | Date;
}

class UserModel extends BaseModel<UserAttrs> {
    static table = "static_users";
    static primaryKey = "id";
    static timestamps = true;
}

// ── Helper ───────────────────────────────────────────────────────────

function uid(): string {
    return crypto.randomUUID();
}

// =====================================================================
// 1. BaseModel.dynamic() basics
// =====================================================================

describe("BaseModel.dynamic() basics", () => {
    it("creates a model class with correct static properties", () => {
        const Item = BaseModel.dynamic({
            table: "dyn_items",
            primaryKey: "id",
            modelName: "Item",
            timestamps: true,
            softDeletes: true,
            fillable: ["id", "name", "price"],
            casts: { price: "real", is_active: "boolean", metadata: "json" },
        });

        expect(Item.table).toBe("dyn_items");
        expect(Item.primaryKey).toBe("id");
        expect(Item.modelName).toBe("Item");
        expect(Item.timestamps).toBe(true);
        expect(Item.softDeletes).toBe(true);
        expect(Item.fillable).toEqual(["id", "name", "price"]);
        expect(Item.casts).toEqual({ price: "real", is_active: "boolean", metadata: "json" });
    });

    it("defaults primaryKey to 'id' when omitted", () => {
        const Item = BaseModel.dynamic({ table: "dyn_items" });
        expect(Item.primaryKey).toBe("id");
    });

    it("preserves BaseModel defaults when config keys are omitted", () => {
        const Item = BaseModel.dynamic({ table: "dyn_items" });
        expect(Item.timestamps).toBe(true); // BaseModel default
        expect(Item.softDeletes).toBe(false); // BaseModel default
    });

    it("returned class is a constructor", () => {
        const Item = BaseModel.dynamic({ table: "dyn_items" });
        const instance = new Item({ id: "abc" });
        expect(instance).toBeInstanceOf(BaseModel);
        expect(instance.get("id")).toBe("abc");
    });

    it("can create independent dynamic models from different configs", () => {
        const A = BaseModel.dynamic({ table: "table_a", softDeletes: true });
        const B = BaseModel.dynamic({ table: "table_b", softDeletes: false });
        expect(A.table).toBe("table_a");
        expect(B.table).toBe("table_b");
        expect(A.softDeletes).toBe(true);
        expect(B.softDeletes).toBe(false);
    });
});

// =====================================================================
// 2. CRUD operations
// =====================================================================

describe("CRUD with dynamic models", () => {
    const Item = BaseModel.dynamic({
        table: "dyn_items",
        softDeletes: true,
        fillable: ["id", "name", "price", "is_active", "metadata"],
        casts: { price: "real", is_active: "boolean", metadata: "json" },
    });

    it("create + find", async () => {
        const id = uid();
        await Item.create(env.DB, { id, name: "Widget", price: 29.99 });

        const found = await Item.find(env.DB, id);
        expect(found).not.toBeNull();
        expect(found!.get("name")).toBe("Widget");
        expect(found!.get("price")).toBe(29.99);
    });

    it("update via set + save", async () => {
        const id = uid();
        const item = await Item.create(env.DB, { id, name: "Old" });

        item.set("name" as any, "New" as any);
        await item.save(env.DB);

        const refreshed = await Item.find(env.DB, id);
        expect(refreshed!.get("name")).toBe("New");
    });

    it("delete (soft)", async () => {
        const id = uid();
        const item = await Item.create(env.DB, { id, name: "ToDelete" });
        await item.delete(env.DB);

        // Default query excludes deleted
        const found = await Item.find(env.DB, id);
        expect(found).toBeNull();

        // withTrashed includes deleted
        const trashed = await Item.query().withTrashed().whereEq("id", id).first(env.DB);
        expect(trashed).not.toBeNull();
    });

    it("findOrFail throws on missing", async () => {
        await expect(Item.findOrFail(env.DB, "nonexistent")).rejects.toThrow(ModelNotFoundException);
    });
});

// =====================================================================
// 3. Query builder
// =====================================================================

describe("Query builder with dynamic models", () => {
    const Item = BaseModel.dynamic({
        table: "dyn_items",
        softDeletes: true,
        fillable: ["id", "name", "price", "is_active", "metadata"],
        casts: { price: "real", is_active: "boolean", metadata: "json" },
    });

    it("where + orderBy + limit", async () => {
        await Item.create(env.DB, { id: uid(), name: "A", price: 10 });
        await Item.create(env.DB, { id: uid(), name: "B", price: 20 });
        await Item.create(env.DB, { id: uid(), name: "C", price: 30 });

        const results = await Item.query()
            .where("price", ">", 10)
            .orderBy("price", "asc")
            .limit(1)
            .get(env.DB);

        expect(results.length).toBe(1);
        expect(results[0].get("name")).toBe("B");
    });

    it("paginate", async () => {
        for (let i = 0; i < 5; i++) {
            await Item.create(env.DB, { id: uid(), name: `Item${i}`, price: i * 10 });
        }

        const page = await Item.query().paginate(env.DB, 1, 2);
        expect(page.data.length).toBe(2);
        expect(page.total).toBe(5);
        expect(page.lastPage).toBe(3);
    });

    it("count", async () => {
        await Item.create(env.DB, { id: uid(), name: "X", price: 1 });
        await Item.create(env.DB, { id: uid(), name: "Y", price: 2 });
        const count = await Item.query().count(env.DB);
        expect(count).toBe(2);
    });
});

// =====================================================================
// 4. Casts (boolean, json, real, datetime)
// =====================================================================

describe("Casts on dynamic models", () => {
    const Item = BaseModel.dynamic({
        table: "dyn_items",
        fillable: ["id", "name", "price", "is_active", "metadata"],
        casts: { price: "real", is_active: "boolean", metadata: "json" },
    });

    it("boolean cast", async () => {
        const id = uid();
        await Item.create(env.DB, { id, name: "BoolTest", is_active: true });

        const found = await Item.find(env.DB, id);
        expect(found!.get("is_active")).toBe(true);
    });

    it("json cast", async () => {
        const id = uid();
        const meta = { color: "red", weight: 42 };
        await Item.create(env.DB, { id, name: "JsonTest", metadata: meta });

        const found = await Item.find(env.DB, id);
        expect(found!.get("metadata")).toEqual(meta);
    });

    it("real/float cast", async () => {
        const id = uid();
        await Item.create(env.DB, { id, name: "RealTest", price: 99.95 });

        const found = await Item.find(env.DB, id);
        expect(found!.get("price")).toBe(99.95);
        expect(typeof found!.get("price")).toBe("number");
    });

    it("datetime auto-casts created_at/updated_at", async () => {
        const id = uid();
        await Item.create(env.DB, { id, name: "DateTest" });

        const found = await Item.find(env.DB, id);
        expect(found!.get("created_at")).toBeInstanceOf(Date);
        expect(found!.get("updated_at")).toBeInstanceOf(Date);
    });
});

// =====================================================================
// 5. Relations (belongsTo / hasMany / eager loading)
// =====================================================================

describe("Relations on dynamic models", () => {
    let Category: TModelCtor<any>;
    let Item: TModelCtor<any>;

    beforeAll(() => {
        Category = BaseModel.dynamic({
            table: "dyn_categories",
            fillable: ["id", "name"],
        });

        Item = BaseModel.dynamic({
            table: "dyn_items",
            softDeletes: true,
            fillable: ["id", "name", "price", "is_active", "metadata"],
            casts: { price: "real", is_active: "boolean" },
            relations: {
                category: {
                    type: "belongsTo",
                    model: () => Category,
                    foreignKey: "metadata", // reusing metadata TEXT column as FK
                },
            },
        });

        // Add hasMany back-reference on Category
        (Category as any).relations = {
            items: {
                type: "hasMany",
                model: () => Item,
                foreignKey: "metadata",
            },
        };
    });

    it("lazy load via related()", async () => {
        const catId = uid();
        await Category.create(env.DB, { id: catId, name: "Electronics" });

        const itemId = uid();
        // metadata column used as FK (stores catId as plain string — no json cast)
        await Item.create(env.DB, { id: itemId, name: "Phone", metadata: catId });

        const item = await Item.find(env.DB, itemId);
        const cat = await item!.related("category").first(env.DB);
        expect(cat).not.toBeNull();
        expect(cat!.get("name")).toBe("Electronics");
    });
});

// =====================================================================
// 6. Soft deletes
// =====================================================================

describe("Soft deletes on dynamic models", () => {
    const Item = BaseModel.dynamic({
        table: "dyn_items",
        softDeletes: true,
        fillable: ["id", "name", "price"],
        casts: { price: "real" },
    });

    it("delete sets deleted_at", async () => {
        const id = uid();
        const item = await Item.create(env.DB, { id, name: "SoftItem" });
        await item.delete(env.DB);

        const trashed = await Item.query().withTrashed().whereEq("id", id).first(env.DB);
        expect(trashed).not.toBeNull();
        expect(trashed!.get("deleted_at")).not.toBeNull();
    });

    it("restore clears deleted_at", async () => {
        const id = uid();
        const item = await Item.create(env.DB, { id, name: "RestoreMe" });
        await item.delete(env.DB);
        await item.restore(env.DB);

        const found = await Item.find(env.DB, id);
        expect(found).not.toBeNull();
        expect(found!.get("deleted_at")).toBeNull();
    });

    it("onlyTrashed returns only deleted", async () => {
        const id1 = uid();
        const id2 = uid();
        await Item.create(env.DB, { id: id1, name: "Alive" });
        const toDelete = await Item.create(env.DB, { id: id2, name: "Dead" });
        await toDelete.delete(env.DB);

        const trashed = await Item.query().onlyTrashed().get(env.DB);
        expect(trashed.length).toBe(1);
        expect(trashed[0].get("name")).toBe("Dead");
    });
});

// =====================================================================
// 7. Hooks
// =====================================================================

describe("Hooks on dynamic models", () => {
    const hookLog: string[] = [];

    const Item = BaseModel.dynamic({
        table: "dyn_items",
        fillable: ["id", "name", "price"],
        hooks: {
            creating: () => { hookLog.push("creating"); },
            created: () => { hookLog.push("created"); },
            updating: () => { hookLog.push("updating"); },
            updated: () => { hookLog.push("updated"); },
            deleting: () => { hookLog.push("deleting"); },
            deleted: () => { hookLog.push("deleted"); },
        } as THooks<any>,
    });

    beforeEach(() => { hookLog.length = 0; });

    it("fires creating + created hooks", async () => {
        await Item.create(env.DB, { id: uid(), name: "Hooked" });
        expect(hookLog).toContain("creating");
        expect(hookLog).toContain("created");
    });

    it("fires updating + updated hooks", async () => {
        const id = uid();
        const item = await Item.create(env.DB, { id, name: "Before" });
        hookLog.length = 0;

        item.set("name" as any, "After" as any);
        await item.save(env.DB);

        expect(hookLog).toContain("updating");
        expect(hookLog).toContain("updated");
    });

    it("fires deleting + deleted hooks", async () => {
        const id = uid();
        const item = await Item.create(env.DB, { id, name: "Deletable" });
        hookLog.length = 0;

        await item.delete(env.DB);
        expect(hookLog).toContain("deleting");
        expect(hookLog).toContain("deleted");
    });
});

// =====================================================================
// 8. Scopes
// =====================================================================

describe("Scopes on dynamic models", () => {
    const Item = BaseModel.dynamic({
        table: "dyn_items",
        fillable: ["id", "name", "price", "is_active"],
        casts: { price: "real", is_active: "boolean" },
        scopes: {
            active: (q) => q.whereEq("is_active", 1),
            expensive: (q) => q.where("price", ">", 50),
        },
    });

    it("applies a named scope", async () => {
        await Item.create(env.DB, { id: uid(), name: "Cheap Active", price: 10, is_active: true });
        await Item.create(env.DB, { id: uid(), name: "Expensive Active", price: 100, is_active: true });
        await Item.create(env.DB, { id: uid(), name: "Expensive Inactive", price: 100, is_active: false });

        const results = await Item.query().scoped("active", "expensive").get(env.DB);
        expect(results.length).toBe(1);
        expect(results[0].get("name")).toBe("Expensive Active");
    });
});

// =====================================================================
// 9. query(db) propagation
// =====================================================================

describe("query(db) propagation", () => {
    const Item = BaseModel.dynamic({
        table: "dyn_items",
        fillable: ["id", "name", "price"],
        casts: { price: "real" },
    });

    it("get() works without explicit db when set via query(db)", async () => {
        await Item.create(env.DB, { id: uid(), name: "PropTest", price: 5 });

        const results = await Item.query(env.DB).get();
        expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("first() works without explicit db", async () => {
        const id = uid();
        await Item.create(env.DB, { id, name: "FirstTest" });

        const found = await Item.query(env.DB).whereEq("id", id).first();
        expect(found).not.toBeNull();
        expect(found!.get("name")).toBe("FirstTest");
    });

    it("firstOrFail() works without explicit db", async () => {
        const id = uid();
        await Item.create(env.DB, { id, name: "FailTest" });

        const found = await Item.query(env.DB).whereEq("id", id).firstOrFail();
        expect(found.get("name")).toBe("FailTest");
    });

    it("explicit db at terminal call takes priority over query(db)", async () => {
        const id = uid();
        await Item.create(env.DB, { id, name: "Priority" });

        // Both db args point to same db in tests, but verifies the code path works
        const found = await Item.query(env.DB).whereEq("id", id).first(env.DB);
        expect(found).not.toBeNull();
    });

    it("paginate works with query(db)", async () => {
        for (let i = 0; i < 3; i++) {
            await Item.create(env.DB, { id: uid(), name: `Page${i}` });
        }
        const page = await Item.query(env.DB).paginate(1, 2);
        expect(page.data.length).toBe(2);
        expect(page.total).toBe(3);
    });

    it("count works with query(db)", async () => {
        await Item.create(env.DB, { id: uid(), name: "CountA" });
        await Item.create(env.DB, { id: uid(), name: "CountB" });
        const count = await Item.query(env.DB).count();
        expect(count).toBe(2);
    });
});

// =====================================================================
// 10. from() table override
// =====================================================================

describe("from() table override", () => {
    const Item = BaseModel.dynamic({
        table: "dyn_items",
        fillable: ["id", "name", "price"],
        casts: { price: "real" },
    });

    it("queries the overridden table", async () => {
        // Insert into archive table directly
        const id = uid();
        await env.DB.prepare(
            "INSERT INTO dyn_items_archive (id, name, price, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
        ).bind(id, "Archived", 42, new Date().toISOString(), new Date().toISOString()).run();

        // Main table should be empty
        const mainCount = await Item.query(env.DB).count();
        expect(mainCount).toBe(0);

        // from() override reads archive
        const archived = await Item.query(env.DB).from("dyn_items_archive").get();
        expect(archived.length).toBe(1);
        expect(archived[0].get("name")).toBe("Archived");
    });

    it("from() does not affect subsequent queries on the same model", async () => {
        const id = uid();
        await Item.create(env.DB, { id, name: "Main" });

        // This query uses archive
        await Item.query(env.DB).from("dyn_items_archive").get();

        // Fresh query should use main table
        const main = await Item.query(env.DB).get();
        expect(main.length).toBe(1);
        expect(main[0].get("name")).toBe("Main");
    });
});

// =====================================================================
// 11. validateDynamicModel()
// =====================================================================

describe("validateDynamicModel()", () => {
    it("passes for a valid dynamic model", () => {
        const Item = BaseModel.dynamic({ table: "dyn_items" });
        expect(() => validateDynamicModel(Item)).not.toThrow();
    });

    it("throws on null/undefined", () => {
        expect(() => validateDynamicModel(null)).toThrow(EloquentException);
        expect(() => validateDynamicModel(undefined)).toThrow(EloquentException);
    });

    it("throws on non-function", () => {
        expect(() => validateDynamicModel({ table: "x", primaryKey: "id" })).toThrow("expected a class constructor");
    });

    it("throws on missing table", () => {
        class Bad extends BaseModel {}
        expect(() => validateDynamicModel(Bad)).toThrow("missing required static property 'table'");
    });

    it("throws on empty table string", () => {
        const Bad = class extends BaseModel {
            static table = "";
            static primaryKey = "id";
        };
        expect(() => validateDynamicModel(Bad)).toThrow("missing required static property 'table'");
    });

    it("throws on missing primaryKey", () => {
        const Bad = class extends BaseModel {
            static table = "x";
            static primaryKey = "";
        };
        expect(() => validateDynamicModel(Bad)).toThrow("missing required static property 'primaryKey'");
    });

    it("validates manually-constructed model classes", () => {
        class ManualModel extends BaseModel {
            static table = "manual_table";
            static primaryKey = "id";
        }
        expect(() => validateDynamicModel(ManualModel)).not.toThrow();
    });
});

// =====================================================================
// 12. modelName in error messages
// =====================================================================

describe("modelName in error messages", () => {
    const Item = BaseModel.dynamic({
        table: "dyn_items",
        modelName: "Item",
        fillable: ["id", "name"],
    });

    it("firstOrFail uses modelName", async () => {
        try {
            await Item.query(env.DB).whereEq("id", "nonexistent").firstOrFail();
            expect.unreachable("Should have thrown");
        } catch (e: any) {
            expect(e).toBeInstanceOf(ModelNotFoundException);
            expect(e.message).toContain("Item");
            expect(e.model).toBe("Item");
        }
    });

    it("Model.findOrFail (static path) uses modelName", async () => {
        // Regression: static findOrFail previously hard-coded this.table
        // when constructing ModelNotFoundException, ignoring modelName.
        try {
            await Item.findOrFail(env.DB, "nonexistent");
            expect.unreachable("Should have thrown");
        } catch (e: any) {
            expect(e).toBeInstanceOf(ModelNotFoundException);
            expect(e.model).toBe("Item");
        }
    });

    it("sole uses modelName when no results", async () => {
        try {
            await Item.query(env.DB).whereEq("id", "nonexistent").sole();
            expect.unreachable("Should have thrown");
        } catch (e: any) {
            expect(e).toBeInstanceOf(ModelNotFoundException);
            expect(e.model).toBe("Item");
        }
    });

    it("sole uses modelName when multiple results", async () => {
        await Item.create(env.DB, { id: uid(), name: "A" });
        await Item.create(env.DB, { id: uid(), name: "B" });

        try {
            await Item.query(env.DB).sole();
            expect.unreachable("Should have thrown");
        } catch (e: any) {
            expect(e).toBeInstanceOf(MultipleRecordsFoundException);
            expect(e.model).toBe("Item");
        }
    });

    it("falls back to table when modelName not set", async () => {
        const NoName = BaseModel.dynamic({
            table: "dyn_items",
            fillable: ["id", "name"],
        });

        try {
            await NoName.query(env.DB).whereEq("id", "nonexistent").firstOrFail();
            expect.unreachable("Should have thrown");
        } catch (e: any) {
            expect(e).toBeInstanceOf(ModelNotFoundException);
            expect(e.model).toBe("dyn_items");
        }
    });
});

// =====================================================================
// 13. Fillable / guarded
// =====================================================================

describe("Fillable/guarded on dynamic models", () => {
    it("fillable restricts mass assignment", async () => {
        const Item = BaseModel.dynamic({
            table: "dyn_items",
            fillable: ["id", "name"],
            casts: { price: "real" },
        });

        const id = uid();
        await Item.create(env.DB, { id, name: "Allowed", price: 999 });

        // price should not have been filled (not in fillable)
        const found = await Item.find(env.DB, id);
        expect(found!.get("name")).toBe("Allowed");
        // price not in fillable → should not be set via fill
        expect(found!.get("price")).toBeFalsy();
    });

    it("guarded blocks specific fields", async () => {
        const Item = BaseModel.dynamic({
            table: "dyn_items",
            guarded: ["price"],
            casts: { price: "real" },
        });

        const id = uid();
        await Item.create(env.DB, { id, name: "GuardTest", price: 999 });

        const found = await Item.find(env.DB, id);
        expect(found!.get("name")).toBe("GuardTest");
        // price is guarded → should not be set via fill
        expect(found!.get("price")).toBeFalsy();
    });
});

// =====================================================================
// 14. Interaction with static models
// =====================================================================

describe("Dynamic + static model interop", () => {
    it("both can coexist and query independently", async () => {
        const DynItem = BaseModel.dynamic({
            table: "dyn_items",
            fillable: ["id", "name"],
        });

        const userId = uid();
        const itemId = uid();

        await UserModel.create(env.DB, { id: userId, name: "Alice" });
        await DynItem.create(env.DB, { id: itemId, name: "Widget" });

        const user = await UserModel.find(env.DB, userId);
        const item = await DynItem.find(env.DB, itemId);

        expect(user).not.toBeNull();
        expect(item).not.toBeNull();
        expect(user!.get("name")).toBe("Alice");
        expect(item!.get("name")).toBe("Widget");
    });

    it("dynamic model instances are not instanceof static model", () => {
        const DynItem = BaseModel.dynamic({ table: "dyn_items" });
        const dyn = new DynItem({ id: "x" });
        expect(dyn).toBeInstanceOf(BaseModel);
        expect(dyn).not.toBeInstanceOf(UserModel);
    });
});

// =====================================================================
// Additional: 'real' cast alias
// =====================================================================

describe("'real' cast alias", () => {
    it("'real' behaves like 'float'", () => {
        const Item = BaseModel.dynamic({
            table: "dyn_items",
            casts: { price: "real" },
        });

        const instance = new Item({ price: "42.5" as any });
        expect(instance.get("price")).toBe(42.5);
        expect(typeof instance.get("price")).toBe("number");
    });
});

// =====================================================================
// Additional: dynamic() auto-validation
// =====================================================================

describe("dynamic() auto-validates", () => {
    it("throws on empty table", () => {
        expect(() => BaseModel.dynamic({ table: "" })).toThrow("missing required static property 'table'");
    });
});
