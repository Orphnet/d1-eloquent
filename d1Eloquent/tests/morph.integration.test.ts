// morph.integration.test.ts
// Live D1 integration tests for polymorphic relations: morphTo, morphMany,
// morphOne (plus has / whereHas + eager loading).

import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { Schema } from "../../scripts/schema";
import { BaseModel } from "../baseModel";
import type { TRelationDefinition } from "../relationTypes";

interface PostAttrs {
    id: string;
    title: string;
}
interface VideoAttrs {
    id: string;
    name: string;
}
interface CommentAttrs {
    id: string;
    body: string;
    commentable_type: string;
    commentable_id: string;
}
interface ImageAttrs {
    id: string;
    src: string;
    imageable_type: string;
    imageable_id: string;
}

class MPost extends BaseModel<PostAttrs> {
    static table = "m_posts";
    static primaryKey = "id";
    static timestamps = false;
    static relations: Record<string, TRelationDefinition> = {
        comments: {
            type: "morphMany",
            model: () => MComment,
            morphName: "commentable",
            typeValue: "post",
        },
        cover: {
            type: "morphOne",
            model: () => MImage,
            morphName: "imageable",
            typeValue: "post",
        },
    };
}

class MVideo extends BaseModel<VideoAttrs> {
    static table = "m_videos";
    static primaryKey = "id";
    static timestamps = false;
    static relations: Record<string, TRelationDefinition> = {
        comments: {
            type: "morphMany",
            model: () => MComment,
            morphName: "commentable",
            typeValue: "video",
        },
    };
}

class MComment extends BaseModel<CommentAttrs> {
    static table = "m_comments";
    static primaryKey = "id";
    static timestamps = false;
    static relations: Record<string, TRelationDefinition> = {
        commentable: {
            type: "morphTo",
            morphName: "commentable",
            morphMap: {
                post: () => MPost,
                video: () => MVideo,
            },
        },
    };
}

class MImage extends BaseModel<ImageAttrs> {
    static table = "m_images";
    static primaryKey = "id";
    static timestamps = false;
}

beforeAll(async () => {
    const schema = new Schema();
    schema.dropTable("m_comments");
    schema.dropTable("m_images");
    schema.dropTable("m_posts");
    schema.dropTable("m_videos");
    schema.createTable("m_posts", (t) => {
        t.id();
        t.text("title").notNull();
    });
    schema.createTable("m_videos", (t) => {
        t.id();
        t.text("name").notNull();
    });
    schema.createTable("m_comments", (t) => {
        t.id();
        t.text("body").notNull();
        t.text("commentable_type").notNull();
        t.text("commentable_id").notNull();
        t.index("commentable_type, commentable_id");
    });
    schema.createTable("m_images", (t) => {
        t.id();
        t.text("src").notNull();
        t.text("imageable_type").notNull();
        t.text("imageable_id").notNull();
    });

    for (const stmt of schema.toStatements()) {
        await env.DB.prepare(stmt).run();
    }

    // Seed: 2 posts, 1 video, comments split between them, 1 image on post-1
    const seeds: { sql: string; binds: unknown[] }[] = [
        { sql: `INSERT INTO m_posts (id, title) VALUES (?, ?)`, binds: ["p1", "First Post"] },
        { sql: `INSERT INTO m_posts (id, title) VALUES (?, ?)`, binds: ["p2", "Second Post"] },
        { sql: `INSERT INTO m_videos (id, name) VALUES (?, ?)`, binds: ["v1", "Cat Video"] },
        { sql: `INSERT INTO m_comments (id, body, commentable_type, commentable_id) VALUES (?, ?, ?, ?)`, binds: ["c1", "Great post", "post", "p1"] },
        { sql: `INSERT INTO m_comments (id, body, commentable_type, commentable_id) VALUES (?, ?, ?, ?)`, binds: ["c2", "Agreed!", "post", "p1"] },
        { sql: `INSERT INTO m_comments (id, body, commentable_type, commentable_id) VALUES (?, ?, ?, ?)`, binds: ["c3", "Lol", "video", "v1"] },
        { sql: `INSERT INTO m_images (id, src, imageable_type, imageable_id) VALUES (?, ?, ?, ?)`, binds: ["i1", "/cover.jpg", "post", "p1"] },
    ];
    for (const s of seeds) {
        await env.DB.prepare(s.sql).bind(...s.binds).run();
    }
});

describe("morphMany — lazy load via model.related()", () => {
    it("returns the comments belonging to a post", async () => {
        const post = await MPost.findOrFail(env.DB, "p1");
        const comments = await (post as any).related("comments").get(env.DB);
        expect(comments.length).toBe(2);
        const ids = comments.map((c: any) => c.get("id")).sort();
        expect(ids).toEqual(["c1", "c2"]);
    });

    it("returns comments belonging to a video (different typeValue)", async () => {
        const video = await MVideo.findOrFail(env.DB, "v1");
        const comments = await (video as any).related("comments").get(env.DB);
        expect(comments.length).toBe(1);
        expect((comments[0] as any).get("id")).toBe("c3");
    });

    it("does NOT mix comments across types", async () => {
        const post = await MPost.findOrFail(env.DB, "p1");
        const comments = await (post as any).related("comments").get(env.DB);
        const types = comments.map((c: any) => c.get("commentable_type"));
        expect(types.every((t: string) => t === "post")).toBe(true);
    });
});

describe("morphOne — lazy load via model.related()", () => {
    it("returns a single image when one exists", async () => {
        const post = await MPost.findOrFail(env.DB, "p1");
        const cover = await (post as any).related("cover").first(env.DB);
        expect(cover).not.toBeNull();
        expect((cover as any).get("id")).toBe("i1");
    });

    it("returns null when no image exists", async () => {
        const post = await MPost.findOrFail(env.DB, "p2");
        const cover = await (post as any).related("cover").first(env.DB);
        expect(cover).toBeNull();
    });
});

describe("morphTo — lazy load via model.related()", () => {
    it("returns the post when commentable_type='post'", async () => {
        const comment = await MComment.findOrFail(env.DB, "c1");
        const parent = await (comment as any).related("commentable").first(env.DB);
        expect(parent).not.toBeNull();
        expect((parent as any).get("id")).toBe("p1");
        expect((parent as any).get("title")).toBe("First Post");
    });

    it("returns the video when commentable_type='video'", async () => {
        const comment = await MComment.findOrFail(env.DB, "c3");
        const parent = await (comment as any).related("commentable").first(env.DB);
        expect(parent).not.toBeNull();
        expect((parent as any).get("id")).toBe("v1");
        expect((parent as any).get("name")).toBe("Cat Video");
    });
});

describe("morph eager loading via .with()", () => {
    it("eager loads morphMany on multiple parents (single round trip per type)", async () => {
        const posts = await MPost.query().with(["comments"]).get(env.DB);
        const map = Object.fromEntries(
            posts.map((p: any) => [p.get("id") as string, (p as any).relations.comments]),
        );
        expect((map["p1"] as any[]).length).toBe(2);
        expect((map["p2"] as any[]).length).toBe(0);
    });

    it("eager loads morphTo across multiple types in one pass", async () => {
        const comments = await MComment.query().with(["commentable"]).get(env.DB);
        const map = Object.fromEntries(
            comments.map((c: any) => [c.get("id") as string, (c as any).relations.commentable]),
        );
        expect((map["c1"] as any).get("id")).toBe("p1");
        expect((map["c2"] as any).get("id")).toBe("p1");
        expect((map["c3"] as any).get("id")).toBe("v1");
    });

    it("eager loads morphOne — one image per post", async () => {
        const posts = await MPost.query().with(["cover"]).get(env.DB);
        const map = Object.fromEntries(
            posts.map((p: any) => [p.get("id") as string, (p as any).relations.cover]),
        );
        expect((map["p1"] as any).get("id")).toBe("i1");
        expect(map["p2"]).toBeNull();
    });
});

describe("morph has / whereHas — query filtering", () => {
    it("has('comments') filters posts that have any comments", async () => {
        const posts = await MPost.query().has("comments").get(env.DB);
        expect(posts.length).toBe(1);
        expect((posts[0] as any).get("id")).toBe("p1");
    });

    it("doesntHave('comments') filters posts with no comments", async () => {
        const posts = await MPost.query().doesntHave("comments").get(env.DB);
        expect(posts.length).toBe(1);
        expect((posts[0] as any).get("id")).toBe("p2");
    });

    it("whereHas() with extra constraints", async () => {
        const posts = await MPost.query()
            .whereHas("comments", (q) => q.whereLike("body", "%Agreed%"))
            .get(env.DB);
        expect(posts.length).toBe(1);
        expect((posts[0] as any).get("id")).toBe("p1");
    });

    it("whereHas on morphTo is not supported — throws", async () => {
        expect(() => MComment.query().whereHas("commentable" as any)).toThrow(
            /whereHas\/has on 'morphTo' is not supported/,
        );
    });
});

describe("morph edge cases", () => {
    it("unknown type in morphMap throws on lazy resolve", async () => {
        // Insert a comment with an unknown type
        await env.DB
            .prepare(`INSERT INTO m_comments (id, body, commentable_type, commentable_id) VALUES (?, ?, ?, ?)`)
            .bind("cx", "?", "unknown_type", "p1")
            .run();

        const comment = await MComment.findOrFail(env.DB, "cx");
        expect(() => (comment as any).related("commentable")).toThrow(/unknown type 'unknown_type'/);
    });
});
