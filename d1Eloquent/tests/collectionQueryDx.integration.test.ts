// collectionQueryDx.integration.test.ts
// Integration tests for Collection, selectRaw, subquery whereIn, toJSON

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BaseModel } from "../baseModel";
import { Collection } from "../collection";
import { QueryBuilder } from "../queryBuilder";
import type { TRelationDefinition } from "../relationTypes";

// ── Models ───────────────────────────────────────────────────────────

interface UserAttrs {
    id?: string;
    name?: string;
    status?: string;
    created_at?: string | Date;
    updated_at?: string | Date;
}

interface PostAttrs {
    id?: string;
    user_id?: string;
    title?: string;
    created_at?: string | Date;
    updated_at?: string | Date;
}

let UserModel: typeof _UserModel;
let PostModel: typeof _PostModel;

class _UserModel extends BaseModel<UserAttrs> {
    static table = "cdx_users";
    static primaryKey = "id";
    static timestamps = true;
    static relations: Record<string, TRelationDefinition> = {
        posts: { type: "hasMany", model: () => PostModel, foreignKey: "user_id" },
    };
}

class _PostModel extends BaseModel<PostAttrs> {
    static table = "cdx_posts";
    static primaryKey = "id";
    static timestamps = true;
    static relations: Record<string, TRelationDefinition> = {
        author: { type: "belongsTo", model: () => UserModel, foreignKey: "user_id" },
    };
}

UserModel = _UserModel;
PostModel = _PostModel;

// ── Schema ───────────────────────────────────────────────────────────

beforeAll(async () => {
    const db = env.DB;
    await db.batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS cdx_users (
            id TEXT PRIMARY KEY, name TEXT, status TEXT DEFAULT 'active',
            created_at TEXT DEFAULT '', updated_at TEXT DEFAULT ''
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS cdx_posts (
            id TEXT PRIMARY KEY, user_id TEXT, title TEXT,
            created_at TEXT DEFAULT '', updated_at TEXT DEFAULT ''
        )`),
    ]);
});

afterAll(async () => {
    const db = env.DB;
    await db.batch([
        db.prepare("DROP TABLE IF EXISTS cdx_posts"),
        db.prepare("DROP TABLE IF EXISTS cdx_users"),
    ]);
});

beforeEach(async () => {
    await env.DB.batch([
        env.DB.prepare("DELETE FROM cdx_posts"),
        env.DB.prepare("DELETE FROM cdx_users"),
    ]);
});

async function seed() {
    await UserModel.create(env.DB, { id: "u1", name: "Alice", status: "active" });
    await UserModel.create(env.DB, { id: "u2", name: "Bob", status: "active" });
    await UserModel.create(env.DB, { id: "u3", name: "Charlie", status: "banned" });

    await PostModel.create(env.DB, { id: "p1", user_id: "u1", title: "Post A" });
    await PostModel.create(env.DB, { id: "p2", user_id: "u1", title: "Post B" });
    await PostModel.create(env.DB, { id: "p3", user_id: "u2", title: "Post C" });
    await PostModel.create(env.DB, { id: "p4", user_id: "u3", title: "Post D" });
}

// ── Collection from get() ───────────────────────────────────────────

describe("get() returns Collection", () => {
    it("result is a Collection instance", async () => {
        await seed();
        const users = await UserModel.query().get(env.DB);
        expect(users).toBeInstanceOf(Collection);
        expect(users).toBeInstanceOf(Array);
    });

    it("Collection methods work on query results", async () => {
        await seed();
        const users = await UserModel.query().get(env.DB);

        expect(users.pluck("name")).toContain("Alice");
        expect(users.first()!.get("id")).toBeDefined();
        expect(users.isEmpty()).toBe(false);

        const byId = users.keyBy("id");
        expect(byId.get("u1")!.get("name")).toBe("Alice");
    });

    it("groupBy works on query results", async () => {
        await seed();
        const posts = await PostModel.query().get(env.DB);
        const grouped = posts.groupBy("user_id");
        expect(grouped.get("u1")!.length).toBe(2);
        expect(grouped.get("u2")!.length).toBe(1);
    });

    it("partition works on query results", async () => {
        await seed();
        const users = await UserModel.query().get(env.DB);
        const [active, banned] = users.partition((u) => u.get("status") === "active");
        expect(active.length).toBe(2);
        expect(banned.length).toBe(1);
    });
});

// ── selectRaw ───────────────────────────────────────────────────────

describe("selectRaw() integration", () => {
    it("executes raw SELECT expressions", async () => {
        await seed();
        const result = await PostModel.query()
            .selectRaw("user_id, COUNT(*) as cnt")
            .groupBy("user_id")
            .get(env.DB);

        expect(result.length).toBe(3);
        const u1 = result.find((r) => r.get("user_id") === "u1");
        expect(u1).toBeDefined();
        // cnt comes through as raw attr
        expect((u1 as any).get("cnt")).toBe(2);
    });
});

// ── whereIn subquery ────────────────────────────────────────────────

describe("whereIn subquery integration", () => {
    it("filters by subquery results", async () => {
        await seed();
        // Get posts by active users only
        const activeUserIds = UserModel.query().select(["id"]).where("status", "=", "active");
        const posts = await PostModel.query().whereIn("user_id", activeUserIds).get(env.DB);

        const titles = posts.pluck("title");
        expect(titles).toContain("Post A");
        expect(titles).toContain("Post B");
        expect(titles).toContain("Post C");
        expect(titles).not.toContain("Post D"); // Charlie is banned
    });

    it("whereNotIn with subquery excludes results", async () => {
        await seed();
        const bannedUserIds = UserModel.query().select(["id"]).where("status", "=", "banned");
        const posts = await PostModel.query().whereNotIn("user_id", bannedUserIds).get(env.DB);

        expect(posts.length).toBe(3);
        expect(posts.pluck("title")).not.toContain("Post D");
    });
});

// ── toJSON with relations ───────────────────────────────────────────

describe("toJSON() with relations", () => {
    it("includes loaded relations", async () => {
        await seed();
        const users = await UserModel.query().with(["posts"]).get(env.DB);
        const alice = users.find((u) => u.get("name") === "Alice")!;

        const json = alice.toJSON();
        expect(json.name).toBe("Alice");
        expect(json.posts).toBeDefined();
        expect(Array.isArray(json.posts)).toBe(true);
        expect((json.posts as any[]).length).toBe(2);
        // Nested posts should be plain objects
        expect((json.posts as any[])[0].title).toBeDefined();
    });

    it("includes belongsTo relation", async () => {
        await seed();
        const posts = await PostModel.query().with(["author"]).get(env.DB);
        const p1 = posts.find((p) => p.get("id") === "p1")!;

        const json = p1.toJSON();
        expect(json.author).toBeDefined();
        expect((json.author as any).name).toBe("Alice");
    });

    it("handles null relations", async () => {
        await seed();
        const user = await UserModel.find(env.DB, "u1");
        // No relations loaded
        const json = user!.toJSON();
        // relations object is empty, so no extra keys
        expect(json.id).toBe("u1");
    });
});

// ── paginate returns Collection ─────────────────────────────────────

describe("paginate() returns Collection in data", () => {
    it("data is a Collection instance", async () => {
        await seed();
        const result = await UserModel.query().paginate(env.DB, 1, 10);
        expect(result.data).toBeInstanceOf(Collection);
    });
});

// ── Collection.where/whereIn with model instances ─────────────────

describe("Collection filtering on query results", () => {
    it("where() filters by model attribute via get()", async () => {
        await seed();
        const users = await UserModel.query().get(env.DB);
        const active = users.where("status", "active");
        expect(active).toBeInstanceOf(Collection);
        expect(active.length).toBeGreaterThan(0);
        for (const u of active) {
            expect(u.get("status")).toBe("active");
        }
    });

    it("whereIn() filters by set of values via get()", async () => {
        await seed();
        const users = await UserModel.query().get(env.DB);
        const subset = users.whereIn("id", ["u1", "u2"]);
        expect(subset).toBeInstanceOf(Collection);
        expect(subset.length).toBe(2);
    });

    it("chain: filter → map → pluck on query results", async () => {
        await seed();
        const users = await UserModel.query().get(env.DB);
        const names = users
            .where("status", "active")
            .map((u) => u.get("name") as string);
        expect(names).toBeInstanceOf(Collection);
        expect(names.length).toBeGreaterThan(0);
        for (const n of names) {
            expect(typeof n).toBe("string");
        }
    });
});
