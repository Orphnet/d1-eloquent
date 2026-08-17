// queryShortcuts.integration.test.ts
// Live D1 tests for whereRelation / orWhereRelation / firstWhere.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BaseModel } from "../baseModel";
import type { TRelationDefinition } from "../relationTypes";

interface PostAttrs {
    id?: string;
    title?: string;
    votes?: number;
    created_at?: string | Date;
    updated_at?: string | Date;
}
interface CommentAttrs {
    id?: string;
    post_id?: string;
    approved?: number;
    score?: number;
    body?: string;
    created_at?: string | Date;
    updated_at?: string | Date;
}

class QsComment extends BaseModel<CommentAttrs> {
    static table = "qs_comments";
}
class QsPost extends BaseModel<PostAttrs> {
    static table = "qs_posts";
    static relations: Record<string, TRelationDefinition> = {
        comments: { type: "hasMany", model: () => QsComment, foreignKey: "post_id" },
    };
}

beforeAll(async () => {
    await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS qs_posts (id TEXT PRIMARY KEY, title TEXT, votes INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT)`,
    ).run();
    await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS qs_comments (id TEXT PRIMARY KEY, post_id TEXT, approved INTEGER DEFAULT 0, score INTEGER DEFAULT 0, body TEXT, created_at TEXT, updated_at TEXT)`,
    ).run();
});

beforeEach(async () => {
    await env.DB.prepare("DELETE FROM qs_posts").run();
    await env.DB.prepare("DELETE FROM qs_comments").run();
});

describe("whereRelation() / orWhereRelation()", () => {
    it("filters parents by a single related condition (2-arg, =)", async () => {
        await QsPost.create(env.DB, { id: "p1", title: "has-approved", votes: 1 });
        await QsPost.create(env.DB, { id: "p2", title: "no-approved", votes: 1 });
        await QsComment.create(env.DB, { id: "c1", post_id: "p1", approved: 1 });
        await QsComment.create(env.DB, { id: "c2", post_id: "p2", approved: 0 });

        const rows = await QsPost.query().whereRelation("comments", "approved", 1).get(env.DB);
        expect(rows.map((r) => r.get("id"))).toEqual(["p1"]);
    });

    it("supports an explicit operator (3-arg)", async () => {
        await QsPost.create(env.DB, { id: "p1", title: "hot" });
        await QsPost.create(env.DB, { id: "p2", title: "cold" });
        await QsComment.create(env.DB, { id: "c1", post_id: "p1", score: 10 });
        await QsComment.create(env.DB, { id: "c2", post_id: "p2", score: 2 });

        const rows = await QsPost.query().whereRelation("comments", "score", ">", 5).get(env.DB);
        expect(rows.map((r) => r.get("id"))).toEqual(["p1"]);
    });

    it("orWhereRelation ORs with an existing filter", async () => {
        await QsPost.create(env.DB, { id: "p1", title: "keep-by-title" });
        await QsPost.create(env.DB, { id: "p2", title: "keep-by-relation" });
        await QsPost.create(env.DB, { id: "p3", title: "drop" });
        await QsComment.create(env.DB, { id: "c2", post_id: "p2", approved: 1 });

        const rows = await QsPost.query()
            .whereEq("title", "keep-by-title")
            .orWhereRelation("comments", "approved", 1)
            .get(env.DB);
        expect(rows.map((r) => r.get("id")).sort()).toEqual(["p1", "p2"]);
    });
});

describe("firstWhere()", () => {
    beforeEach(async () => {
        await QsPost.create(env.DB, { id: "p1", title: "Hello", votes: 3 });
        await QsPost.create(env.DB, { id: "p2", title: "World", votes: 20 });
    });

    it("returns the first row matching an equality (2-arg)", async () => {
        const post = await QsPost.query(env.DB).firstWhere("title", "Hello");
        expect(post?.get("id")).toBe("p1");
    });

    it("supports an explicit operator (3-arg)", async () => {
        const post = await QsPost.query(env.DB).firstWhere("votes", ">", 10);
        expect(post?.get("id")).toBe("p2");
    });

    it("accepts a db-first argument", async () => {
        const post = await QsPost.query().firstWhere(env.DB, "title", "World");
        expect(post?.get("id")).toBe("p2");
    });

    it("returns null when nothing matches", async () => {
        const post = await QsPost.query(env.DB).firstWhere("title", "Nope");
        expect(post).toBeNull();
    });
});

describe("operator safety + arg discrimination (#44)", () => {
    it("rejects an invalid SQL operator at runtime instead of interpolating it", () => {
        expect(() => QsPost.query().where("votes", "BOGUS" as never, 1)).toThrow(/Invalid SQL operator/);
        expect(() => QsPost.query().where("votes", "; DROP TABLE qs_posts" as never, 1)).toThrow(/Invalid SQL operator/);
    });

    it("does not silently reinterpret an explicit-undefined value as the operator", async () => {
        await QsPost.create(env.DB, { id: "p1", title: "t" });
        await QsComment.create(env.DB, { id: "c1", post_id: "p1", body: ">" }); // body equals the op string
        // The bug collapsed (col, '>', undefined) to `body = '>'`, silently matching c1
        // and leaking p1. Now '>' stays the operator, so an undefined value surfaces
        // loudly rather than returning a wrong result.
        await expect(QsPost.query().whereRelation("comments", "body", ">", undefined).get(env.DB)).rejects.toThrow();
        // The 2-value form is unaffected: here ">" is the VALUE, so `body = ">"` matches p1.
        const eq = await QsPost.query().whereRelation("comments", "body", ">").get(env.DB);
        expect(eq.map((r) => r.get("id"))).toEqual(["p1"]);
    });
});

describe("operator safety - beta.3 hardening extends assertOp to HAVING / whereColumn / GLOB", () => {
    it("having()/orHaving() reject an injected operator (same guard as where())", () => {
        expect(() => QsPost.query().groupBy("votes").having("votes", "> (SELECT 1) OR votes <" as never, 0))
            .toThrow(/Invalid SQL operator/);
        expect(() => QsPost.query().groupBy("votes").orHaving("votes", "; DROP TABLE qs_posts --" as never, 0))
            .toThrow(/Invalid SQL operator/);
    });

    it("whereColumn()/orWhereColumn() reject an injected operator (unbound identifier comparison)", () => {
        expect(() => QsPost.query().whereColumn("votes", "= created_at UNION SELECT 1 --", "votes"))
            .toThrow(/Invalid SQL operator/);
        expect(() => QsPost.query().orWhereColumn("votes", "BOGUS", "votes"))
            .toThrow(/Invalid SQL operator/);
    });

    it("whereColumn() 2-arg default-'=' form is unaffected", () => {
        expect(() => QsPost.query().whereColumn("updated_at", "created_at")).not.toThrow();
    });

    it("GLOB is now an accepted, working operator (was dead: assertOp rejected what PATTERN_OPS enumerates)", async () => {
        await QsPost.create(env.DB, { id: "p1", title: "has-approved", votes: 1 });
        await QsPost.create(env.DB, { id: "p2", title: "no-approved", votes: 1 });
        expect(() => QsPost.query().where("title", "GLOB" as never, "has-*")).not.toThrow();
        const rows = await QsPost.query().where("title", "GLOB" as never, "has-*").get(env.DB);
        expect(rows.map((r) => r.get("id"))).toEqual(["p1"]);
    });
});
