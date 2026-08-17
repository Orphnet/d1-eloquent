// relationshipsFunctions.integration.test.ts
// Tests that exercise the .get() / .first() closures of relationship helpers
// and the belongsToManyFetch function, plus relationResolver loaders.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { belongsTo, hasMany, hasOne, belongsToMany, belongsToManyFetch } from "../relationships";
import { BaseModel } from "../baseModel";
import type { TRelationDefinition } from "../relationTypes";

// ── Schema setup ─────────────────────────────────────────────────────

beforeAll(async () => {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rf_users (id TEXT PRIMARY KEY, name TEXT)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rf_posts (id TEXT PRIMARY KEY, user_id TEXT, title TEXT)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rf_profiles (id TEXT PRIMARY KEY, user_id TEXT, bio TEXT)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rf_tags (id TEXT PRIMARY KEY, name TEXT)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rf_post_tags (post_id TEXT, tag_id TEXT, PRIMARY KEY(post_id, tag_id))`).run();
});

afterAll(async () => {
    for (const t of ["rf_users", "rf_posts", "rf_profiles", "rf_tags", "rf_post_tags"]) {
        await env.DB.prepare(`DROP TABLE IF EXISTS ${t}`).run();
    }
});

beforeEach(async () => {
    for (const t of ["rf_users", "rf_posts", "rf_profiles", "rf_tags", "rf_post_tags"]) {
        await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
});

// ── Models (minimal for relationship testing) ────────────────────────

class User {
    static table = "rf_users";
    static primaryKey = "id";
    attrs: Record<string, unknown>;
    constructor(attrs: Record<string, unknown> = {}) { this.attrs = attrs; }
    toObject() { return this.attrs; }
}

class Post {
    static table = "rf_posts";
    static primaryKey = "id";
    attrs: Record<string, unknown>;
    constructor(attrs: Record<string, unknown> = {}) { this.attrs = attrs; }
    toObject() { return this.attrs; }
}

class Profile {
    static table = "rf_profiles";
    static primaryKey = "id";
    attrs: Record<string, unknown>;
    constructor(attrs: Record<string, unknown> = {}) { this.attrs = attrs; }
    toObject() { return this.attrs; }
}

class Tag {
    static table = "rf_tags";
    static primaryKey = "id";
    attrs: Record<string, unknown>;
    constructor(attrs: Record<string, unknown> = {}) { this.attrs = attrs; }
    toObject() { return this.attrs; }
}

// ── belongsTo .get() and .first() ────────────────────────────────────

describe("belongsTo closures (D1)", () => {
    beforeEach(async () => {
        await env.DB.prepare("INSERT INTO rf_users (id, name) VALUES (?, ?)").bind("u1", "Alice").run();
        await env.DB.prepare("INSERT INTO rf_posts (id, user_id, title) VALUES (?, ?, ?)").bind("p1", "u1", "Post 1").run();
    });

    it(".get() returns related models", async () => {
        const rel = belongsTo(User, { foreignKey: "user_id", localValue: "u1" });
        const results = await rel.get(env.DB);
        expect(results.length).toBe(1);
        expect(results[0].toObject().name).toBe("Alice");
    });

    it(".first() returns a single model", async () => {
        const rel = belongsTo(User, { foreignKey: "user_id", localValue: "u1" });
        const result = await rel.first(env.DB);
        expect(result).not.toBeNull();
        expect(result!.toObject().name).toBe("Alice");
    });
});

// ── hasMany .get() and .first() ──────────────────────────────────────

describe("hasMany closures (D1)", () => {
    beforeEach(async () => {
        await env.DB.prepare("INSERT INTO rf_users (id, name) VALUES (?, ?)").bind("u1", "Alice").run();
        await env.DB.prepare("INSERT INTO rf_posts (id, user_id, title) VALUES (?, ?, ?)").bind("p1", "u1", "Post 1").run();
        await env.DB.prepare("INSERT INTO rf_posts (id, user_id, title) VALUES (?, ?, ?)").bind("p2", "u1", "Post 2").run();
    });

    it(".get() returns all related models", async () => {
        const rel = hasMany(Post, { foreignKey: "user_id", localValue: "u1" });
        const results = await rel.get(env.DB);
        expect(results.length).toBe(2);
    });

    it(".first() returns first related model", async () => {
        const rel = hasMany(Post, { foreignKey: "user_id", localValue: "u1" });
        const result = await rel.first(env.DB);
        expect(result).not.toBeNull();
    });
});

// ── hasOne .get() and .first() ───────────────────────────────────────

describe("hasOne closures (D1)", () => {
    beforeEach(async () => {
        await env.DB.prepare("INSERT INTO rf_users (id, name) VALUES (?, ?)").bind("u1", "Alice").run();
        await env.DB.prepare("INSERT INTO rf_profiles (id, user_id, bio) VALUES (?, ?, ?)").bind("pr1", "u1", "Bio text").run();
    });

    it(".get() returns related models", async () => {
        const rel = hasOne(Profile, { foreignKey: "user_id", localValue: "u1" });
        const results = await rel.get(env.DB);
        expect(results.length).toBe(1);
    });

    it(".first() returns a single model", async () => {
        const rel = hasOne(Profile, { foreignKey: "user_id", localValue: "u1" });
        const result = await rel.first(env.DB);
        expect(result).not.toBeNull();
        expect(result!.toObject().bio).toBe("Bio text");
    });
});

// ── belongsToMany .get() and .first() ────────────────────────────────

describe("belongsToMany closures (D1)", () => {
    beforeEach(async () => {
        await env.DB.prepare("INSERT INTO rf_posts (id, user_id, title) VALUES (?, ?, ?)").bind("p1", "u1", "Post").run();
        await env.DB.prepare("INSERT INTO rf_tags (id, name) VALUES (?, ?)").bind("t1", "JS").run();
        await env.DB.prepare("INSERT INTO rf_tags (id, name) VALUES (?, ?)").bind("t2", "TS").run();
        await env.DB.prepare("INSERT INTO rf_post_tags (post_id, tag_id) VALUES (?, ?)").bind("p1", "t1").run();
        await env.DB.prepare("INSERT INTO rf_post_tags (post_id, tag_id) VALUES (?, ?)").bind("p1", "t2").run();
    });

    it(".get() returns related models through pivot", async () => {
        const rel = belongsToMany(Tag, {
            pivot: "rf_post_tags",
            foreignKey: "post_id",
            relatedKey: "tag_id",
            localValue: "p1",
        });
        const results = await rel.get(env.DB);
        expect(results.length).toBe(2);
    });

    it(".first() returns first related model through pivot", async () => {
        const rel = belongsToMany(Tag, {
            pivot: "rf_post_tags",
            foreignKey: "post_id",
            relatedKey: "tag_id",
            localValue: "p1",
        });
        const result = await rel.first(env.DB);
        expect(result).not.toBeNull();
    });
});

// ── belongsToManyFetch ───────────────────────────────────────────────

describe("belongsToManyFetch (D1)", () => {
    beforeEach(async () => {
        await env.DB.prepare("INSERT INTO rf_posts (id, user_id, title) VALUES (?, ?, ?)").bind("p1", "u1", "Post 1").run();
        await env.DB.prepare("INSERT INTO rf_posts (id, user_id, title) VALUES (?, ?, ?)").bind("p2", "u1", "Post 2").run();
    });

    it("fetches models by owner key values", async () => {
        const results = await belongsToManyFetch(env.DB, Post, "user_id", ["u1"]);
        expect(results.length).toBe(2);
    });

    it("returns empty array for empty owner key values", async () => {
        const results = await belongsToManyFetch(env.DB, Post, "user_id", []);
        expect(results.length).toBe(0);
    });
});

// ── Declarative relation eager loaders (relationResolver) ────────────

class UserModel extends BaseModel<{ id?: string; name?: string }> {
    static table = "rf_users";
    static primaryKey = "id";
    static timestamps = false;
    static softDeletes = false;
    static relations: Record<string, TRelationDefinition> = {
        posts: { type: "hasMany", model: () => PostModel, foreignKey: "user_id" },
        profile: { type: "hasOne", model: () => ProfileModel, foreignKey: "user_id" },
        tags: {
            type: "belongsToMany",
            model: () => TagModel,
            pivot: "rf_post_tags",
            foreignPivotKey: "post_id",
            relatedPivotKey: "tag_id",
        },
    };
}

class PostModel extends BaseModel<{ id?: string; user_id?: string; title?: string }> {
    static table = "rf_posts";
    static primaryKey = "id";
    static timestamps = false;
    static softDeletes = false;
    static relations: Record<string, TRelationDefinition> = {
        author: { type: "belongsTo", model: () => UserModel, foreignKey: "user_id" },
        tags: {
            type: "belongsToMany",
            model: () => TagModel,
            pivot: "rf_post_tags",
            foreignPivotKey: "post_id",
            relatedPivotKey: "tag_id",
        },
    };
}

class ProfileModel extends BaseModel<{ id?: string; user_id?: string; bio?: string }> {
    static table = "rf_profiles";
    static primaryKey = "id";
    static timestamps = false;
    static softDeletes = false;
}

class TagModel extends BaseModel<{ id?: string; name?: string }> {
    static table = "rf_tags";
    static primaryKey = "id";
    static timestamps = false;
    static softDeletes = false;
}

describe("eager loading with .with() on real D1", () => {
    beforeEach(async () => {
        await env.DB.prepare("INSERT INTO rf_users (id, name) VALUES (?, ?)").bind("u1", "Alice").run();
        await env.DB.prepare("INSERT INTO rf_users (id, name) VALUES (?, ?)").bind("u2", "Bob").run();
        await env.DB.prepare("INSERT INTO rf_posts (id, user_id, title) VALUES (?, ?, ?)").bind("p1", "u1", "Alice Post").run();
        await env.DB.prepare("INSERT INTO rf_posts (id, user_id, title) VALUES (?, ?, ?)").bind("p2", "u1", "Alice Post 2").run();
        await env.DB.prepare("INSERT INTO rf_posts (id, user_id, title) VALUES (?, ?, ?)").bind("p3", "u2", "Bob Post").run();
        await env.DB.prepare("INSERT INTO rf_profiles (id, user_id, bio) VALUES (?, ?, ?)").bind("pr1", "u1", "Alice bio").run();
        await env.DB.prepare("INSERT INTO rf_tags (id, name) VALUES (?, ?)").bind("t1", "JS").run();
        await env.DB.prepare("INSERT INTO rf_tags (id, name) VALUES (?, ?)").bind("t2", "TS").run();
        await env.DB.prepare("INSERT INTO rf_post_tags (post_id, tag_id) VALUES (?, ?)").bind("p1", "t1").run();
        await env.DB.prepare("INSERT INTO rf_post_tags (post_id, tag_id) VALUES (?, ?)").bind("p1", "t2").run();
        await env.DB.prepare("INSERT INTO rf_post_tags (post_id, tag_id) VALUES (?, ?)").bind("p2", "t1").run();
    });

    it("eager loads hasMany relation", async () => {
        const users = await UserModel.query().with(["posts"]).get(env.DB);
        const alice = users.find((u) => u.get("id") === "u1")!;
        expect((alice.relations as any).posts.length).toBe(2);
    });

    it("eager loads hasOne relation", async () => {
        const users = await UserModel.query().with(["profile"]).get(env.DB);
        const alice = users.find((u) => u.get("id") === "u1")!;
        expect((alice.relations as any).profile).not.toBeNull();
        const bob = users.find((u) => u.get("id") === "u2")!;
        expect((bob.relations as any).profile).toBeNull();
    });

    it("eager loads belongsTo relation", async () => {
        const posts = await PostModel.query().with(["author"]).get(env.DB);
        const p1 = posts.find((p) => p.get("id") === "p1")!;
        expect((p1.relations as any).author).not.toBeNull();
        expect((p1.relations as any).author.get("name")).toBe("Alice");
    });

    it("eager loads belongsToMany relation", async () => {
        const posts = await PostModel.query().with(["tags"]).get(env.DB);
        const p1 = posts.find((p) => p.get("id") === "p1")!;
        expect((p1.relations as any).tags.length).toBe(2);
    });

    it("eager loads multiple relations at once", async () => {
        const users = await UserModel.query().with(["posts", "profile"]).get(env.DB);
        const alice = users.find((u) => u.get("id") === "u1")!;
        expect((alice.relations as any).posts.length).toBe(2);
        expect((alice.relations as any).profile).not.toBeNull();
    });
});
