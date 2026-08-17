// withExistsMinMax.integration.test.ts
// Live D1 tests for withMin / withMax / withExists relation aggregates.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BaseModel } from "../baseModel";
import type { TRelationDefinition } from "../relationTypes";

interface UserAttrs { id?: string; name?: string }
interface OrderAttrs { id?: string; user_id?: string; total?: number }

class WaOrder extends BaseModel<OrderAttrs> {
    static table = "wa_orders";
    static timestamps = false;
}
class WaUser extends BaseModel<UserAttrs> {
    static table = "wa_users";
    static timestamps = false;
    static relations: Record<string, TRelationDefinition> = {
        orders: { type: "hasMany", model: () => WaOrder, foreignKey: "user_id" },
    };
}

beforeAll(async () => {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS wa_users (id TEXT PRIMARY KEY, name TEXT)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS wa_orders (id TEXT PRIMARY KEY, user_id TEXT, total INTEGER)`).run();
});

beforeEach(async () => {
    await env.DB.prepare("DELETE FROM wa_users").run();
    await env.DB.prepare("DELETE FROM wa_orders").run();
    await WaUser.create(env.DB, { id: "u1", name: "has-orders" });
    await WaUser.create(env.DB, { id: "u2", name: "no-orders" });
    await WaOrder.create(env.DB, { id: "o1", user_id: "u1", total: 30 });
    await WaOrder.create(env.DB, { id: "o2", user_id: "u1", total: 70 });
    await WaOrder.create(env.DB, { id: "o3", user_id: "u1", total: 50 });
});

describe("withMin / withMax", () => {
    it("attaches MIN and MAX of a related column", async () => {
        const users = await WaUser.query()
            .withMin("orders", "total")
            .withMax("orders", "total")
            .orderBy("id")
            .get(env.DB);
        const u1 = users.find((u) => u.get("id") === "u1")!;
        expect(u1.get("orders_total_min")).toBe(30);
        expect(u1.get("orders_total_max")).toBe(70);
    });

    it("honours a custom alias", async () => {
        const users = await WaUser.query().withMax("orders", "total", "biggest").whereEq("id", "u1").get(env.DB);
        expect(users[0].get("biggest")).toBe(70);
    });
});

describe("withExists", () => {
    it("attaches a 0/1 existence flag per row", async () => {
        const users = await WaUser.query().withExists("orders").orderBy("id").get(env.DB);
        const u1 = users.find((u) => u.get("id") === "u1")!;
        const u2 = users.find((u) => u.get("id") === "u2")!;
        expect(u1.get("orders_exists")).toBe(1);
        expect(u2.get("orders_exists")).toBe(0);
        expect(Boolean(u2.get("orders_exists"))).toBe(false);
    });

    it("honours a custom alias", async () => {
        const users = await WaUser.query().withExists("orders", "has_orders").whereEq("id", "u1").get(env.DB);
        expect(users[0].get("has_orders")).toBe(1);
    });
});

// ---- #48: withMin / withMax / withExists on relation types OTHER than hasMany ----
// hasMany is exercised above; these cover the distinct subquery code paths for
// belongsTo (owner-side correlation) and belongsToMany (correlation via a pivot join),
// including the zero-rows case (MIN/MAX → null, exists → 0/false).

interface TagAttrs { id?: string; weight?: number }
interface PostAttrs { id?: string; title?: string }

// belongsTo: an order's owning user. Reuses the wa_users / wa_orders tables but
// declares the inverse relation so the belongsTo aggregate path is exercised.
class WaBtOrder extends BaseModel<OrderAttrs> {
    static table = "wa_orders";
    static timestamps = false;
    static relations: Record<string, TRelationDefinition> = {
        buyer: { type: "belongsTo", model: () => WaUser, foreignKey: "user_id", ownerKey: "id" },
    };
}

describe("withMin / withMax / withExists on a belongsTo relation", () => {
    it("resolves the owner's MIN/MAX and existence for a live FK", async () => {
        // o1/o2/o3 all belong to u1 ("has-orders"); a belongsTo owner is a single
        // row, so MIN === MAX === that owner's value, correlated per order row.
        const orders = await WaBtOrder.query()
            .withMin("buyer", "name")
            .withMax("buyer", "name")
            .withExists("buyer")
            .whereEq("id", "o1")
            .get(env.DB);
        const o1 = orders[0];
        expect(o1.get("buyer_name_min")).toBe("has-orders");
        expect(o1.get("buyer_name_max")).toBe("has-orders");
        expect(o1.get("buyer_exists")).toBe(1);
    });

    it("yields null MIN/MAX and 0/false exists for a dangling FK (zero owner rows)", async () => {
        // An order whose user_id references no user → the correlated subquery matches
        // zero rows: MIN/MAX collapse to null and COUNT(*) > 0 is 0, not null.
        await WaBtOrder.create(env.DB, { id: "o_orphan", user_id: "ghost", total: 5 });
        const orders = await WaBtOrder.query()
            .withMin("buyer", "name")
            .withMax("buyer", "name")
            .withExists("buyer")
            .whereEq("id", "o_orphan")
            .get(env.DB);
        const orphan = orders[0];
        expect(orphan.get("buyer_name_min")).toBeNull();
        expect(orphan.get("buyer_name_max")).toBeNull();
        expect(orphan.get("buyer_exists")).toBe(0);
        expect(Boolean(orphan.get("buyer_exists"))).toBe(false);
    });
});

// belongsToMany: posts tagged through a pivot table.
class WaTag extends BaseModel<TagAttrs> {
    static table = "wa_tags";
    static timestamps = false;
}
class WaPost extends BaseModel<PostAttrs> {
    static table = "wa_posts";
    static timestamps = false;
    static relations: Record<string, TRelationDefinition> = {
        tags: {
            type: "belongsToMany",
            model: () => WaTag,
            pivot: "wa_post_tag",
            foreignPivotKey: "post_id",
            relatedPivotKey: "tag_id",
            localKey: "id",
            relatedKey: "id",
        },
    };
}

describe("withMin / withMax / withExists on a belongsToMany (pivot) relation", () => {
    beforeAll(async () => {
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS wa_posts (id TEXT PRIMARY KEY, title TEXT)`).run();
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS wa_tags (id TEXT PRIMARY KEY, weight INTEGER)`).run();
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS wa_post_tag (post_id TEXT, tag_id TEXT)`).run();
    });

    beforeEach(async () => {
        await env.DB.prepare("DELETE FROM wa_posts").run();
        await env.DB.prepare("DELETE FROM wa_tags").run();
        await env.DB.prepare("DELETE FROM wa_post_tag").run();
        await WaPost.create(env.DB, { id: "p1", title: "tagged" });
        await WaPost.create(env.DB, { id: "p2", title: "untagged" });
        await WaTag.create(env.DB, { id: "t1", weight: 10 });
        await WaTag.create(env.DB, { id: "t2", weight: 40 });
        await WaTag.create(env.DB, { id: "t3", weight: 25 });
        // p1 gets three tags (weights 10/40/25); p2 gets none.
        await env.DB.prepare("INSERT INTO wa_post_tag (post_id, tag_id) VALUES (?, ?)").bind("p1", "t1").run();
        await env.DB.prepare("INSERT INTO wa_post_tag (post_id, tag_id) VALUES (?, ?)").bind("p1", "t2").run();
        await env.DB.prepare("INSERT INTO wa_post_tag (post_id, tag_id) VALUES (?, ?)").bind("p1", "t3").run();
    });

    it("aggregates MIN/MAX across the pivot and flags existence", async () => {
        const posts = await WaPost.query()
            .withMin("tags", "weight")
            .withMax("tags", "weight")
            .withExists("tags")
            .orderBy("id")
            .get(env.DB);
        const p1 = posts.find((p) => p.get("id") === "p1")!;
        expect(p1.get("tags_weight_min")).toBe(10);
        expect(p1.get("tags_weight_max")).toBe(40);
        expect(p1.get("tags_exists")).toBe(1);
    });

    it("yields null MIN/MAX and 0/false exists for a post with no pivot rows", async () => {
        const posts = await WaPost.query()
            .withMin("tags", "weight")
            .withMax("tags", "weight")
            .withExists("tags")
            .whereEq("id", "p2")
            .get(env.DB);
        const p2 = posts[0];
        expect(p2.get("tags_weight_min")).toBeNull();
        expect(p2.get("tags_weight_max")).toBeNull();
        // Zero-rows existence must be a concrete 0/false, never null.
        expect(p2.get("tags_exists")).toBe(0);
        expect(Boolean(p2.get("tags_exists"))).toBe(false);
        expect(p2.get("tags_exists")).not.toBeNull();
    });
});
