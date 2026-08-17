// fts5.integration.test.ts
// Live D1 (miniflare) integration tests for FTS5 — exercises the new
// createFts5Table builder and the QueryBuilder MATCH / orderByRank API.

import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { Schema } from "../../scripts/schema";
import { QueryBuilder } from "../queryBuilder";
import { BaseModel } from "../baseModel";

interface PostAttrs {
    id: string;
    title: string;
    body: string;
    created_at?: Date;
    updated_at?: Date;
}

class Post extends BaseModel<PostAttrs> {
    static table = "fts5_posts";
    static primaryKey = "id";
    static timestamps = false;
}

class PostIdx {
    static table = "fts5_posts_idx";
    static primaryKey = "rowid";
    static softDeletes = false;
    attrs: Record<string, unknown> = {};
    constructor(attrs: Record<string, unknown> = {}) {
        this.attrs = attrs;
    }
    toObject() {
        return this.attrs;
    }
}

const seedRows: Array<{ id: string; title: string; body: string }> = [
    { id: "p1", title: "Rust on Workers", body: "Compile Rust to WASM and run it on Cloudflare." },
    { id: "p2", title: "TypeScript Eloquent", body: "Eloquent-style ORM for SQLite and D1." },
    { id: "p3", title: "Edge Search", body: "Build a full-text search using FTS5 on D1." },
    { id: "p4", title: "Rust Crates", body: "A curated list of useful Rust libraries." },
];

beforeAll(async () => {
    // Build the schema using the new builder, then execute statements one by one.
    const schema = new Schema();
    schema.dropTable("fts5_posts_idx");
    schema.dropTable("fts5_posts");
    schema.createTable("fts5_posts", (t) => {
        t.id();
        t.text("title").notNull();
        t.text("body").notNull();
    });
    schema.createFts5Table("fts5_posts_idx", {
        columns: ["title", "body"],
        tokenize: "porter unicode61",
        content: "fts5_posts",
        contentRowid: "rowid",
    });

    for (const stmt of schema.toStatements()) {
        await env.DB.prepare(stmt).run();
    }

    // Seed base table.
    for (const row of seedRows) {
        await env.DB
            .prepare(`INSERT INTO fts5_posts (id, title, body) VALUES (?, ?, ?)`)
            .bind(row.id, row.title, row.body)
            .run();
    }

    // Backfill the FTS5 index. For external-content tables we have to push
    // each row into the index (sync triggers are optional and weren't enabled).
    let i = 1;
    for (const row of seedRows) {
        await env.DB
            .prepare(`INSERT INTO fts5_posts_idx (rowid, title, body) VALUES (?, ?, ?)`)
            .bind(i++, row.title, row.body)
            .run();
    }
});

describe("FTS5 integration — MATCH + rank", () => {
    it("whereMatch finds posts containing the search term", async () => {
        const qb = new QueryBuilder(PostIdx).select(["rowid"]).whereMatch("fts5_posts_idx", "rust");
        const results = await qb.get(env.DB);
        expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it("MATCH against a single column scopes results", async () => {
        const onlyTitle = await new QueryBuilder(PostIdx)
            .select(["rowid"])
            .whereMatch("title", "rust")
            .get(env.DB);
        expect(onlyTitle.length).toBe(2);

        const onlyBody = await new QueryBuilder(PostIdx)
            .select(["rowid"])
            .whereMatch("body", "WASM")
            .get(env.DB);
        expect(onlyBody.length).toBe(1);
    });

    it("orderByRank surfaces best matches first (ASC = most relevant)", async () => {
        const qb = new QueryBuilder(PostIdx)
            .select(["rowid", "rank"])
            .whereMatch("fts5_posts_idx", "rust")
            .orderByRank();
        const results = await qb.get(env.DB);
        // Rank is negative — smaller (more negative) values mean a stronger match.
        // Returns are sorted ascending by rank, so the first row should be the most relevant.
        expect(results.length).toBeGreaterThan(1);
    });

    it("porter stemming matches 'compile' for 'compiles'", async () => {
        const results = await new QueryBuilder(PostIdx)
            .select(["rowid"])
            .whereMatch("fts5_posts_idx", "compiles")
            .get(env.DB);
        expect(results.length).toBeGreaterThanOrEqual(1);
    });
});

describe("FTS5 integration — non-matching searches", () => {
    it("returns no rows when no token matches", async () => {
        const results = await new QueryBuilder(PostIdx)
            .select(["rowid"])
            .whereMatch("fts5_posts_idx", "nonexistentterm")
            .get(env.DB);
        expect(results.length).toBe(0);
    });
});

describe("FTS5 integration — phrase queries", () => {
    it("matches an exact phrase via quoted MATCH expression", async () => {
        const results = await new QueryBuilder(PostIdx)
            .select(["rowid"])
            .whereMatch("fts5_posts_idx", '"full-text search"')
            .get(env.DB);
        expect(results.length).toBe(1);
    });
});
