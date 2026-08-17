// hasThrough.integration.test.ts
// Live D1 tests for hasManyThrough / hasOneThrough relations.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BaseModel } from "../baseModel";
import type { TRelationDefinition } from "../relationTypes";

interface CountryAttrs { id?: string; name?: string }
interface UserAttrs { id?: string; country_id?: string; name?: string }
interface PostAttrs { id?: string; user_id?: string; title?: string }

class HtUser extends BaseModel<UserAttrs> {
    static table = "ht_users";
    static timestamps = false;
}
class HtPost extends BaseModel<PostAttrs> {
    static table = "ht_posts";
    static timestamps = false;
}
class HtCountry extends BaseModel<CountryAttrs> {
    static table = "ht_countries";
    static timestamps = false;
    static relations: Record<string, TRelationDefinition> = {
        posts: {
            type: "hasManyThrough",
            model: () => HtPost,
            through: () => HtUser,
            firstKey: "country_id", // ht_users.country_id -> country
            secondKey: "user_id", // ht_posts.user_id -> user
        },
        latestPost: {
            type: "hasOneThrough",
            model: () => HtPost,
            through: () => HtUser,
            firstKey: "country_id",
            secondKey: "user_id",
        },
    };
}

beforeAll(async () => {
    for (const sql of [
        `CREATE TABLE IF NOT EXISTS ht_countries (id TEXT PRIMARY KEY, name TEXT)`,
        `CREATE TABLE IF NOT EXISTS ht_users (id TEXT PRIMARY KEY, country_id TEXT, name TEXT)`,
        `CREATE TABLE IF NOT EXISTS ht_posts (id TEXT PRIMARY KEY, user_id TEXT, title TEXT)`,
    ]) await env.DB.prepare(sql).run();
});

beforeEach(async () => {
    for (const t of ["ht_countries", "ht_users", "ht_posts"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
    await HtCountry.create(env.DB, { id: "c1", name: "US" });
    await HtCountry.create(env.DB, { id: "c2", name: "UK" });
    await HtUser.create(env.DB, { id: "u1", country_id: "c1", name: "a" });
    await HtUser.create(env.DB, { id: "u2", country_id: "c1", name: "b" });
    await HtUser.create(env.DB, { id: "u3", country_id: "c2", name: "c" });
    await HtPost.create(env.DB, { id: "p1", user_id: "u1", title: "P1" });
    await HtPost.create(env.DB, { id: "p2", user_id: "u1", title: "P2" });
    await HtPost.create(env.DB, { id: "p3", user_id: "u2", title: "P3" });
    await HtPost.create(env.DB, { id: "p4", user_id: "u3", title: "P4" });
    // c2 (UK) also gets a user with no posts, to test empty groups
    await HtUser.create(env.DB, { id: "u4", country_id: "c2", name: "d" });
});

const ids = (rows: HtPost[]) => rows.map((r) => r.get("id")).sort();

describe("hasManyThrough", () => {
    it("eager-loads posts through the intermediate users, grouped per parent", async () => {
        const countries = await HtCountry.query().with(["posts"]).orderBy("id").get(env.DB);
        const c1 = countries.find((c) => c.get("id") === "c1")!;
        const c2 = countries.find((c) => c.get("id") === "c2")!;
        expect(ids(c1.relations.posts as HtPost[])).toEqual(["p1", "p2", "p3"]); // via u1, u2
        expect(ids(c2.relations.posts as HtPost[])).toEqual(["p4"]); // via u3
    });

    it("lazy-loads via related()", async () => {
        const c1 = await HtCountry.find(env.DB, "c1");
        const posts = (await c1!.related("posts").get(env.DB)) as HtPost[];
        expect(ids(posts)).toEqual(["p1", "p2", "p3"]);
    });

    it("supports whereHas across the through chain", async () => {
        const countries = await HtCountry.query()
            .whereHas("posts", (q) => q.where("title", "=", "P4"))
            .get(env.DB);
        expect(countries.map((c) => c.get("id"))).toEqual(["c2"]); // only UK has post P4
    });

    it("supports withCount over the through relation", async () => {
        const countries = await HtCountry.query().withCount("posts").orderBy("id").get(env.DB);
        const c1 = countries.find((c) => c.get("id") === "c1")!;
        const c2 = countries.find((c) => c.get("id") === "c2")!;
        expect(c1.get("posts_count")).toBe(3);
        expect(c2.get("posts_count")).toBe(1);
    });

    // Regression (#46 × #52): the object-map with() constraint must reach the
    // through-relation loader. Before the fix its closure ignored the constraint
    // argument, so `with({ posts: cb })` silently returned every post.
    it("applies with() object-map constraints to the through relation", async () => {
        const countries = await HtCountry.query()
            .with({ posts: (q) => q.where("title", "=", "P1") })
            .whereEq("id", "c1")
            .get(env.DB);
        expect(ids(countries[0].relations.posts as HtPost[])).toEqual(["p1"]);
    });
});

describe("hasOneThrough", () => {
    it("eager-loads a single post through the chain", async () => {
        const countries = await HtCountry.query().with(["latestPost"]).whereEq("id", "c1").get(env.DB);
        const post = countries[0].relations.latestPost as HtPost | null;
        expect(post).not.toBeNull();
        expect(["p1", "p2", "p3"]).toContain(post!.get("id"));
    });

    it("is null for a parent with no through-rows", async () => {
        await HtCountry.create(env.DB, { id: "c3", name: "empty" });
        const countries = await HtCountry.query().with(["latestPost"]).whereEq("id", "c3").get(env.DB);
        expect(countries[0].relations.latestPost).toBeNull();
    });
});

// ── Regression: soft-deletes on BOTH related and through models ──────────
// Both hts_posts and hts_users carry `deleted_at`; the joined soft-delete scope
// must qualify to the related table (`hts_posts.deleted_at`) or SQLite throws
// `ambiguous column name: deleted_at`.
interface HtsPostAttrs { id?: string; user_id?: string; title?: string; deleted_at?: string | null }
interface HtsUserAttrs { id?: string; country_id?: string; deleted_at?: string | null }

class HtsUser extends BaseModel<HtsUserAttrs> {
    static table = "hts_users";
    static timestamps = false;
    static softDeletes = true;
}
class HtsPost extends BaseModel<HtsPostAttrs> {
    static table = "hts_posts";
    static timestamps = false;
    static softDeletes = true;
}
class HtsCountry extends BaseModel<{ id?: string }> {
    static table = "hts_countries";
    static timestamps = false;
    static relations: Record<string, TRelationDefinition> = {
        posts: { type: "hasManyThrough", model: () => HtsPost, through: () => HtsUser, firstKey: "country_id", secondKey: "user_id" },
    };
}

describe("hasManyThrough — soft-deletes on both related and through models", () => {
    beforeEach(async () => {
        for (const sql of [
            `CREATE TABLE IF NOT EXISTS hts_countries (id TEXT PRIMARY KEY)`,
            `CREATE TABLE IF NOT EXISTS hts_users (id TEXT PRIMARY KEY, country_id TEXT, deleted_at TEXT)`,
            `CREATE TABLE IF NOT EXISTS hts_posts (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, deleted_at TEXT)`,
        ]) await env.DB.prepare(sql).run();
        for (const t of ["hts_countries", "hts_users", "hts_posts"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
        await HtsCountry.create(env.DB, { id: "c1" });
        await HtsUser.create(env.DB, { id: "u1", country_id: "c1" });
        await HtsPost.create(env.DB, { id: "p1", user_id: "u1", title: "live" });
        await HtsPost.create(env.DB, { id: "p2", user_id: "u1", title: "dead" });
    });

    it("with(['posts']) does not throw ambiguous column, and excludes soft-deleted posts", async () => {
        await (await HtsPost.find(env.DB, "p2"))!.delete(env.DB); // soft-delete p2
        const countries = await HtsCountry.query().with(["posts"]).get(env.DB);
        expect((countries[0].relations.posts as HtsPost[]).map((p) => p.get("id"))).toEqual(["p1"]);
    });

    it("whereHas('posts') and withCount('posts') do not throw ambiguous column", async () => {
        const has = await HtsCountry.query().whereHas("posts").get(env.DB);
        expect(has.map((c) => c.get("id"))).toEqual(["c1"]);
        const counted = await HtsCountry.query().withCount("posts").get(env.DB);
        expect(counted[0].get("posts_count")).toBe(2);
    });

    // Regression (#52): a soft-deleted THROUGH row must hide its children from
    // every read path — eager, lazy, whereHas, and withCount. Before the fix the
    // through model's `deleted_at` scope was never added to the join, so posts of
    // a trashed user leaked (and withCount over-counted).
    it("excludes children of a soft-deleted THROUGH row across all read paths", async () => {
        await (await HtsUser.find(env.DB, "u1"))!.delete(env.DB); // soft-delete the through user (owns p1+p2)

        const eager = await HtsCountry.query().with(["posts"]).withCount("posts").get(env.DB);
        expect((eager[0].relations.posts as HtsPost[]).map((p) => p.get("id"))).toEqual([]);
        expect(eager[0].get("posts_count")).toBe(0);

        const c1 = await HtsCountry.find(env.DB, "c1");
        expect(((await c1!.related("posts").get(env.DB)) as HtsPost[]).map((p) => p.get("id"))).toEqual([]);

        const has = await HtsCountry.query().whereHas("posts").get(env.DB);
        expect(has.map((c) => c.get("id"))).toEqual([]);
    });
});

// ── #52: custom localKey / secondLocalKey on a through relation ──────────
// A hasManyThrough / hasOneThrough whose parent key (`localKey`) and through key
// (`secondLocalKey`) are NOT the PK. Exercises the `def.localKey ?? primaryKey`
// and `def.secondLocalKey ?? through.primaryKey` override branches on every path
// (eager + lazy, many + one). The row `id`s are deliberately distinct from the
// `code`/`sku` join values, so a regression that fell back to the PK default
// would join/filter on the wrong column and resolve nothing — making the test
// fail rather than pass silently.
interface HtcMakerAttrs { id?: string; code?: string; name?: string }
interface HtcWidgetAttrs { id?: string; maker_code?: string; sku?: string }
interface HtcPartAttrs { id?: string; widget_sku?: string; name?: string; price?: number }

class HtcWidget extends BaseModel<HtcWidgetAttrs> {
    static table = "htc_widgets";
    static timestamps = false;
}
class HtcPart extends BaseModel<HtcPartAttrs> {
    static table = "htc_parts";
    static timestamps = false;
}
class HtcMaker extends BaseModel<HtcMakerAttrs> {
    static table = "htc_makers";
    static timestamps = false;
    static relations: Record<string, TRelationDefinition> = {
        // parent key = htc_makers.code (NOT id); through key = htc_widgets.sku (NOT id)
        parts: {
            type: "hasManyThrough",
            model: () => HtcPart,
            through: () => HtcWidget,
            firstKey: "maker_code", // htc_widgets.maker_code -> maker
            secondKey: "widget_sku", // htc_parts.widget_sku -> widget
            localKey: "code",
            secondLocalKey: "sku",
        },
        firstPart: {
            type: "hasOneThrough",
            model: () => HtcPart,
            through: () => HtcWidget,
            firstKey: "maker_code",
            secondKey: "widget_sku",
            localKey: "code",
            secondLocalKey: "sku",
        },
    };
}

describe("hasManyThrough / hasOneThrough — custom localKey & secondLocalKey (#52)", () => {
    beforeEach(async () => {
        for (const sql of [
            `CREATE TABLE IF NOT EXISTS htc_makers (id TEXT PRIMARY KEY, code TEXT, name TEXT)`,
            `CREATE TABLE IF NOT EXISTS htc_widgets (id TEXT PRIMARY KEY, maker_code TEXT, sku TEXT)`,
            `CREATE TABLE IF NOT EXISTS htc_parts (id TEXT PRIMARY KEY, widget_sku TEXT, name TEXT, price INTEGER)`,
        ]) await env.DB.prepare(sql).run();
        for (const t of ["htc_makers", "htc_widgets", "htc_parts"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
        // ids intentionally differ from code/sku, so the PK-fallback path can't accidentally match
        await HtcMaker.create(env.DB, { id: "mk1", code: "MK-A", name: "Acme" });
        await HtcMaker.create(env.DB, { id: "mk2", code: "MK-B", name: "Beta" });
        await HtcWidget.create(env.DB, { id: "wg1", maker_code: "MK-A", sku: "SKU1" });
        await HtcWidget.create(env.DB, { id: "wg2", maker_code: "MK-A", sku: "SKU2" });
        await HtcWidget.create(env.DB, { id: "wg3", maker_code: "MK-B", sku: "SKU3" });
        await HtcPart.create(env.DB, { id: "pt1", widget_sku: "SKU1", name: "P1", price: 5 });
        await HtcPart.create(env.DB, { id: "pt2", widget_sku: "SKU1", name: "P2", price: 15 });
        await HtcPart.create(env.DB, { id: "pt3", widget_sku: "SKU2", name: "P3", price: 25 });
        await HtcPart.create(env.DB, { id: "pt4", widget_sku: "SKU3", name: "P4", price: 100 });
    });

    const partIds = (rows: HtcPart[]) => rows.map((r) => r.get("id")).sort();

    it("eager-loads hasManyThrough via the custom local/second-local keys", async () => {
        const makers = await HtcMaker.query().with(["parts"]).orderBy("id").get(env.DB);
        const mk1 = makers.find((m) => m.get("id") === "mk1")!;
        const mk2 = makers.find((m) => m.get("id") === "mk2")!;
        expect(partIds(mk1.relations.parts as HtcPart[])).toEqual(["pt1", "pt2", "pt3"]); // via SKU1, SKU2
        expect(partIds(mk2.relations.parts as HtcPart[])).toEqual(["pt4"]); // via SKU3
    });

    it("lazy-loads hasManyThrough via related() with custom keys", async () => {
        const mk1 = await HtcMaker.find(env.DB, "mk1");
        const parts = (await mk1!.related("parts").get(env.DB)) as HtcPart[];
        expect(partIds(parts)).toEqual(["pt1", "pt2", "pt3"]);
    });

    it("eager-loads hasOneThrough via the custom keys (single, non-null)", async () => {
        const makers = await HtcMaker.query().with(["firstPart"]).orderBy("id").get(env.DB);
        const mk1 = makers.find((m) => m.get("id") === "mk1")!;
        const mk2 = makers.find((m) => m.get("id") === "mk2")!;
        const p1 = mk1.relations.firstPart as HtcPart | null;
        expect(p1).not.toBeNull();
        expect(["pt1", "pt2", "pt3"]).toContain(p1!.get("id")); // any of MK-A's parts
        expect((mk2.relations.firstPart as HtcPart).get("id")).toBe("pt4"); // MK-B's only part
    });

    it("lazy-loads hasOneThrough via related().first() with custom keys", async () => {
        const mk2 = await HtcMaker.find(env.DB, "mk2");
        const part = (await mk2!.related("firstPart").first(env.DB)) as HtcPart | null;
        expect(part).not.toBeNull();
        expect(part!.get("id")).toBe("pt4");
    });
});

// ── #52: withSum / withAvg over a through relation ───────────────────────
// Previously only withCount was covered. HtPost carries no numeric column, so a
// numeric leaf (ht_sales) is hung off the REUSED ht_countries/ht_users chain
// (both seeded by the file-level beforeEach) to give the aggregates real values.
interface HtSaleAttrs { id?: string; user_id?: string; amount?: number }
class HtSale extends BaseModel<HtSaleAttrs> {
    static table = "ht_sales";
    static timestamps = false;
}
class HtSaleCountry extends BaseModel<CountryAttrs> {
    static table = "ht_countries"; // reuses the ht_countries rows (c1, c2) seeded above
    static timestamps = false;
    static relations: Record<string, TRelationDefinition> = {
        sales: {
            type: "hasManyThrough",
            model: () => HtSale,
            through: () => HtUser,
            firstKey: "country_id", // ht_users.country_id -> country
            secondKey: "user_id", // ht_sales.user_id -> user
        },
    };
}

describe("hasManyThrough — withSum / withAvg over the through relation (#52)", () => {
    beforeEach(async () => {
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ht_sales (id TEXT PRIMARY KEY, user_id TEXT, amount INTEGER)`).run();
        await env.DB.prepare(`DELETE FROM ht_sales`).run();
        // Reuse the ht_users seeded by the file-level beforeEach: u1,u2 -> c1 ; u3,u4 -> c2
        await HtSale.create(env.DB, { id: "s1", user_id: "u1", amount: 10 });
        await HtSale.create(env.DB, { id: "s2", user_id: "u1", amount: 20 });
        await HtSale.create(env.DB, { id: "s3", user_id: "u2", amount: 30 });
        await HtSale.create(env.DB, { id: "s4", user_id: "u3", amount: 40 });
        // u4 (c2) has no sales — contributes nothing to c2's aggregates
    });

    it("withSum aggregates a related column across the through chain", async () => {
        const countries = await HtSaleCountry.query().withSum("sales", "amount").orderBy("id").get(env.DB);
        const c1 = countries.find((c) => c.get("id") === "c1")!;
        const c2 = countries.find((c) => c.get("id") === "c2")!;
        expect(c1.get("sales_amount_sum")).toBe(60); // 10 + 20 (u1) + 30 (u2)
        expect(c2.get("sales_amount_sum")).toBe(40); // 40 (u3)
    });

    it("withAvg averages a related column across the through chain", async () => {
        const countries = await HtSaleCountry.query().withAvg("sales", "amount").orderBy("id").get(env.DB);
        const c1 = countries.find((c) => c.get("id") === "c1")!;
        const c2 = countries.find((c) => c.get("id") === "c2")!;
        expect(c1.get("sales_amount_avg")).toBe(20); // (10 + 20 + 30) / 3
        expect(c2.get("sales_amount_avg")).toBe(40); // 40 / 1
    });
});

// ── #52: has() / doesntHave() over a through relation ────────────────────
// Previously only whereHas was covered. Reuses the file-level
// ht_countries/ht_users/ht_posts fixtures. Two extra parents are added per test:
// c3 (no through-user at all) and c4 (a through-user but zero posts) — both must
// be treated as "no posts" so the EXISTS/NOT-EXISTS join is proven to hinge on a
// real related row, not merely a through-row.
describe("hasManyThrough — has() / doesntHave() over the through relation (#52)", () => {
    beforeEach(async () => {
        await HtCountry.create(env.DB, { id: "c3", name: "no-users" });
        await HtCountry.create(env.DB, { id: "c4", name: "childless-user" });
        await HtUser.create(env.DB, { id: "u5", country_id: "c4", name: "e" }); // user, but no posts
    });

    it("has() keeps only parents with at least one row through the chain", async () => {
        const countries = await HtCountry.query().has("posts").orderBy("id").get(env.DB);
        // c1/c2 own posts; c3 (no user) and c4 (childless user) are excluded
        expect(countries.map((c) => c.get("id"))).toEqual(["c1", "c2"]);
    });

    it("doesntHave() keeps only parents with no row through the chain", async () => {
        const countries = await HtCountry.query().doesntHave("posts").orderBy("id").get(env.DB);
        // c3 (no through-user) and c4 (through-user but no posts) both have zero posts
        expect(countries.map((c) => c.get("id"))).toEqual(["c3", "c4"]);
    });
});
