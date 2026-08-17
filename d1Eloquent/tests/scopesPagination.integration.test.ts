// scopesPagination.integration.test.ts
// Integration tests for scopes, paginate, pluck, value, chunk

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BaseModel } from "../baseModel";
import { QueryBuilder } from "../queryBuilder";

// ── Model ────────────────────────────────────────────────────────────

interface PostAttrs {
    id?: string;
    title?: string;
    status?: string;
    score?: number;
    created_at?: string | Date;
    updated_at?: string | Date;
}

class Post extends BaseModel<PostAttrs> {
    static table = "scope_posts";
    static primaryKey = "id";
    static timestamps = true;
    static scopes: Record<string, (q: QueryBuilder<any>) => void> = {
        active: (q) => q.where("status", "=", "active"),
        draft: (q) => q.where("status", "=", "draft"),
        highScore: (q) => q.where("score", ">=", 80),
        recent: (q) => q.orderBy("created_at", "desc"),
    };
}

// ── Schema ───────────────────────────────────────────────────────────

beforeAll(async () => {
    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS scope_posts (
            id TEXT PRIMARY KEY,
            title TEXT,
            status TEXT NOT NULL DEFAULT 'draft',
            score INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT ''
        )
    `).run();
});

afterAll(async () => {
    await env.DB.prepare("DROP TABLE IF EXISTS scope_posts").run();
});

beforeEach(async () => {
    await env.DB.prepare("DELETE FROM scope_posts").run();
});

async function seedPosts() {
    for (let i = 1; i <= 25; i++) {
        await Post.create(env.DB, {
            id: `p${String(i).padStart(2, "0")}`,
            title: `Post ${i}`,
            status: i <= 15 ? "active" : "draft",
            score: i * 4,
        });
    }
}

// ── Scopes ──────────────────────────────────────────────────────────

describe("scoped() integration", () => {
    it("applies active scope", async () => {
        await seedPosts();
        const posts = await Post.query().scoped("active").get(env.DB);
        expect(posts.length).toBe(15);
        for (const p of posts) expect(p.get("status")).toBe("active");
    });

    it("applies draft scope", async () => {
        await seedPosts();
        const posts = await Post.query().scoped("draft").get(env.DB);
        expect(posts.length).toBe(10);
    });

    it("chains multiple scopes", async () => {
        await seedPosts();
        const posts = await Post.query().scoped("active", "highScore").get(env.DB);
        // active: 1-15, highScore: score >= 80 → i >= 20 → but only 1-15 are active → none with score >= 80
        // score = i * 4, so score >= 80 means i >= 20. Only active are i=1..15, max score 60.
        expect(posts.length).toBe(0);
    });

    it("combines scope with manual condition", async () => {
        await seedPosts();
        const posts = await Post.query()
            .scoped("active")
            .where("score", ">=", 40)
            .get(env.DB);
        // active i=1..15, score >= 40 means i >= 10
        expect(posts.length).toBe(6); // i=10..15
    });
});

// ── Pagination ──────────────────────────────────────────────────────

describe("paginate() integration", () => {
    it("returns first page with correct metadata", async () => {
        await seedPosts();
        const result = await Post.query().paginate(env.DB, 1, 10);
        expect(result.data.length).toBe(10);
        expect(result.total).toBe(25);
        expect(result.page).toBe(1);
        expect(result.perPage).toBe(10);
        expect(result.lastPage).toBe(3);
    });

    it("returns second page", async () => {
        await seedPosts();
        const result = await Post.query().paginate(env.DB, 2, 10);
        expect(result.data.length).toBe(10);
        expect(result.page).toBe(2);
    });

    it("returns partial last page", async () => {
        await seedPosts();
        const result = await Post.query().paginate(env.DB, 3, 10);
        expect(result.data.length).toBe(5);
        expect(result.lastPage).toBe(3);
    });

    it("respects WHERE filters in pagination", async () => {
        await seedPosts();
        const result = await Post.query()
            .scoped("active")
            .paginate(env.DB, 1, 10);
        expect(result.total).toBe(15);
        expect(result.data.length).toBe(10);
        expect(result.lastPage).toBe(2);
    });

    it("defaults to 15 perPage", async () => {
        await seedPosts();
        const result = await Post.query().paginate(env.DB, 1);
        expect(result.perPage).toBe(15);
        expect(result.data.length).toBe(15);
        expect(result.lastPage).toBe(2);
    });

    it("empty result returns lastPage 1", async () => {
        const result = await Post.query().paginate(env.DB, 1, 10);
        expect(result.total).toBe(0);
        expect(result.data.length).toBe(0);
        expect(result.lastPage).toBe(1);
    });
});

// ── Pluck ───────────────────────────────────────────────────────────

describe("pluck() integration", () => {
    it("returns flat array of column values", async () => {
        await seedPosts();
        const titles = await Post.query().limit(3).pluck(env.DB, "title") as string[];
        expect(titles.length).toBe(3);
        expect(typeof titles[0]).toBe("string");
    });

    it("respects WHERE filters", async () => {
        await seedPosts();
        const ids = await Post.query().scoped("draft").pluck(env.DB, "id");
        expect(ids.length).toBe(10);
    });

    it("returns empty array when no results", async () => {
        const ids = await Post.query().pluck(env.DB, "id");
        expect(ids).toEqual([]);
    });
});

// ── Value ───────────────────────────────────────────────────────────

describe("value() integration", () => {
    it("returns single scalar", async () => {
        await seedPosts();
        const title = await Post.query().whereEq("id", "p01").value(env.DB, "title");
        expect(title).toBe("Post 1");
    });

    it("returns null when not found", async () => {
        const title = await Post.query().whereEq("id", "nonexistent").value(env.DB, "title");
        expect(title).toBeNull();
    });

    it("returns numeric value", async () => {
        await seedPosts();
        const score = await Post.query().whereEq("id", "p05").value(env.DB, "score");
        expect(score).toBe(20);
    });
});

// ── Chunk ───────────────────────────────────────────────────────────

describe("chunk() integration", () => {
    it("processes all rows in chunks", async () => {
        await seedPosts();
        const allIds: string[] = [];
        await Post.query().chunk(env.DB, 10, async (posts) => {
            for (const p of posts) allIds.push(p.get("id") as string);
        });
        expect(allIds.length).toBe(25);
    });

    it("stops when callback returns false", async () => {
        await seedPosts();
        let chunkCount = 0;
        await Post.query().chunk(env.DB, 10, async () => {
            chunkCount++;
            if (chunkCount >= 2) return false;
        });
        expect(chunkCount).toBe(2);
    });

    it("respects WHERE filters", async () => {
        await seedPosts();
        const ids: string[] = [];
        await Post.query().scoped("active").chunk(env.DB, 5, async (posts) => {
            for (const p of posts) ids.push(p.get("id") as string);
        });
        expect(ids.length).toBe(15);
    });

    it("handles empty results", async () => {
        let called = false;
        await Post.query().chunk(env.DB, 10, async () => {
            called = true;
        });
        expect(called).toBe(false);
    });
});
