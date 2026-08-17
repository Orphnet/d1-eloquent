// coverage100.baseModel.test.ts
// Closes the remaining coverage gaps in d1Eloquent/baseModel.ts:
// - key() / setKey() (lines 401-408)
// - pivot sugar success paths attach/detach/sync/toggle (lines 480-519)
// - dynamic() with globalScopes (line 562)
// - createMany: rows-first overload, saving-hook filtering, all-rows-rejected,
//   cache invalidation (lines 697-761)
// - firstOrNew rows-first overload without values (lines 839-850)
// - fireHook / performInsert / performUpdate (lines 948-966)
// - asOf(id, iso) id-first overload (lines 1152-1154)
// - fresh() without a primary key (line 1227)
// - load() fallback return for non-proxied instances (line 1243)
// - revertTo(revision) revision-first overload (lines 1276-1277)

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Schema } from "../../scripts/schema";
import { BaseModel } from "../baseModel";
import { ModelRevision } from "../modelRevision";
import { registerConnection } from "../registry";
import type { THooks } from "../hookTypes";
import type { TRelationDefinition } from "../relationTypes";
import type { CacheAdapter, CacheInvalidationEvent } from "../cacheAdapter";
import type { QueryBuilder } from "../queryBuilder";

// ---- Attribute shapes ----

interface ItemAttrs {
    id?: string;
    name?: string;
    score?: number | null;
}

interface TagAttrs {
    id?: string;
    item_id?: string;
    label?: string;
}

interface UserAttrs {
    id?: string;
    name?: string;
}

interface RoleAttrs {
    id?: string;
    label?: string;
}

interface CmAttrs {
    id?: string;
    name?: string;
    role?: string | null;
}

interface RevAttrs {
    id?: string;
    name?: string;
    created_at?: string;
    updated_at?: string;
}

// ---- Models ----

class C100Item extends BaseModel<ItemAttrs> {
    static table = "c100_items";
    static primaryKey = "id";
    static timestamps = false;
}

class C100Tag extends BaseModel<TagAttrs> {
    static table = "c100_tags";
    static primaryKey = "id";
    static timestamps = false;
}

class C100ItemWithTags extends BaseModel<ItemAttrs> {
    static table = "c100_items";
    static primaryKey = "id";
    static timestamps = false;
    static relations: Record<string, TRelationDefinition> = {
        tags: { type: "hasMany", model: () => C100Tag, foreignKey: "item_id" },
    };
}

class C100User extends BaseModel<UserAttrs> {
    static table = "c100_users";
    static primaryKey = "id";
    static timestamps = false;
    static relations: Record<string, TRelationDefinition> = {
        roles: {
            type: "belongsToMany",
            model: () => C100Role,
            pivot: "c100_user_roles",
            foreignPivotKey: "user_id",
            relatedPivotKey: "role_id",
        },
    };
}

class C100Role extends BaseModel<RoleAttrs> {
    static table = "c100_roles";
    static primaryKey = "id";
    static timestamps = false;
}

class C100CmUser extends BaseModel<CmAttrs> {
    static table = "c100_cm_users";
    static primaryKey = "id";
    static timestamps = false;
}

class C100CmSavingHook extends BaseModel<CmAttrs> {
    static table = "c100_cm_users";
    static primaryKey = "id";
    static timestamps = false;
    static hooks: THooks<C100CmSavingHook> = {
        saving: (m) => {
            if (m.get("role") === "blocked") return false;
        },
    };
}

class C100Hooked extends BaseModel<ItemAttrs> {
    static table = "c100_items";
    static primaryKey = "id";
    static timestamps = false;
    static hooks: THooks<C100Hooked> = {
        creating: (m) => {
            m.set("name", "hooked-name");
        },
        updating: () => false,
    };
}

class C100Exposed extends BaseModel<ItemAttrs> {
    static table = "c100_items";
    static primaryKey = "id";
    static timestamps = false;

    public runInsert(db?: D1Database): Promise<void> {
        return this.performInsert(db);
    }

    public runUpdate(db?: D1Database): Promise<number> {
        return this.performUpdate(db);
    }
}

class C100RevItem extends BaseModel<RevAttrs> {
    static table = "c100_rev_items";
    static primaryKey = "id";
    static timestamps = true;
    static revisions = { enabled: true, mode: "diff+after" as const };
}

// ---- Schema setup ----

beforeAll(async () => {
    // Register the test binding as the default connection so the no-db
    // overloads (rows-first createMany, firstOrNew, asOf, revertTo) resolve.
    registerConnection("default", env.DB);

    const s = new Schema();
    s.dropTable("c100_user_roles");
    s.dropTable("c100_tags");
    s.dropTable("c100_roles");
    s.dropTable("c100_users");
    s.dropTable("c100_items");
    s.dropTable("c100_cm_users");
    s.dropTable("c100_rev_items");

    s.createTable("c100_items", (t) => {
        t.id();
        t.text("name");
        t.integer("score");
    });
    s.createTable("c100_tags", (t) => {
        t.id();
        t.text("item_id").notNull();
        t.text("label").notNull();
    });
    s.createTable("c100_users", (t) => {
        t.id();
        t.text("name").notNull();
    });
    s.createTable("c100_roles", (t) => {
        t.id();
        t.text("label").notNull();
    });
    s.createTable("c100_user_roles", (t) => {
        t.text("user_id").notNull();
        t.text("role_id").notNull();
        t.primary("user_id, role_id");
    });
    s.createTable("c100_cm_users", (t) => {
        t.id();
        t.text("name").notNull();
        t.text("role");
    });
    s.createTable("c100_rev_items", (t) => {
        t.id();
        t.text("name");
        t.timestamps();
    });

    for (const stmt of s.toStatements()) await env.DB.prepare(stmt).run();

    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS model_revisions (
            id TEXT PRIMARY KEY,
            model_table TEXT NOT NULL,
            model_pk TEXT NOT NULL,
            model_id TEXT NOT NULL,
            action TEXT NOT NULL,
            diff_json TEXT,
            before_json TEXT,
            after_json TEXT,
            actor_id TEXT,
            request_id TEXT,
            reason TEXT,
            created_at TEXT NOT NULL
        )
    `).run();

    // Seed shared pivot fixture rows
    await env.DB.prepare("INSERT INTO c100_users (id, name) VALUES (?, ?)").bind("u1", "Alice").run();
    for (const [id, label] of [["r1", "admin"], ["r2", "editor"], ["r3", "viewer"]]) {
        await env.DB.prepare("INSERT INTO c100_roles (id, label) VALUES (?, ?)").bind(id, label).run();
    }
});

beforeEach(async () => {
    await env.DB.prepare("DELETE FROM c100_user_roles").run();
    await env.DB.prepare("DELETE FROM c100_items").run();
    await env.DB.prepare("DELETE FROM c100_tags").run();
    await env.DB.prepare("DELETE FROM c100_cm_users").run();
});

// Persistence flag through the model proxy (see createMany.integration.test.ts idiom)
const persisted = (m: unknown): boolean => {
    const p = m as { $model?: { _persisted: boolean }; _persisted?: boolean };
    return p.$model?._persisted ?? p._persisted ?? false;
};

describe("d1Eloquent/baseModel.ts", () => {
    // ---- key() / setKey() ----

    describe("key() and setKey()", () => {
        it("key() returns the primary key value, and null when unset", () => {
            const m = new C100Item({ id: "k1", name: "n" });
            expect(m.key<string>()).toBe("k1");
            expect(m.key()).toBe(m.getKey());

            const empty = new C100Item({});
            expect(empty.key()).toBeNull();
        });

        it("setKey() writes the primary key attribute and returns this for chaining", () => {
            const m = new C100Item({});
            const ret = m.setKey("k9");
            expect(ret).toBe(m);
            expect(m.getKey<string>()).toBe("k9");
            // setKey goes through set(), so the attribute is dirty like any other write
            expect(m.isDirty("id")).toBe(true);
        });
    });

    // ---- pivot sugar success paths ----

    describe("pivot sugar on the model (attach/detach/sync/toggle)", () => {
        it("attach() on a pivot-backed relation writes pivot rows and returns the insert count", async () => {
            const user = await C100User.findOrFail(env.DB, "u1");
            const n = await user.attach("roles", ["r1", "r2"], { db: env.DB });
            expect(n).toBe(2);

            const rows = await env.DB
                .prepare("SELECT role_id FROM c100_user_roles WHERE user_id = ? ORDER BY role_id")
                .bind("u1")
                .all<{ role_id: string }>();
            expect((rows.results ?? []).map((r) => r.role_id)).toEqual(["r1", "r2"]);
        });

        it("detach() on a pivot-backed relation removes rows and returns the delete count", async () => {
            const user = await C100User.findOrFail(env.DB, "u1");
            await user.attach("roles", ["r1", "r2", "r3"], { db: env.DB });

            const n = await user.detach("roles", "r2", { db: env.DB });
            expect(n).toBe(1);

            const rows = await env.DB
                .prepare("SELECT role_id FROM c100_user_roles WHERE user_id = ? ORDER BY role_id")
                .bind("u1")
                .all<{ role_id: string }>();
            expect((rows.results ?? []).map((r) => r.role_id)).toEqual(["r1", "r3"]);
        });

        it("sync() on a pivot-backed relation reconciles the pivot set", async () => {
            const user = await C100User.findOrFail(env.DB, "u1");
            await user.attach("roles", ["r1", "r2"], { db: env.DB });

            const result = await user.sync("roles", ["r2", "r3"], { db: env.DB });
            expect(result.attached.sort()).toEqual(["r3"]);
            expect(result.detached.sort()).toEqual(["r1"]);

            const rows = await env.DB
                .prepare("SELECT role_id FROM c100_user_roles WHERE user_id = ? ORDER BY role_id")
                .bind("u1")
                .all<{ role_id: string }>();
            expect((rows.results ?? []).map((r) => r.role_id)).toEqual(["r2", "r3"]);
        });

        it("toggle() on a pivot-backed relation flips membership", async () => {
            const user = await C100User.findOrFail(env.DB, "u1");
            await user.attach("roles", ["r1"], { db: env.DB });

            const result = await user.toggle("roles", ["r1", "r3"], { db: env.DB });
            expect(result.attached.sort()).toEqual(["r3"]);
            expect(result.detached).toEqual(["r1"]);

            const rows = await env.DB
                .prepare("SELECT role_id FROM c100_user_roles WHERE user_id = ?")
                .bind("u1")
                .all<{ role_id: string }>();
            expect((rows.results ?? []).map((r) => r.role_id)).toEqual(["r3"]);
        });
    });

    // ---- dynamic() with globalScopes ----

    describe("BaseModel.dynamic() with globalScopes", () => {
        it("installs the global scopes so every query is constrained by default", async () => {
            await env.DB.prepare("INSERT INTO c100_items (id, name, score) VALUES ('d1', 'low', 5)").run();
            await env.DB.prepare("INSERT INTO c100_items (id, name, score) VALUES ('d2', 'high', 15)").run();

            const DynScoped = BaseModel.dynamic<ItemAttrs>({
                table: "c100_items",
                timestamps: false,
                globalScopes: {
                    highScore: (q: QueryBuilder<BaseModel<ItemAttrs>, string>) => {
                        q.where("score", ">=", 10);
                    },
                },
            });

            const scoped = await DynScoped.query().get(env.DB);
            expect(scoped.length).toBe(1);
            expect(scoped[0]!.get("name")).toBe("high");

            const unscoped = await DynScoped.query().withoutGlobalScopes().get(env.DB);
            expect(unscoped.length).toBe(2);
        });
    });

    // ---- createMany gaps ----

    describe("createMany() remaining branches", () => {
        it("rows-first overload (no db) resolves the default connection and inserts", async () => {
            const made = await C100CmUser.createMany([
                { id: "cm1", name: "A" },
                { id: "cm2", name: "B" },
            ]);
            expect(made.length).toBe(2);
            expect(made.map((m) => m.get("id")).sort()).toEqual(["cm1", "cm2"]);

            const count = await C100CmUser.query().count(env.DB);
            expect(count).toBe(2);
        });

        it("rows-first overload with { cache } invalidates once per created row", async () => {
            const events: CacheInvalidationEvent[] = [];
            const cache: CacheAdapter = {
                invalidate: async (e) => {
                    events.push(e);
                },
            };

            const made = await C100CmUser.createMany(
                [
                    { id: "cm3", name: "C" },
                    { id: "cm4", name: "D" },
                ],
                { cache },
            );
            expect(made.length).toBe(2);
            expect(events).toEqual([
                { table: "c100_cm_users", id: "cm3", action: "create" },
                { table: "c100_cm_users", id: "cm4", action: "create" },
            ]);
        });

        it("filters out rows whose saving hook returns false", async () => {
            const made = await C100CmSavingHook.createMany(env.DB, [
                { id: "s1", name: "ok", role: "member" },
                { id: "s2", name: "nope", role: "blocked" },
                { id: "s3", name: "fine", role: "member" },
            ]);
            expect(made.map((m) => m.get("id")).sort()).toEqual(["s1", "s3"]);

            const count = await C100CmSavingHook.query().count(env.DB);
            expect(count).toBe(2);
            const blockedRow = await env.DB
                .prepare("SELECT 1 as x FROM c100_cm_users WHERE id = 's2'")
                .first<{ x: number }>();
            expect(blockedRow).toBeNull();
        });

        it("returns [] and writes nothing when EVERY row is rejected by a hook", async () => {
            const made = await C100CmSavingHook.createMany(env.DB, [
                { id: "s4", name: "no1", role: "blocked" },
                { id: "s5", name: "no2", role: "blocked" },
            ]);
            expect(made).toEqual([]);

            const count = await C100CmSavingHook.query().count(env.DB);
            expect(count).toBe(0);
        });
    });

    // ---- firstOrNew rows-first, no values ----

    describe("firstOrNew() search-first overload without values", () => {
        it("returns an unpersisted instance carrying only the search attrs and writes no row", async () => {
            const m = await C100Item.firstOrNew({ name: "Nobody" });
            expect(m.get("name")).toBe("Nobody");
            expect(m.getKey()).toBeNull();
            expect(persisted(m)).toBe(false);

            const count = await C100Item.query().count(env.DB);
            expect(count).toBe(0);
        });
    });

    // ---- fireHook / performInsert / performUpdate ----

    describe("fireHook()", () => {
        it("runs the registered before-hook (side effect applied) and reports true", async () => {
            const m = new C100Hooked({ id: "h1" });
            const invoke = m as unknown as { fireHook(e: string): Promise<boolean> };
            const ok = await invoke.fireHook("creating");
            expect(ok).toBe(true);
            expect(m.get("name")).toBe("hooked-name");
        });

        it("returns false when the hook cancels", async () => {
            const m = new C100Hooked({ id: "h2" });
            const invoke = m as unknown as { fireHook(e: string): Promise<boolean> };
            const ok = await invoke.fireHook("updating");
            expect(ok).toBe(false);
        });
    });

    describe("performInsert() / performUpdate() via a subclass", () => {
        it("performInsert() writes the raw attribute payload as a new row", async () => {
            const m = new C100Exposed({ id: "pi1", name: "inserted", score: 3 });
            await m.runInsert(env.DB);

            const row = await env.DB
                .prepare("SELECT name, score FROM c100_items WHERE id = ?")
                .bind("pi1")
                .first<{ name: string; score: number }>();
            expect(row?.name).toBe("inserted");
            expect(row?.score).toBe(3);
        });

        it("performUpdate() writes only the dirty attributes and returns the changed count", async () => {
            await env.DB
                .prepare("INSERT INTO c100_items (id, name, score) VALUES ('pu1', 'old', 0)")
                .run();
            const m = new C100Exposed({ id: "pu1", name: "old", score: 0 });
            m.set("name", "new");

            const changed = await m.runUpdate(env.DB);
            expect(changed).toBe(1);

            const row = await env.DB
                .prepare("SELECT name, score FROM c100_items WHERE id = ?")
                .bind("pu1")
                .first<{ name: string; score: number }>();
            expect(row?.name).toBe("new");
            expect(row?.score).toBe(0);
        });
    });

    // ---- asOf(id, iso) without db ----

    describe("asOf() id-first overload (no db)", () => {
        it("time-travels via the default connection", async () => {
            const id = crypto.randomUUID();
            await C100RevItem.create(env.DB, { id, name: "v1" });

            const snap = await C100RevItem.asOf(id, "9999-12-31T23:59:59.999Z");
            expect(snap).not.toBeNull();
            expect(snap!.get("id")).toBe(id);
            expect(snap!.get("name")).toBe("v1");
            expect(persisted(snap)).toBe(true);
        });
    });

    // ---- fresh() without a key ----

    describe("fresh() on an instance without a primary key", () => {
        it("returns null instead of querying", async () => {
            const m = new C100Item({ name: "keyless" });
            const result = await m.fresh(env.DB);
            expect(result).toBeNull();
        });
    });

    // ---- load() fallback return ----

    describe("load() on a never-proxied instance", () => {
        it("returns the raw instance itself (not a proxy) with the relation populated", async () => {
            await env.DB
                .prepare("INSERT INTO c100_items (id, name) VALUES ('li1', 'parent')")
                .run();
            await env.DB
                .prepare("INSERT INTO c100_tags (id, item_id, label) VALUES ('lt1', 'li1', 'one')")
                .run();
            await env.DB
                .prepare("INSERT INTO c100_tags (id, item_id, label) VALUES ('lt2', 'li1', 'two')")
                .run();

            const m = new C100ItemWithTags({ id: "li1", name: "parent" });
            const ret = await m.load(env.DB, "tags");

            // The fallback branch: no proxy was ever created, so load() returns `this`
            expect(ret).toBe(m);

            const tags = (m.relations as { tags?: C100Tag[] }).tags;
            expect(tags?.length).toBe(2);
            expect(tags?.map((t) => t.get("label")).sort()).toEqual(["one", "two"]);
        });
    });

    // ---- revertTo(revision) without db ----

    describe("revertTo() revision-first overload (no db)", () => {
        it("rebuilds the model from the revision snapshot via the default connection", async () => {
            const id = crypto.randomUUID();
            await C100RevItem.create(env.DB, { id, name: "orig" });
            await new Promise((r) => setTimeout(r, 10));
            const found = await C100RevItem.find(env.DB, id);
            found!.set("name", "changed");
            await found!.save(env.DB);

            const revRows = await env.DB
                .prepare(
                    "SELECT * FROM model_revisions WHERE model_id = ? ORDER BY created_at ASC",
                )
                .bind(id)
                .all<Record<string, unknown>>();
            expect(revRows.results.length).toBeGreaterThanOrEqual(2);

            const createRev = new ModelRevision(revRows.results[0] as Partial<never>);
            const reverted = await C100RevItem.revertTo(createRev);

            expect(reverted.get("id")).toBe(id);
            expect(reverted.get("name")).toBe("orig");
            expect(persisted(reverted)).toBe(true);
        });
    });
});
