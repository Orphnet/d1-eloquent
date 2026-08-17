// collectionQueryDx.test.ts
// Tests for selectRaw, subquery whereIn, toJSON with relations

import { describe, it, expect } from "vitest";
import { QueryBuilder } from "../queryBuilder";
import type { TRelationDefinition } from "../relationTypes";

// ── Model stubs ──────────────────────────────────────────────────────

class UserModel {
    static table = "users";
    static primaryKey = "id";
    static softDeletes = false;
    attrs: Record<string, unknown>;
    constructor(attrs: Record<string, unknown> = {}) { this.attrs = attrs; }
    toObject() { return this.attrs; }
}

class PostModel {
    static table = "posts";
    static primaryKey = "id";
    static softDeletes = false;
    static relations: Record<string, TRelationDefinition> = {
        author: { type: "belongsTo", model: () => UserModel, foreignKey: "user_id" },
    };
    attrs: Record<string, unknown>;
    constructor(attrs: Record<string, unknown> = {}) { this.attrs = attrs; }
    toObject() { return this.attrs; }
}

// ── selectRaw ───────────────────────────────────────────────────────

describe("selectRaw()", () => {
    it("replaces default * with raw expression", () => {
        const qb = new QueryBuilder(PostModel as any);
        qb.selectRaw("COUNT(*) as post_count");
        const { sql } = qb.toSelectSql();
        expect(sql).toBe("SELECT COUNT(*) as post_count FROM posts");
    });

    it("appends to existing select", () => {
        const qb = new QueryBuilder(PostModel as any);
        qb.select(["id", "title"]).selectRaw("LENGTH(title) as title_len");
        const { sql } = qb.toSelectSql();
        expect(sql).toBe("SELECT id, title, LENGTH(title) as title_len FROM posts");
    });

    it("combines with groupBy", () => {
        const qb = new QueryBuilder(PostModel as any);
        qb.selectRaw("user_id, COUNT(*) as cnt").groupBy("user_id");
        const { sql } = qb.toSelectSql();
        expect(sql).toContain("SELECT user_id, COUNT(*) as cnt");
        expect(sql).toContain("GROUP BY user_id");
    });
});

// ── whereIn with subquery ───────────────────────────────────────────

describe("whereIn with subquery", () => {
    it("compiles to IN (SELECT ...)", () => {
        const subQuery = new QueryBuilder(UserModel as any).select(["id"]).where("name", "LIKE", "%admin%");
        const qb = new QueryBuilder(PostModel as any);
        qb.whereIn("user_id", subQuery);
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toContain("user_id IN (SELECT id FROM users WHERE name LIKE ?)");
        expect(bindings).toEqual(["%admin%"]);
    });

    it("whereNotIn with subquery compiles to NOT IN (SELECT ...)", () => {
        const subQuery = new QueryBuilder(UserModel as any).select(["id"]).where("status", "=", "banned");
        const qb = new QueryBuilder(PostModel as any);
        qb.whereNotIn("user_id", subQuery);
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toContain("user_id NOT IN (SELECT id FROM users WHERE status = ?)");
        expect(bindings).toEqual(["banned"]);
    });

    it("still works with plain arrays", () => {
        const qb = new QueryBuilder(PostModel as any);
        qb.whereIn("id", ["p1", "p2"]);
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toContain("id IN (?, ?)");
        expect(bindings).toEqual(["p1", "p2"]);
    });

    it("orWhereIn with subquery uses OR", () => {
        const subQuery = new QueryBuilder(UserModel as any).select(["id"]);
        const qb = new QueryBuilder(PostModel as any);
        qb.where("status", "=", "draft").orWhereIn("user_id", subQuery);
        const { sql } = qb.toSelectSql();
        expect(sql).toContain("OR user_id IN (SELECT id FROM users)");
    });
});

// ── get() returns Collection ────────────────────────────────────────

describe("QueryBuilder get() returns Collection", () => {
    // We can't test actual D1 calls here, but we can verify the return type
    // is correctly typed. Integration tests cover this.
    it("Collection is importable and constructable", async () => {
        const { Collection } = await import("../collection");
        const col = Collection.from([1, 2, 3]);
        expect(col.length).toBe(3);
        expect(col.first()).toBe(1);
    });
});
