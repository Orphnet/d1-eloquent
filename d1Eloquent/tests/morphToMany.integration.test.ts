// morphToMany.integration.test.ts
// Live D1 integration tests for polymorphic many-to-many:
// morphToMany (owning side) and morphedByMany (related-side inverse).
//
// Scenario: Tags can attach to Posts and Videos via a shared `taggables` pivot.

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
interface TagAttrs {
    id: string;
    label: string;
}

class MtmPost extends BaseModel<PostAttrs> {
    static table = "mtm_posts";
    static primaryKey = "id";
    static timestamps = false;
    static relations: Record<string, TRelationDefinition> = {
        tags: {
            type: "morphToMany",
            model: () => MtmTag,
            pivot: "mtm_taggables",
            morphName: "taggable",
            typeValue: "post",
            relatedPivotKey: "tag_id",
        },
    };
}

class MtmVideo extends BaseModel<VideoAttrs> {
    static table = "mtm_videos";
    static primaryKey = "id";
    static timestamps = false;
    static relations: Record<string, TRelationDefinition> = {
        tags: {
            type: "morphToMany",
            model: () => MtmTag,
            pivot: "mtm_taggables",
            morphName: "taggable",
            typeValue: "video",
            relatedPivotKey: "tag_id",
        },
    };
}

class MtmTag extends BaseModel<TagAttrs> {
    static table = "mtm_tags";
    static primaryKey = "id";
    static timestamps = false;
    static relations: Record<string, TRelationDefinition> = {
        posts: {
            type: "morphedByMany",
            model: () => MtmPost,
            pivot: "mtm_taggables",
            morphName: "taggable",
            typeValue: "post",
            relatedPivotKey: "tag_id",
        },
        videos: {
            type: "morphedByMany",
            model: () => MtmVideo,
            pivot: "mtm_taggables",
            morphName: "taggable",
            typeValue: "video",
            relatedPivotKey: "tag_id",
        },
    };
}

beforeAll(async () => {
    const schema = new Schema();
    schema.dropTable("mtm_taggables");
    schema.dropTable("mtm_tags");
    schema.dropTable("mtm_posts");
    schema.dropTable("mtm_videos");
    schema.createTable("mtm_posts", (t) => {
        t.id();
        t.text("title").notNull();
    });
    schema.createTable("mtm_videos", (t) => {
        t.id();
        t.text("name").notNull();
    });
    schema.createTable("mtm_tags", (t) => {
        t.id();
        t.text("label").notNull();
    });
    schema.createTable("mtm_taggables", (t) => {
        t.text("tag_id").notNull();
        t.text("taggable_type").notNull();
        t.text("taggable_id").notNull();
        t.primary("tag_id, taggable_type, taggable_id");
        t.index("taggable_type, taggable_id");
    });

    for (const stmt of schema.toStatements()) {
        await env.DB.prepare(stmt).run();
    }

    // Seed: 2 posts, 1 video, 3 tags, mixed attachments.
    const ins = async (sql: string, ...bindings: unknown[]) =>
        env.DB.prepare(sql).bind(...bindings).run();

    await ins("INSERT INTO mtm_posts (id, title) VALUES (?, ?)", "p1", "Hello");
    await ins("INSERT INTO mtm_posts (id, title) VALUES (?, ?)", "p2", "World");
    await ins("INSERT INTO mtm_posts (id, title) VALUES (?, ?)", "p_alone", "Lonely");
    await ins("INSERT INTO mtm_posts (id, title) VALUES (?, ?)", "p_empty", "Empty");
    await ins("INSERT INTO mtm_videos (id, name) VALUES (?, ?)", "v1", "Cats");
    await ins("INSERT INTO mtm_tags (id, label) VALUES (?, ?)", "t1", "rust");
    await ins("INSERT INTO mtm_tags (id, label) VALUES (?, ?)", "t2", "workers");
    await ins("INSERT INTO mtm_tags (id, label) VALUES (?, ?)", "t3", "video-tag");

    // p1 has [t1, t2]; p2 has [t1]; v1 has [t1, t3]
    const link = async (tagId: string, type: string, id: string) =>
        ins(
            "INSERT INTO mtm_taggables (tag_id, taggable_type, taggable_id) VALUES (?, ?, ?)",
            tagId,
            type,
            id,
        );
    await link("t1", "post", "p1");
    await link("t2", "post", "p1");
    await link("t1", "post", "p2");
    await link("t1", "video", "v1");
    await link("t3", "video", "v1");
});

describe("morphToMany — owning side (Post → Tag)", () => {
    it("lazy loads tags for a post", async () => {
        const post = await MtmPost.findOrFail(env.DB, "p1");
        const tags = await (post as any).related("tags").get(env.DB);
        const labels = (tags as any[]).map((t) => t.get("label")).sort();
        expect(labels).toEqual(["rust", "workers"]);
    });

    it("returns an empty array when no tags are attached", async () => {
        const post = await MtmPost.findOrFail(env.DB, "p_empty");
        const tags = await (post as any).related("tags").get(env.DB);
        expect((tags as unknown[]).length).toBe(0);
    });

    it("eager loads tags across multiple posts in one query batch", async () => {
        const posts = await MtmPost.query()
            .whereIn("id", ["p1", "p2"])
            .with(["tags"])
            .get(env.DB);
        const map = Object.fromEntries(
            posts.map((p: any) => [p.get("id") as string, (p as any).relations.tags]),
        );
        expect((map["p1"] as any[]).map((t) => t.get("label")).sort()).toEqual(
            ["rust", "workers"],
        );
        expect((map["p2"] as any[]).map((t) => t.get("label"))).toEqual(["rust"]);
    });

    it("does NOT mix tags across morph types", async () => {
        // p1's tags should not include v1's video-only tag (t3)
        const post = await MtmPost.findOrFail(env.DB, "p1");
        const tags = await (post as any).related("tags").get(env.DB);
        const labels = (tags as any[]).map((t) => t.get("label"));
        expect(labels).not.toContain("video-tag");
    });
});

describe("morphedByMany — related-side inverse (Tag → Post / Video)", () => {
    it("lazy loads posts for a tag", async () => {
        const tag = await MtmTag.findOrFail(env.DB, "t1");
        const posts = await (tag as any).related("posts").get(env.DB);
        const ids = (posts as any[]).map((p) => p.get("id")).sort();
        expect(ids).toEqual(["p1", "p2"]);
    });

    it("lazy loads videos for a tag", async () => {
        const tag = await MtmTag.findOrFail(env.DB, "t1");
        const videos = await (tag as any).related("videos").get(env.DB);
        const ids = (videos as any[]).map((v) => v.get("id"));
        expect(ids).toEqual(["v1"]);
    });

    it("eager loads multiple morph parents for the same tag", async () => {
        const tag = await MtmTag.query()
            .whereEq("id", "t1")
            .with(["posts", "videos"])
            .first(env.DB);
        expect(tag).not.toBeNull();
        const posts = ((tag as any).relations.posts as any[]).map((p) => p.get("id")).sort();
        const videos = ((tag as any).relations.videos as any[]).map((v) => v.get("id"));
        expect(posts).toEqual(["p1", "p2"]);
        expect(videos).toEqual(["v1"]);
    });
});

describe("morphToMany — has / whereHas", () => {
    it("has('tags') filters posts that have any tags", async () => {
        const posts = await MtmPost.query().has("tags").get(env.DB);
        const ids = posts.map((p: any) => p.get("id") as string).sort();
        expect(ids).toContain("p1");
        expect(ids).toContain("p2");
        expect(ids).not.toContain("p_alone");
        expect(ids).not.toContain("p_empty");
    });

    it("doesntHave('tags') filters posts with no tags", async () => {
        const posts = await MtmPost.query().doesntHave("tags").get(env.DB);
        const ids = posts.map((p: any) => p.get("id") as string);
        expect(ids).toContain("p_alone");
        expect(ids).not.toContain("p1");
    });

    it("whereHas('tags', q => q.whereEq('label', 'workers')) narrows by related label", async () => {
        const posts = await MtmPost.query()
            .whereHas("tags", (q) => q.whereEq("label", "workers"))
            .get(env.DB);
        const ids = posts.map((p: any) => p.get("id") as string);
        // Only p1 has the 'workers' tag
        expect(ids).toEqual(["p1"]);
    });
});

describe("morphedByMany — has / whereHas", () => {
    it("has('posts') filters tags attached to at least one post", async () => {
        const tags = await MtmTag.query().has("posts").get(env.DB);
        const labels = tags.map((t: any) => t.get("label") as string).sort();
        // t1 + t2 are attached to posts; t3 is video-only
        expect(labels).toEqual(["rust", "workers"]);
    });

    it("whereHas('posts', q => q.whereLike('title', 'Hello')) narrows", async () => {
        const tags = await MtmTag.query()
            .whereHas("posts", (q) => q.whereLike("title", "Hello"))
            .get(env.DB);
        const labels = tags.map((t: any) => t.get("label") as string).sort();
        expect(labels).toEqual(["rust", "workers"]);
    });
});
