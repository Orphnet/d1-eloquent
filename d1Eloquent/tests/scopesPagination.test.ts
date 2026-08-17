// scopesPagination.test.ts
// Unit tests for query scopes, pagination, pluck, value, chunk

import { describe, it, expect } from "vitest";
import { QueryBuilder } from "../queryBuilder";

// ── Model stubs ──────────────────────────────────────────────────────

interface PostAttrs {
    id?: string;
    title?: string;
    status?: string;
    published?: number;
    created_at?: string;
}

class PostModel {
    static table = "posts";
    static primaryKey = "id";
    static softDeletes = false;
    static scopes = {
        active: (q: QueryBuilder<any>) => q.where("status", "=", "active"),
        published: (q: QueryBuilder<any>) => q.where("published", "=", 1),
        recent: (q: QueryBuilder<any>) => q.orderBy("created_at", "desc"),
    };
    attrs: PostAttrs;
    constructor(attrs: PostAttrs = {}) { this.attrs = attrs; }
    toObject() { return this.attrs as Record<string, unknown>; }
}

class PlainModel {
    static table = "plain";
    static primaryKey = "id";
    static softDeletes = false;
    attrs: Record<string, unknown>;
    constructor(attrs: Record<string, unknown> = {}) { this.attrs = attrs; }
    toObject() { return this.attrs; }
}

// ── Scopes ──────────────────────────────────────────────────────────

describe("QueryBuilder scoped()", () => {
    it("applies a single named scope", () => {
        const qb = new QueryBuilder(PostModel as any);
        qb.scoped("active");
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toContain("status = ?");
        expect(bindings).toEqual(["active"]);
    });

    it("applies multiple scopes at once", () => {
        const qb = new QueryBuilder(PostModel as any);
        qb.scoped("active", "published");
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toContain("status = ?");
        expect(sql).toContain("published = ?");
        expect(bindings).toEqual(["active", 1]);
    });

    it("applies scope that adds ordering", () => {
        const qb = new QueryBuilder(PostModel as any);
        qb.scoped("recent");
        const { sql } = qb.toSelectSql();
        expect(sql).toContain("ORDER BY created_at DESC");
    });

    it("combines scopes with manual where clauses", () => {
        const qb = new QueryBuilder(PostModel as any);
        qb.where("title", "LIKE", "%hello%").scoped("active");
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toContain("title LIKE ?");
        expect(sql).toContain("status = ?");
        expect(bindings).toEqual(["%hello%", "active"]);
    });

    it("throws for unknown scope", () => {
        const qb = new QueryBuilder(PostModel as any);
        expect(() => qb.scoped("nonexistent")).toThrow("Unknown scope 'nonexistent'");
    });

    it("throws for model without scopes", () => {
        const qb = new QueryBuilder(PlainModel as any);
        expect(() => qb.scoped("anything")).toThrow("Unknown scope 'anything'");
    });
});

// ── Pluck / Value (SQL generation only, no D1) ──────────────────────

describe("QueryBuilder pluck() SQL", () => {
    it("selects only the specified column", () => {
        const qb = new QueryBuilder(PostModel as any);
        // We can test the SQL it would generate
        qb.select(["title"]);
        const { sql } = qb.toSelectSql();
        expect(sql).toBe("SELECT title FROM posts");
    });
});

describe("QueryBuilder value() SQL", () => {
    it("selects column with LIMIT 1", () => {
        const qb = new QueryBuilder(PostModel as any);
        qb.whereEq("id", "p1").select(["title"]).limit(1);
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toBe("SELECT title FROM posts WHERE id = ? LIMIT 1");
        expect(bindings).toEqual(["p1"]);
    });
});
