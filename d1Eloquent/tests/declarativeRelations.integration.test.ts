// declarativeRelations.integration.test.ts
// Integration tests for declarative relations with real D1

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BaseModel } from "../baseModel";
import type { TRelationDefinition } from "../relationTypes";

// ── Models ───────────────────────────────────────────────────────────

interface UserAttrs {
    id?: string;
    name?: string;
    created_at?: string | Date;
    updated_at?: string | Date;
}

interface PostAttrs {
    id?: string;
    user_id?: string;
    title?: string;
    published?: number;
    created_at?: string | Date;
    updated_at?: string | Date;
}

interface CommentAttrs {
    id?: string;
    post_id?: string;
    body?: string;
    approved?: number;
    created_at?: string | Date;
    updated_at?: string | Date;
}

interface TagAttrs {
    id?: string;
    name?: string;
}

interface ProfileAttrs {
    id?: string;
    user_id?: string;
    bio?: string;
}

// Forward-declare for lazy references
let UserModel: typeof _UserModel;
let PostModel: typeof _PostModel;

class _UserModel extends BaseModel<UserAttrs> {
    static table = "rel_users";
    static primaryKey = "id";
    static timestamps = true;
    static relations: Record<string, TRelationDefinition> = {
        posts: { type: "hasMany", model: () => PostModel, foreignKey: "user_id" },
        profile: { type: "hasOne", model: () => ProfileModel, foreignKey: "user_id" },
        roles: {
            type: "belongsToMany",
            model: () => RoleModel,
            pivot: "rel_user_roles",
            foreignPivotKey: "user_id",
            relatedPivotKey: "role_id",
        },
    };
}

class _PostModel extends BaseModel<PostAttrs> {
    static table = "rel_posts";
    static primaryKey = "id";
    static timestamps = true;
    static relations: Record<string, TRelationDefinition> = {
        author: { type: "belongsTo", model: () => UserModel, foreignKey: "user_id" },
        comments: { type: "hasMany", model: () => CommentModel, foreignKey: "post_id" },
        tags: {
            type: "belongsToMany",
            model: () => TagModel,
            pivot: "rel_post_tags",
            foreignPivotKey: "post_id",
            relatedPivotKey: "tag_id",
        },
    };
}

class CommentModel extends BaseModel<CommentAttrs> {
    static table = "rel_comments";
    static primaryKey = "id";
    static timestamps = true;
}

class ProfileModel extends BaseModel<ProfileAttrs> {
    static table = "rel_profiles";
    static primaryKey = "id";
    static timestamps = false;
}

interface RoleAttrs {
    id?: string;
    name?: string;
}

class RoleModel extends BaseModel<RoleAttrs> {
    static table = "rel_roles";
    static primaryKey = "id";
    static timestamps = false;
}

// Resolve lazy references
UserModel = _UserModel;
PostModel = _PostModel;

// ── Schema setup ─────────────────────────────────────────────────────

beforeAll(async () => {
    const db = env.DB;
    await db.batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS rel_users (
            id TEXT PRIMARY KEY,
            name TEXT,
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT ''
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS rel_posts (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            title TEXT,
            published INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT ''
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS rel_comments (
            id TEXT PRIMARY KEY,
            post_id TEXT NOT NULL,
            body TEXT,
            approved INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT ''
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS rel_profiles (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            bio TEXT
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS rel_roles (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS rel_user_roles (
            user_id TEXT NOT NULL,
            role_id TEXT NOT NULL,
            PRIMARY KEY (user_id, role_id)
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS rel_post_tags (
            post_id TEXT NOT NULL,
            tag_id TEXT NOT NULL,
            PRIMARY KEY (post_id, tag_id)
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS rel_tags (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL
        )`),
    ]);
});

afterAll(async () => {
    const db = env.DB;
    await db.batch([
        db.prepare("DROP TABLE IF EXISTS rel_post_tags"),
        db.prepare("DROP TABLE IF EXISTS rel_user_roles"),
        db.prepare("DROP TABLE IF EXISTS rel_comments"),
        db.prepare("DROP TABLE IF EXISTS rel_profiles"),
        db.prepare("DROP TABLE IF EXISTS rel_posts"),
        db.prepare("DROP TABLE IF EXISTS rel_tags"),
        db.prepare("DROP TABLE IF EXISTS rel_roles"),
        db.prepare("DROP TABLE IF EXISTS rel_users"),
    ]);
});

beforeEach(async () => {
    const db = env.DB;
    await db.batch([
        db.prepare("DELETE FROM rel_post_tags"),
        db.prepare("DELETE FROM rel_user_roles"),
        db.prepare("DELETE FROM rel_comments"),
        db.prepare("DELETE FROM rel_profiles"),
        db.prepare("DELETE FROM rel_posts"),
        db.prepare("DELETE FROM rel_tags"),
        db.prepare("DELETE FROM rel_roles"),
        db.prepare("DELETE FROM rel_users"),
    ]);
});

// ── Seed helper ──────────────────────────────────────────────────────

async function seedData(db: D1Database) {
    // Users
    await UserModel.create(db, { id: "u1", name: "Alice" });
    await UserModel.create(db, { id: "u2", name: "Bob" });
    await UserModel.create(db, { id: "u3", name: "Charlie" }); // no posts

    // Posts
    await PostModel.create(db, { id: "p1", user_id: "u1", title: "Hello World", published: 1 });
    await PostModel.create(db, { id: "p2", user_id: "u1", title: "Draft Post", published: 0 });
    await PostModel.create(db, { id: "p3", user_id: "u2", title: "Bob's Post", published: 1 });

    // Comments
    await CommentModel.create(db, { id: "c1", post_id: "p1", body: "Great!", approved: 1 });
    await CommentModel.create(db, { id: "c2", post_id: "p1", body: "Spam", approved: 0 });
    await CommentModel.create(db, { id: "c3", post_id: "p3", body: "Nice", approved: 1 });
    // p2 has no comments

    // Profiles
    await db.prepare("INSERT INTO rel_profiles (id, user_id, bio) VALUES (?, ?, ?)").bind("pr1", "u1", "Alice's bio").run();
    // u2 has no profile

    // Roles
    await db.prepare("INSERT INTO rel_roles (id, name) VALUES (?, ?)").bind("r1", "admin").run();
    await db.prepare("INSERT INTO rel_roles (id, name) VALUES (?, ?)").bind("r2", "editor").run();

    // User-Role pivot
    await db.prepare("INSERT INTO rel_user_roles (user_id, role_id) VALUES (?, ?)").bind("u1", "r1").run();
    await db.prepare("INSERT INTO rel_user_roles (user_id, role_id) VALUES (?, ?)").bind("u1", "r2").run();
    await db.prepare("INSERT INTO rel_user_roles (user_id, role_id) VALUES (?, ?)").bind("u2", "r2").run();
    // u3 has no roles

    // Tags
    await db.prepare("INSERT INTO rel_tags (id, name) VALUES (?, ?)").bind("t1", "typescript").run();
    await db.prepare("INSERT INTO rel_tags (id, name) VALUES (?, ?)").bind("t2", "cloudflare").run();

    // Post-Tag pivot
    await db.prepare("INSERT INTO rel_post_tags (post_id, tag_id) VALUES (?, ?)").bind("p1", "t1").run();
    await db.prepare("INSERT INTO rel_post_tags (post_id, tag_id) VALUES (?, ?)").bind("p1", "t2").run();
    await db.prepare("INSERT INTO rel_post_tags (post_id, tag_id) VALUES (?, ?)").bind("p3", "t1").run();
    // p2 has no tags
}

// ── Tests ────────────────────────────────────────────────────────────

describe("has() integration", () => {
    it("filters users that have posts", async () => {
        await seedData(env.DB);
        const users = await UserModel.query().has("posts").get(env.DB);
        const names = users.map((u) => u.get("name"));
        expect(names).toContain("Alice");
        expect(names).toContain("Bob");
        expect(names).not.toContain("Charlie");
    });

    it("filters posts that have comments", async () => {
        await seedData(env.DB);
        const posts = await PostModel.query().has("comments").get(env.DB);
        const titles = posts.map((p) => p.get("title"));
        expect(titles).toContain("Hello World");
        expect(titles).toContain("Bob's Post");
        expect(titles).not.toContain("Draft Post");
    });

    it("filters posts that have an author (belongsTo)", async () => {
        await seedData(env.DB);
        // All posts have authors, so all should be returned
        const posts = await PostModel.query().has("author").get(env.DB);
        expect(posts.length).toBe(3);
    });

    it("filters users that have roles (belongsToMany)", async () => {
        await seedData(env.DB);
        const users = await UserModel.query().has("roles").get(env.DB);
        const names = users.map((u) => u.get("name"));
        expect(names).toContain("Alice");
        expect(names).toContain("Bob");
        expect(names).not.toContain("Charlie");
    });
});

describe("doesntHave() integration", () => {
    it("filters users without posts", async () => {
        await seedData(env.DB);
        const users = await UserModel.query().doesntHave("posts").get(env.DB);
        const names = users.map((u) => u.get("name"));
        expect(names).toEqual(["Charlie"]);
    });

    it("filters posts without comments", async () => {
        await seedData(env.DB);
        const posts = await PostModel.query().doesntHave("comments").get(env.DB);
        const titles = posts.map((p) => p.get("title"));
        expect(titles).toEqual(["Draft Post"]);
    });

    it("filters users without roles (belongsToMany)", async () => {
        await seedData(env.DB);
        const users = await UserModel.query().doesntHave("roles").get(env.DB);
        const names = users.map((u) => u.get("name"));
        expect(names).toEqual(["Charlie"]);
    });
});

describe("whereHas() integration", () => {
    it("filters posts with approved comments", async () => {
        await seedData(env.DB);
        const posts = await PostModel.query()
            .whereHas("comments", (q) => q.where("approved", "=", 1))
            .get(env.DB);
        const titles = posts.map((p) => p.get("title"));
        expect(titles).toContain("Hello World");
        expect(titles).toContain("Bob's Post");
        expect(titles).not.toContain("Draft Post");
    });

    it("filters posts with unapproved comments only", async () => {
        await seedData(env.DB);
        // Only p1 has unapproved comments
        const posts = await PostModel.query()
            .whereHas("comments", (q) => q.where("approved", "=", 0))
            .get(env.DB);
        const titles = posts.map((p) => p.get("title"));
        expect(titles).toEqual(["Hello World"]);
    });

    it("filters users with admin role (belongsToMany + callback)", async () => {
        await seedData(env.DB);
        const users = await UserModel.query()
            .whereHas("roles", (q) => q.where("name", "=", "admin"))
            .get(env.DB);
        const names = users.map((u) => u.get("name"));
        expect(names).toEqual(["Alice"]);
    });

    it("filters users with editor role", async () => {
        await seedData(env.DB);
        const users = await UserModel.query()
            .whereHas("roles", (q) => q.where("name", "=", "editor"))
            .get(env.DB);
        const names = users.map((u) => u.get("name"));
        expect(names).toContain("Alice");
        expect(names).toContain("Bob");
        expect(names).not.toContain("Charlie");
    });
});

describe("whereDoesntHave() integration", () => {
    it("filters posts without approved comments", async () => {
        await seedData(env.DB);
        const posts = await PostModel.query()
            .whereDoesntHave("comments", (q) => q.where("approved", "=", 1))
            .get(env.DB);
        const titles = posts.map((p) => p.get("title"));
        expect(titles).toEqual(["Draft Post"]);
    });
});

describe("combined has() with other conditions", () => {
    it("filters published posts that have comments", async () => {
        await seedData(env.DB);
        const posts = await PostModel.query()
            .where("published", "=", 1)
            .has("comments")
            .get(env.DB);
        const titles = posts.map((p) => p.get("title"));
        expect(titles).toContain("Hello World");
        expect(titles).toContain("Bob's Post");
        expect(titles.length).toBe(2);
    });

    it("filters unpublished posts that have comments", async () => {
        await seedData(env.DB);
        const posts = await PostModel.query()
            .where("published", "=", 0)
            .has("comments")
            .get(env.DB);
        // p2 (Draft Post) has no comments
        expect(posts.length).toBe(0);
    });
});

describe("model.related() integration", () => {
    it("returns related models for hasMany", async () => {
        await seedData(env.DB);
        const user = await UserModel.find(env.DB, "u1");
        expect(user).not.toBeNull();
        const posts = await user!.related("posts").get(env.DB);
        expect(posts.length).toBe(2);
        const titles = posts.map((p) => p.get("title"));
        expect(titles).toContain("Hello World");
        expect(titles).toContain("Draft Post");
    });

    it("returns related model for belongsTo", async () => {
        await seedData(env.DB);
        const post = await PostModel.find(env.DB, "p1");
        expect(post).not.toBeNull();
        const author = await post!.related("author").first(env.DB);
        expect(author).not.toBeNull();
        expect(author!.get("name")).toBe("Alice");
    });

    it("returns related model for hasOne", async () => {
        await seedData(env.DB);
        const user = await UserModel.find(env.DB, "u1");
        const profile = await user!.related("profile").first(env.DB);
        expect(profile).not.toBeNull();
        expect(profile!.get("bio")).toBe("Alice's bio");
    });

    it("returns null for hasOne when no related exists", async () => {
        await seedData(env.DB);
        const user = await UserModel.find(env.DB, "u2");
        const profile = await user!.related("profile").first(env.DB);
        expect(profile).toBeNull();
    });

    it("returns related models for belongsToMany", async () => {
        await seedData(env.DB);
        const user = await UserModel.find(env.DB, "u1");
        const roles = await user!.related("roles").get(env.DB);
        expect(roles.length).toBe(2);
        const names = roles.map((r) => r.get("name"));
        expect(names).toContain("admin");
        expect(names).toContain("editor");
    });

    it("throws for unknown relation", async () => {
        await seedData(env.DB);
        const user = await UserModel.find(env.DB, "u1");
        expect(() => user!.related("nonexistent")).toThrow("Unknown relation 'nonexistent'");
    });
});

describe("auto-derived eager loading via with()", () => {
    it("eager loads hasMany via static relations", async () => {
        await seedData(env.DB);
        const users = await UserModel.query().with(["posts"]).get(env.DB);
        const alice = users.find((u) => u.get("name") === "Alice");
        expect(alice).toBeDefined();
        const posts = alice!.relations.posts as any[];
        expect(posts.length).toBe(2);
    });

    it("eager loads hasOne via static relations", async () => {
        await seedData(env.DB);
        const users = await UserModel.query().with(["profile"]).get(env.DB);
        const alice = users.find((u) => u.get("name") === "Alice");
        expect(alice!.relations.profile).not.toBeNull();
        expect((alice!.relations.profile as any).get("bio")).toBe("Alice's bio");

        const bob = users.find((u) => u.get("name") === "Bob");
        expect(bob!.relations.profile).toBeNull();
    });

    it("eager loads belongsTo via static relations", async () => {
        await seedData(env.DB);
        const posts = await PostModel.query().with(["author"]).get(env.DB);
        const p1 = posts.find((p) => p.get("id") === "p1");
        expect(p1!.relations.author).not.toBeNull();
        expect((p1!.relations.author as any).get("name")).toBe("Alice");
    });

    it("eager loads multiple relations", async () => {
        await seedData(env.DB);
        const users = await UserModel.query().with(["posts", "profile"]).get(env.DB);
        const alice = users.find((u) => u.get("name") === "Alice");
        expect((alice!.relations.posts as any[]).length).toBe(2);
        expect(alice!.relations.profile).not.toBeNull();
    });
});

describe("model.load()", () => {
    it("eager-loads relations onto an existing model instance", async () => {
        await seedData(env.DB);
        const alice = await UserModel.query().whereEq("name", "Alice").first(env.DB);
        expect(alice!.relations.posts).toBeUndefined();

        await alice!.load(env.DB, "posts");
        expect(alice!.relations.posts).toBeDefined();
        expect((alice!.relations.posts as any[]).length).toBe(2);
    });

    it("loads multiple relations in one call", async () => {
        await seedData(env.DB);
        const alice = await UserModel.query().whereEq("name", "Alice").first(env.DB);

        await alice!.load(env.DB, "posts", "profile");
        expect((alice!.relations.posts as any[]).length).toBe(2);
        expect(alice!.relations.profile).not.toBeNull();
    });

    it("returns this for chaining", async () => {
        await seedData(env.DB);
        const alice = await UserModel.query().whereEq("name", "Alice").first(env.DB);
        const result = await alice!.load(env.DB, "posts");
        expect(result).toBe(alice);
    });
});
