// constrainedEager.integration.test.ts
// Live D1 tests for constrained eager loading — with({ relation: q => ... }).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BaseModel } from "../baseModel";
import type { TRelationDefinition } from "../relationTypes";

interface PostAttrs { id?: string; title?: string }
interface CommentAttrs { id?: string; post_id?: string; approved?: number; body?: string }
interface TagAttrs { id?: string; name?: string; featured?: number }

class CeComment extends BaseModel<CommentAttrs> {
    static table = "ce_comments";
    static timestamps = false;
    static relations: Record<string, TRelationDefinition> = {
        post: { type: "belongsTo", model: () => CePost, foreignKey: "post_id" },
    };
}
class CeTag extends BaseModel<TagAttrs> {
    static table = "ce_tags";
    static timestamps = false;
}
class CePost extends BaseModel<PostAttrs> {
    static table = "ce_posts";
    static timestamps = false;
    static relations: Record<string, TRelationDefinition> = {
        comments: { type: "hasMany", model: () => CeComment, foreignKey: "post_id" },
        topComment: { type: "hasOne", model: () => CeComment, foreignKey: "post_id" },
        tags: {
            type: "belongsToMany",
            model: () => CeTag,
            pivot: "ce_post_tag",
            foreignPivotKey: "post_id",
            relatedPivotKey: "tag_id",
        },
    };
}

beforeAll(async () => {
    for (const sql of [
        `CREATE TABLE IF NOT EXISTS ce_posts (id TEXT PRIMARY KEY, title TEXT)`,
        `CREATE TABLE IF NOT EXISTS ce_comments (id TEXT PRIMARY KEY, post_id TEXT, approved INTEGER DEFAULT 0, body TEXT)`,
        `CREATE TABLE IF NOT EXISTS ce_tags (id TEXT PRIMARY KEY, name TEXT, featured INTEGER DEFAULT 0)`,
        `CREATE TABLE IF NOT EXISTS ce_post_tag (post_id TEXT, tag_id TEXT)`,
    ]) await env.DB.prepare(sql).run();
});

beforeEach(async () => {
    for (const t of ["ce_posts", "ce_comments", "ce_tags", "ce_post_tag"]) {
        await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
    await CePost.create(env.DB, { id: "p1", title: "P1" });
    await CePost.create(env.DB, { id: "p2", title: "P2" });
    await CeComment.create(env.DB, { id: "c1", post_id: "p1", approved: 1, body: "b" });
    await CeComment.create(env.DB, { id: "c2", post_id: "p1", approved: 0, body: "a" });
    await CeComment.create(env.DB, { id: "c3", post_id: "p2", approved: 1, body: "c" });
});

describe("constrained eager loading — hasMany", () => {
    it("filters the eager-loaded relation with a where constraint", async () => {
        const posts = await CePost.query()
            .with({ comments: (q) => q.where("approved", "=", 1) })
            .orderBy("id")
            .get(env.DB);

        const p1 = posts.find((p) => p.get("id") === "p1")!;
        const p2 = posts.find((p) => p.get("id") === "p2")!;
        expect((p1.relations.comments as CeComment[]).map((c) => c.get("id"))).toEqual(["c1"]);
        expect((p2.relations.comments as CeComment[]).map((c) => c.get("id"))).toEqual(["c3"]);
    });

    it("orders the eager-loaded relation", async () => {
        const posts = await CePost.query()
            .with({ comments: (q) => q.orderBy("body", "asc") })
            .whereEq("id", "p1")
            .get(env.DB);
        expect((posts[0].relations.comments as CeComment[]).map((c) => c.get("body"))).toEqual(["a", "b"]);
    });

    it("`true` in the object form loads the relation unconstrained", async () => {
        const posts = await CePost.query().with({ comments: true }).whereEq("id", "p1").get(env.DB);
        expect((posts[0].relations.comments as CeComment[]).length).toBe(2);
    });

    it("the string-array form still loads everything (backward compatible)", async () => {
        const posts = await CePost.query().with(["comments"]).whereEq("id", "p1").get(env.DB);
        expect((posts[0].relations.comments as CeComment[]).length).toBe(2);
    });

    it("constrains one relation while loading another unconstrained (mixed object form)", async () => {
        await CeTag.create(env.DB, { id: "t1", name: "x", featured: 1 });
        await env.DB.prepare("INSERT INTO ce_post_tag (post_id, tag_id) VALUES ('p1','t1')").run();

        const posts = await CePost.query()
            .with({ comments: (q) => q.where("approved", "=", 1), tags: true })
            .whereEq("id", "p1")
            .get(env.DB);
        expect((posts[0].relations.comments as CeComment[]).map((c) => c.get("id"))).toEqual(["c1"]);
        expect((posts[0].relations.tags as CeTag[]).map((t) => t.get("id"))).toEqual(["t1"]);
    });

    it("applies a constraint to a hasOne relation (first match after filter)", async () => {
        // p1 has c1(approved) + c2(unapproved); the constraint filters to approved,
        // so the single hasOne result is c1 — exercises the shared getInChunks
        // constraint rail for hasOne, not just hasMany.
        const posts = await CePost.query()
            .with({ topComment: (q) => q.where("approved", "=", 1) })
            .whereEq("id", "p1")
            .get(env.DB);
        expect((posts[0].relations.topComment as CeComment).get("id")).toBe("c1");
    });
});

describe("constrained eager loading — belongsToMany (pivot/join)", () => {
    beforeEach(async () => {
        await CeTag.create(env.DB, { id: "t1", name: "feat", featured: 1 });
        await CeTag.create(env.DB, { id: "t2", name: "plain", featured: 0 });
        await env.DB.prepare("INSERT INTO ce_post_tag (post_id, tag_id) VALUES ('p1','t1'),('p1','t2')").run();
    });

    it("filters pivot-loaded relations by a related-table condition", async () => {
        const posts = await CePost.query()
            .with({ tags: (q) => q.where("featured", "=", 1) })
            .whereEq("id", "p1")
            .get(env.DB);
        expect((posts[0].relations.tags as CeTag[]).map((t) => t.get("id"))).toEqual(["t1"]);
    });

    // Regression (#46): a `select()` in a pivot-relation constraint must not drop the
    // internal grouping column (`… as __pivot_fk`). Before the fix it clobbered the
    // select and every parent got [].
    it("a select() in a pivot-relation constraint keeps result distribution working", async () => {
        const posts = await CePost.query()
            .with({ tags: (q) => q.select(["ce_tags.id", "ce_tags.name"]) })
            .whereEq("id", "p1")
            .get(env.DB);
        expect((posts[0].relations.tags as CeTag[]).map((t) => t.get("id")).sort()).toEqual(["t1", "t2"]);
    });
});

describe("constrained eager loading — constraint hygiene (#46)", () => {
    // Regression: re-registering a relation without a constraint must clear a prior one.
    it("the last with() wins — array form after object form drops the stale constraint", async () => {
        const posts = await CePost.query()
            .with({ comments: (q) => q.where("approved", "=", 1) }) // would filter to c1
            .with(["comments"]) // …but this re-registers unconstrained → all of p1's comments
            .whereEq("id", "p1")
            .get(env.DB);
        expect((posts[0].relations.comments as CeComment[]).map((c) => c.get("id")).sort()).toEqual(["c1", "c2"]);
    });

    // A top-level OR in a constraint is AND-wrapped so it stays correlated to the
    // parent set (mirrors applyRelationConstraint) — a sibling parent's row with a
    // matching OR value must not leak in.
    it("a top-level orWhere in a constraint stays correlated to the parent", async () => {
        await CeComment.create(env.DB, { id: "c4", post_id: "p2", approved: 0, body: "a" }); // p2, same body as p1's c2
        const posts = await CePost.query()
            .with({ comments: (q) => q.where("approved", "=", 1).orWhere("body", "=", "a") })
            .whereEq("id", "p1")
            .get(env.DB);
        expect((posts[0].relations.comments as CeComment[]).map((c) => c.get("id")).sort()).toEqual(["c1", "c2"]);
    });
});

describe("constrained eager loading - correlation FK survives a constraint .select() (regression)", () => {
    // Before the fix: a constraint that .select()s a column list omitting the foreign key
    // dropped the loader's correlation column, so every parent grouped under `undefined`
    // and the relation resolved to [] / null. The loaders now alias the FK (as __hasmany_fk
    // / __hasone_fk / __belongsto_ok) so it survives even when the user narrows the columns.
    it("hasMany: .select() without the FK still returns all of a parent's rows", async () => {
        const posts = await CePost.query()
            .with({ comments: (q) => q.select(["id", "body"]) })
            .whereEq("id", "p1")
            .get(env.DB);
        expect((posts[0].relations.comments as CeComment[]).map((c) => c.get("id")).sort()).toEqual(["c1", "c2"]);
    });

    it("hasOne: .select() without the FK still resolves the related row", async () => {
        const posts = await CePost.query()
            .with({ topComment: (q) => q.select(["id", "body"]) })
            .whereEq("id", "p1")
            .get(env.DB);
        expect(posts[0].relations.topComment).not.toBeNull();
        expect((posts[0].relations.topComment as CeComment).get("body")).toBeDefined();
    });

    it("belongsTo: .select() without the owner key still resolves the parent", async () => {
        const comments = await CeComment.query()
            .with({ post: (q) => q.select(["title"]) })
            .whereEq("id", "c1")
            .get(env.DB);
        expect(comments[0].relations.post).not.toBeNull();
        expect((comments[0].relations.post as CePost).get("title")).toBe("P1");
    });
});
