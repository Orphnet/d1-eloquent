// relationAggregates.integration.test.ts
// Live D1 integration tests for withCount / withSum / withAvg across all
// supported relation types.

import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { Schema } from "../../scripts/schema";
import { BaseModel } from "../baseModel";
import type { TRelationDefinition } from "../relationTypes";

interface UserAttrs {
    id: string;
    name: string;
}
interface PostAttrs {
    id: string;
    title: string;
    user_id: string;
    score: number;
}
interface CommentAttrs {
    id: string;
    body: string;
    commentable_type: string;
    commentable_id: string;
    rating: number;
}
interface TagAttrs {
    id: string;
    label: string;
}

class RaUser extends BaseModel<UserAttrs> {
    static table = "ra_users";
    static primaryKey = "id";
    static timestamps = false;
    static relations: Record<string, TRelationDefinition> = {
        posts: { type: "hasMany", model: () => RaPost, foreignKey: "user_id" },
        tags: {
            type: "belongsToMany",
            model: () => RaTag,
            pivot: "ra_user_tags",
            foreignPivotKey: "user_id",
            relatedPivotKey: "tag_id",
        },
    };
}

class RaPost extends BaseModel<PostAttrs> {
    static table = "ra_posts";
    static primaryKey = "id";
    static timestamps = false;
    static casts = { score: "integer" } as const;
    static relations: Record<string, TRelationDefinition> = {
        author: { type: "belongsTo", model: () => RaUser, foreignKey: "user_id" },
        comments: {
            type: "morphMany",
            model: () => RaComment,
            morphName: "commentable",
            typeValue: "post",
        },
    };
}

class RaComment extends BaseModel<CommentAttrs> {
    static table = "ra_comments";
    static primaryKey = "id";
    static timestamps = false;
    static casts = { rating: "integer" } as const;
}

class RaTag extends BaseModel<TagAttrs> {
    static table = "ra_tags";
    static primaryKey = "id";
    static timestamps = false;
}

beforeAll(async () => {
    const s = new Schema();
    s.dropTable("ra_user_tags");
    s.dropTable("ra_comments");
    s.dropTable("ra_tags");
    s.dropTable("ra_posts");
    s.dropTable("ra_users");

    s.createTable("ra_users", (t) => {
        t.id();
        t.text("name").notNull();
    });
    s.createTable("ra_posts", (t) => {
        t.id();
        t.text("title").notNull();
        t.text("user_id").notNull();
        t.integer("score").notNull();
    });
    s.createTable("ra_comments", (t) => {
        t.id();
        t.text("body").notNull();
        t.text("commentable_type").notNull();
        t.text("commentable_id").notNull();
        t.integer("rating").notNull();
    });
    s.createTable("ra_tags", (t) => {
        t.id();
        t.text("label").notNull();
    });
    s.createTable("ra_user_tags", (t) => {
        t.text("user_id").notNull();
        t.text("tag_id").notNull();
        t.primary("user_id, tag_id");
    });

    for (const stmt of s.toStatements()) await env.DB.prepare(stmt).run();

    const run = async (sql: string, ...bs: unknown[]) =>
        env.DB.prepare(sql).bind(...bs).run();

    // u1 has 3 posts (scores 5, 7, 9), u2 has 1 post (score 4), u3 has none
    await run("INSERT INTO ra_users (id, name) VALUES (?, ?)", "u1", "Alice");
    await run("INSERT INTO ra_users (id, name) VALUES (?, ?)", "u2", "Bob");
    await run("INSERT INTO ra_users (id, name) VALUES (?, ?)", "u3", "Carol");

    await run("INSERT INTO ra_posts (id, title, user_id, score) VALUES (?, ?, ?, ?)", "p1", "A", "u1", 5);
    await run("INSERT INTO ra_posts (id, title, user_id, score) VALUES (?, ?, ?, ?)", "p2", "B", "u1", 7);
    await run("INSERT INTO ra_posts (id, title, user_id, score) VALUES (?, ?, ?, ?)", "p3", "C", "u1", 9);
    await run("INSERT INTO ra_posts (id, title, user_id, score) VALUES (?, ?, ?, ?)", "p4", "D", "u2", 4);

    // Comments: p1 has 2 (ratings 3, 5), p2 has 0, p3 has 1 (rating 1), p4 has 0
    await run("INSERT INTO ra_comments (id, body, commentable_type, commentable_id, rating) VALUES (?, ?, ?, ?, ?)",
        "c1", "Nice", "post", "p1", 3);
    await run("INSERT INTO ra_comments (id, body, commentable_type, commentable_id, rating) VALUES (?, ?, ?, ?, ?)",
        "c2", "Great", "post", "p1", 5);
    await run("INSERT INTO ra_comments (id, body, commentable_type, commentable_id, rating) VALUES (?, ?, ?, ?, ?)",
        "c3", "Meh", "post", "p3", 1);

    // Tags: u1 has [t1, t2], u2 has [t1], u3 has none
    await run("INSERT INTO ra_tags (id, label) VALUES (?, ?)", "t1", "alpha");
    await run("INSERT INTO ra_tags (id, label) VALUES (?, ?)", "t2", "beta");
    await run("INSERT INTO ra_user_tags (user_id, tag_id) VALUES (?, ?)", "u1", "t1");
    await run("INSERT INTO ra_user_tags (user_id, tag_id) VALUES (?, ?)", "u1", "t2");
    await run("INSERT INTO ra_user_tags (user_id, tag_id) VALUES (?, ?)", "u2", "t1");
});

describe("withCount — hasMany", () => {
    it("attaches <relation>_count with the correct counts per row", async () => {
        const users = await RaUser.query().withCount("posts").orderBy("id").get(env.DB);
        const map = Object.fromEntries(users.map((u: any) => [u.get("id"), u.get("posts_count")]));
        expect(map).toEqual({ u1: 3, u2: 1, u3: 0 });
    });

    it("supports a custom alias", async () => {
        const users = await RaUser.query().withCount("posts", "n").orderBy("id").get(env.DB);
        const map = Object.fromEntries(users.map((u: any) => [u.get("id"), u.get("n")]));
        expect(map).toEqual({ u1: 3, u2: 1, u3: 0 });
    });
});

describe("withSum / withAvg — hasMany", () => {
    it("withSum attaches <relation>_<col>_sum", async () => {
        const users = await RaUser.query().withSum("posts", "score").orderBy("id").get(env.DB);
        const map = Object.fromEntries(users.map((u: any) => [u.get("id"), u.get("posts_score_sum")]));
        // u1: 5+7+9=21, u2: 4, u3: null (no rows → SUM = NULL)
        expect(map["u1"]).toBe(21);
        expect(map["u2"]).toBe(4);
        expect(map["u3"]).toBeNull();
    });

    it("withAvg attaches <relation>_<col>_avg", async () => {
        const users = await RaUser.query().withAvg("posts", "score").orderBy("id").get(env.DB);
        const map = Object.fromEntries(users.map((u: any) => [u.get("id"), u.get("posts_score_avg")]));
        // u1: 21/3=7, u2: 4, u3: null
        expect(map["u1"]).toBe(7);
        expect(map["u2"]).toBe(4);
        expect(map["u3"]).toBeNull();
    });
});

describe("withCount — belongsTo, belongsToMany, morphMany", () => {
    it("works on belongsTo (single-row child → 0 or 1)", async () => {
        const posts = await RaPost.query().withCount("author").orderBy("id").get(env.DB);
        // Every post has exactly one author → all counts == 1
        for (const p of posts) {
            expect((p as any).get("author_count")).toBe(1);
        }
    });

    it("works on belongsToMany via the pivot", async () => {
        const users = await RaUser.query().withCount("tags").orderBy("id").get(env.DB);
        const map = Object.fromEntries(users.map((u: any) => [u.get("id"), u.get("tags_count")]));
        expect(map).toEqual({ u1: 2, u2: 1, u3: 0 });
    });

    it("works on morphMany — filters by typeValue", async () => {
        const posts = await RaPost.query().withCount("comments").orderBy("id").get(env.DB);
        const map = Object.fromEntries(posts.map((p: any) => [p.get("id"), p.get("comments_count")]));
        expect(map).toEqual({ p1: 2, p2: 0, p3: 1, p4: 0 });
    });
});

describe("Combining aggregates with filters and other state", () => {
    it("preserves WHERE filters", async () => {
        // Only u1
        const users = await RaUser.query()
            .whereEq("id", "u1")
            .withCount("posts")
            .withSum("posts", "score")
            .get(env.DB);
        expect(users.length).toBe(1);
        expect((users[0] as any).get("posts_count")).toBe(3);
        expect((users[0] as any).get("posts_score_sum")).toBe(21);
    });

    it("composes with other selects without clobbering them", async () => {
        const users = await RaUser.query()
            .select(["ra_users.id", "ra_users.name"])
            .withCount("posts")
            .orderBy("ra_users.id")
            .get(env.DB);
        const first: any = users[0];
        expect(first.get("name")).toBe("Alice");
        expect(first.get("posts_count")).toBe(3);
    });
});

describe("Error cases", () => {
    it("throws on unknown relation", () => {
        expect(() => RaUser.query().withCount("nope" as any)).toThrow(
            /Unknown relation 'nope'/,
        );
    });

    it("throws when aggregating a morphTo (inverse side spans tables)", () => {
        class RaMorphChild extends BaseModel<CommentAttrs> {
            static table = "ra_comments";
            static primaryKey = "id";
            static relations: Record<string, TRelationDefinition> = {
                owner: {
                    type: "morphTo",
                    morphName: "commentable",
                    morphMap: { post: () => RaPost },
                },
            };
        }
        expect(() => RaMorphChild.query().withCount("owner")).toThrow(
            /Aggregate on 'morphTo' is not supported/,
        );
    });
});
