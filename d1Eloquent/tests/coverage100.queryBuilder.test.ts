// coverage100.queryBuilder.test.ts
// Closes the remaining coverage gaps in d1Eloquent/queryBuilder.ts:
// cursor codec fallbacks, orWhereJsonContains, epochModifier on qualified
// columns, relation-constraint edge cases, eager-constraint merging,
// soft-delete alias fallback, default-argument raw clauses, empty global
// scopes, aggregate fallbacks over empty sets, paginate defaults, empty
// `returning` guards, prepared step defaults, JSON-update default-db forms,
// no-where prepared JSON updates, and driver responses missing meta/results.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { BaseModel } from "../baseModel";
import { placeholder, type QueryBuilder, type TPaginationResult } from "../queryBuilder";
import type { TRelationDefinition } from "../relationTypes";

// ── Models ───────────────────────────────────────────────────────────

interface PostAttrs {
    id?: string;
    title?: string;
    views?: number;
    score?: number;
    meta?: string;
    tags?: string;
    published_at?: number | Date;
    created_at?: string;
}

interface CommentAttrs {
    id?: string;
    post_id?: string;
    approved?: number;
    body?: string;
}

class CComment extends BaseModel<CommentAttrs> {
    static table = "c100_comments";
    static timestamps = false;
}

class CPost extends BaseModel<PostAttrs> {
    static table = "c100_posts";
    static timestamps = false;
    static casts = { published_at: "timestamp" } as const;
    static relations: Record<string, TRelationDefinition> = {
        comments: { type: "hasMany", model: () => CComment, foreignKey: "post_id" },
    };
}

interface SoftAttrs {
    id?: string;
    name?: string;
    deleted_at?: string | null;
}

class CSoft extends BaseModel<SoftAttrs> {
    static table = "c100_soft";
    static timestamps = false;
    static softDeletes = true;
}

interface ScopedAttrs {
    id?: string;
    active?: number;
}

class CScoped extends BaseModel<ScopedAttrs> {
    static table = "c100_scoped";
    static timestamps = false;
    static globalScopes = {
        // Contributes no where clauses - exercises the "empty scope" skip path.
        noop: (_q: QueryBuilder<CScoped>) => {},
        active: (q: QueryBuilder<CScoped>) => q.whereEq("active", 1),
    };
}

// ── Stub DB: a D1-shaped driver whose responses omit meta AND results ─

type TStubStmt = {
    bind: (...args: unknown[]) => TStubStmt;
    all: () => Promise<Record<string, unknown>>;
    run: () => Promise<Record<string, unknown>>;
    first: () => Promise<null>;
};

function makeStubDb(): D1Database {
    const stmt: TStubStmt = {
        bind: () => stmt,
        all: async () => ({}),
        run: async () => ({}),
        first: async () => null,
    };
    return { prepare: () => stmt } as unknown as D1Database;
}

// ── Schema + seed ────────────────────────────────────────────────────

beforeAll(async () => {
    for (const sql of [
        `CREATE TABLE IF NOT EXISTS c100_posts (
            id TEXT PRIMARY KEY, title TEXT, views INTEGER DEFAULT 0, score INTEGER DEFAULT 0,
            meta TEXT, tags TEXT, published_at INTEGER, created_at TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS c100_comments (
            id TEXT PRIMARY KEY, post_id TEXT, approved INTEGER DEFAULT 0, body TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS c100_scoped (id TEXT PRIMARY KEY, active INTEGER)`,
    ]) {
        await env.DB.prepare(sql).run();
    }
});

beforeEach(async () => {
    for (const t of ["c100_posts", "c100_comments", "c100_scoped"]) {
        await env.DB.prepare(`DELETE FROM ${t}`).run();
    }

    const insertPost = (
        id: string, title: string, views: number, meta: string, tags: string, createdAt: string,
    ) => env.DB
        .prepare("INSERT INTO c100_posts (id, title, views, score, meta, tags, published_at, created_at) VALUES (?, ?, ?, 0, ?, ?, 1768521600, ?)")
        .bind(id, title, views, meta, tags, createdAt)
        .run();

    await insertPost("p1", "Alpha", 10, '{"role":"user","labels":["x","vip"]}', '["a","b"]', "2026-01-01T00:00:00Z");
    await insertPost("p2", "Beta", 200, "{}", '["b","c"]', "2026-01-02T00:00:00Z");
    await insertPost("p3", "Gamma", 5, "{}", "[]", "2026-01-03T00:00:00Z");
    await insertPost("p4", "Delta", 7, "{}", "[]", "2026-01-04T00:00:00Z");
    await insertPost("p5", "Epsilon", 8, "{}", "[]", "2026-01-05T00:00:00Z");
    await insertPost("p6", "Zeta", 9, "{}", "[]", "2026-01-06T00:00:00Z");

    const insertComment = (id: string, postId: string, approved: number, body: string) =>
        env.DB
            .prepare("INSERT INTO c100_comments (id, post_id, approved, body) VALUES (?, ?, ?, ?)")
            .bind(id, postId, approved, body)
            .run();

    await insertComment("c1", "p1", 1, "one");
    await insertComment("c2", "p1", 0, "two");
    await insertComment("c3", "p1", 1, "three");
    await insertComment("c4", "p2", 1, "four");

    await env.DB.prepare("INSERT INTO c100_scoped (id, active) VALUES ('s1', 1), ('s2', 0)").run();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

// ── queryBuilder.ts ──────────────────────────────────────────────────

describe("queryBuilder.ts - cursor codec", () => {
    it("rejects a decodable cursor whose payload is not a {col, pk} object", async () => {
        // Valid base64 + valid JSON, but a number - fails the shape check.
        const numeric = btoa(JSON.stringify(123));
        await expect(
            CPost.query().paginateCursor({ orderBy: "id", after: numeric }, env.DB),
        ).rejects.toThrow(/invalid cursor/);

        // Valid object but missing `pk` - also malformed.
        const missingPk = btoa(JSON.stringify({ col: 1 }));
        await expect(
            CPost.query().paginateCursor({ orderBy: "id", after: missingPk }, env.DB),
        ).rejects.toThrow(/invalid cursor/);
    });

    it("encodes and decodes cursors via Buffer when btoa/atob are unavailable", async () => {
        // Baseline cursor produced with the native btoa path.
        const viaBtoa = await CPost.query().paginateCursor(
            { orderBy: "created_at", direction: "desc", perPage: 2 },
            env.DB,
        );
        expect(viaBtoa.nextCursor).toBeTruthy();

        vi.stubGlobal("btoa", undefined);
        vi.stubGlobal("atob", undefined);

        // Encode through the Buffer fallback - must produce the identical cursor.
        const viaBuffer = await CPost.query().paginateCursor(
            { orderBy: "created_at", direction: "desc", perPage: 2 },
            env.DB,
        );
        expect(viaBuffer.nextCursor).toBe(viaBtoa.nextCursor);
        expect(viaBuffer.data.map((p) => p.get("id"))).toEqual(["p6", "p5"]);

        // Decode through the Buffer fallback - must land on the correct next page.
        const page2 = await CPost.query().paginateCursor(
            { orderBy: "created_at", direction: "desc", perPage: 2, after: viaBuffer.nextCursor! },
            env.DB,
        );
        expect(page2.data.map((p) => p.get("id"))).toEqual(["p4", "p3"]);
    });
});

describe("queryBuilder.ts - paginateCursor edges", () => {
    it("pages back with `before` under asc ordering (flipped effective direction)", async () => {
        const page1 = await CPost.query().paginateCursor(
            { orderBy: "created_at", direction: "asc", perPage: 2 },
            env.DB,
        );
        expect(page1.data.map((p) => p.get("id"))).toEqual(["p1", "p2"]);

        const page2 = await CPost.query().paginateCursor(
            { orderBy: "created_at", direction: "asc", perPage: 2, after: page1.nextCursor! },
            env.DB,
        );
        expect(page2.data.map((p) => p.get("id"))).toEqual(["p3", "p4"]);
        expect(page2.prevCursor).toBeTruthy();

        // Go back one page: only p1/p2 precede p3, so there is no overfetch,
        // meaning prevCursor is null at the boundary and data returns in the
        // original asc order.
        const back = await CPost.query().paginateCursor(
            { orderBy: "created_at", direction: "asc", perPage: 2, before: page2.prevCursor! },
            env.DB,
        );
        expect(back.data.map((p) => p.get("id"))).toEqual(["p1", "p2"]);
        expect(back.prevCursor).toBeNull();
        expect(back.nextCursor).toBeTruthy();
        expect(back.hasMore).toBe(false);
    });

    it("returns null cursors for an empty page reached via an `after` cursor", async () => {
        const page1 = await CPost.query().paginateCursor(
            { orderBy: "created_at", direction: "desc", perPage: 2 },
            env.DB,
        );
        // Same cursor, but a filter that matches nothing: the boundary-row
        // encoder receives undefined rows and must yield null cursors.
        const empty = await CPost.query()
            .whereEq("title", "__no_such_title__")
            .paginateCursor(
                { orderBy: "created_at", direction: "desc", perPage: 2, after: page1.nextCursor! },
                env.DB,
            );
        expect(empty.data.length).toBe(0);
        expect(empty.nextCursor).toBeNull();
        expect(empty.prevCursor).toBeNull();
        expect(empty.hasMore).toBe(false);
    });
});

describe("queryBuilder.ts - orWhereJsonContains", () => {
    it("matches rows whose JSON array column contains the value (no path)", async () => {
        const rows = await CPost.query()
            .whereEq("id", "p3")
            .orWhereJsonContains("tags", "a")
            .orderBy("id")
            .get(env.DB);
        // p1 has tag "a"; p3 matches the first predicate.
        expect(rows.map((r) => r.get("id"))).toEqual(["p1", "p3"]);
    });

    it("matches against a nested array via an explicit JSON path", async () => {
        const rows = await CPost.query()
            .whereEq("id", "__none__")
            .orWhereJsonContains("meta", "vip", "$.labels")
            .get(env.DB);
        expect(rows.map((r) => r.get("id"))).toEqual(["p1"]);
    });
});

describe("queryBuilder.ts - epochModifier on qualified columns", () => {
    it("skips the unixepoch modifier for a table-qualified column, keeps it for the bare one", () => {
        // published_at carries a `timestamp` cast, so the bare name gets the
        // unixepoch modifier while the qualified form must not (the cast map is
        // keyed on bare names and the qualifier could belong to a join).
        const qualified = CPost.query().whereDate("c100_posts.published_at", "2026-01-16").toSelectSql();
        expect(qualified.sql).toContain("date(c100_posts.published_at)");
        expect(qualified.sql).not.toContain("unixepoch");

        const bare = CPost.query().whereDate("published_at", "2026-01-16").toSelectSql();
        expect(bare.sql).toContain("date(published_at, 'unixepoch')");
    });
});

describe("queryBuilder.ts - relation constraint edges", () => {
    it("whereHas with a no-op callback behaves exactly like has()", async () => {
        const viaCb = await CPost.query().whereHas("comments", () => {}).orderBy("id").get(env.DB);
        const viaHas = await CPost.query().has("comments").orderBy("id").get(env.DB);
        expect(viaCb.map((p) => p.get("id"))).toEqual(["p1", "p2"]);
        expect(viaCb.map((p) => p.get("id"))).toEqual(viaHas.map((p) => p.get("id")));

        // And the compiled SQL is identical - the empty callback adds nothing.
        const sqlCb = CPost.query().whereHas("comments", () => {}).toSelectSql();
        const sqlHas = CPost.query().has("comments").toSelectSql();
        expect(sqlCb.sql).toBe(sqlHas.sql);
    });

    it("orWhereRelation with an explicit operator filters through the relation", async () => {
        const rows = await CPost.query()
            .whereEq("id", "p3")
            .orWhereRelation("comments", "approved", ">", 0)
            .orderBy("id")
            .get(env.DB);
        // p1 and p2 have approved comments; p3 matches the first predicate.
        expect(rows.map((r) => r.get("id"))).toEqual(["p1", "p2", "p3"]);
    });
});

describe("queryBuilder.ts - applyEagerConstraint merging", () => {
    it("carries limit and offset from the eager constraint into the batch query", async () => {
        const posts = await CPost.query()
            .whereEq("id", "p1")
            .with({ comments: (q) => q.orderBy("id", "asc").limit(2).offset(1) })
            .get(env.DB);
        const loaded = posts[0].relations.comments as CComment[];
        // p1 has c1..c3; offset 1 + limit 2 leaves c2, c3.
        expect(loaded.map((c) => c.get("id"))).toEqual(["c2", "c3"]);
    });

    it("carries a join from the eager constraint into the batch query", async () => {
        const posts = await CPost.query()
            .whereEq("id", "p1")
            .with({
                comments: (q) =>
                    q.join("c100_posts", "c100_posts.id = c100_comments.post_id")
                        .whereRaw("c100_posts.views >= 0"),
            })
            .get(env.DB);
        const loaded = posts[0].relations.comments as CComment[];
        expect(loaded.map((c) => c.get("id")).sort()).toEqual(["c1", "c2", "c3"]);
    });

    it("does not duplicate a grouping column the constraint already selects", async () => {
        // The hasMany loader selects `c100_comments.post_id as __hasmany_fk`
        // to distribute rows to parents. A constraint select that already
        // includes that exact expression must not be duplicated - and rows
        // must still land on the right parent.
        const posts = await CPost.query()
            .whereEq("id", "p1")
            .with({
                comments: (q) =>
                    q.select(["c100_comments.id", "c100_comments.post_id as __hasmany_fk"]),
            })
            .get(env.DB);
        const loaded = posts[0].relations.comments as CComment[];
        expect(loaded.map((c) => c.get("id")).sort()).toEqual(["c1", "c2", "c3"]);
        // The narrowed select really applied: body was not fetched.
        expect(loaded[0].get("body")).toBeUndefined();
    });
});

describe("queryBuilder.ts - soft-delete alias resolution", () => {
    it("falls back to the model table when a FROM source is blank", () => {
        // A whitespace-only FROM tokenizes to an empty first token; the alias
        // resolver must skip it and qualify deleted_at with the model's table.
        const q = CSoft.query().from("  ").join("c100_other x", "1 = 1").toSelectSql();
        expect(q.sql).toContain("c100_soft.deleted_at IS NULL");
    });
});

describe("queryBuilder.ts - default-argument raw clauses", () => {
    it("orWhereRaw without bindings compiles and filters", async () => {
        const rows = await CPost.query()
            .whereEq("title", "Alpha")
            .orWhereRaw("views > 100")
            .orderBy("id")
            .get(env.DB);
        // Alpha (p1) plus the only post with views > 100 (p2).
        expect(rows.map((r) => r.get("id"))).toEqual(["p1", "p2"]);
    });

    it("havingRaw and orHavingRaw without bindings compile and filter", async () => {
        const rows = await CComment.query()
            .select(["post_id", "COUNT(*) as c"])
            .groupBy("post_id")
            .havingRaw("COUNT(*) >= 2")
            .orHavingRaw("COUNT(*) > 999")
            .get(env.DB);
        expect(rows.length).toBe(1);
        expect(rows[0].get("post_id")).toBe("p1");
        expect(rows[0].get("c")).toBe(3);
    });
});

describe("queryBuilder.ts - global scopes", () => {
    it("skips a scope that contributes no where clauses while applying the rest", async () => {
        const rows = await CScoped.query().orderBy("id").get(env.DB);
        // The noop scope adds nothing; the active scope still filters s2 out.
        expect(rows.map((r) => r.get("id"))).toEqual(["s1"]);
    });
});

describe("queryBuilder.ts - aggregates over empty sets", () => {
    it("sum returns 0 and avg/min/max return null when nothing matches", async () => {
        expect(await CPost.query().whereEq("id", "__none__").sum(env.DB, "views")).toBe(0);
        expect(await CPost.query().whereEq("id", "__none__").avg(env.DB, "views")).toBeNull();
        expect(await CPost.query().whereEq("id", "__none__").min(env.DB, "views")).toBeNull();
        expect(await CPost.query().whereEq("id", "__none__").max(env.DB, "views")).toBeNull();
    });
});

describe("queryBuilder.ts - paginate default arguments", () => {
    it("defaults page to 1 and perPage to 15 in the db-only call form", async () => {
        // A plain-JS caller can invoke paginate(db) with no page at all - the
        // defaults must kick in rather than producing NaN offsets.
        const qb = CPost.query();
        const paginateDbOnly = qb.paginate.bind(qb) as unknown as (
            db: D1Database,
        ) => Promise<TPaginationResult<CPost>>;
        const r = await paginateDbOnly(env.DB);
        expect(r.page).toBe(1);
        expect(r.perPage).toBe(15);
        expect(r.total).toBe(6);
        expect(r.data.length).toBe(6);
        expect(r.lastPage).toBe(1);
    });

    it("defaults perPage to 15 in the page-first call form", async () => {
        const r = await CPost.query(env.DB).paginate(1);
        expect(r.page).toBe(1);
        expect(r.perPage).toBe(15);
        expect(r.data.length).toBe(6);
    });
});

describe("queryBuilder.ts - empty `returning` guards", () => {
    it("insertReturning rejects an empty returning array", async () => {
        await expect(
            CPost.query().insertReturning(env.DB, { id: "px", title: "X" }, []),
        ).rejects.toThrow(/insertReturning/);
        // Nothing was inserted.
        expect(await CPost.query().whereEq("id", "px").count(env.DB)).toBe(0);
    });

    it("updateReturning rejects an empty returning array", async () => {
        await expect(
            CPost.query().whereEq("id", "p1").updateReturning(env.DB, { title: "X" }, []),
        ).rejects.toThrow(/updateReturning/);
    });

    it("deleteReturning rejects an empty returning array", async () => {
        await expect(
            CPost.query().whereEq("id", "p1").deleteReturning(env.DB, []),
        ).rejects.toThrow(/deleteReturning/);
        // Nothing was deleted.
        expect(await CPost.query().whereEq("id", "p1").count(env.DB)).toBe(1);
    });

    it("toUpdateJsonRemovePrepared throws on an empty path array", () => {
        expect(() => CPost.query().toUpdateJsonRemovePrepared(env.DB, "meta", [])).toThrow(
            /at least one JSON path/,
        );
    });
});

describe("queryBuilder.ts - prepared step statements", () => {
    it("toIncrementPrepared defaults the amount to 1", async () => {
        await CPost.query().whereEq("id", "p1").toIncrementPrepared(env.DB, "views").run();
        const row = await env.DB.prepare("SELECT views FROM c100_posts WHERE id = 'p1'").first<{ views: number }>();
        expect(row!.views).toBe(11);
    });

    it("toDecrementPrepared defaults the amount to 1", async () => {
        await CPost.query().whereEq("id", "p1").toDecrementPrepared(env.DB, "views").run();
        const row = await env.DB.prepare("SELECT views FROM c100_posts WHERE id = 'p1'").first<{ views: number }>();
        expect(row!.views).toBe(9);
    });
});

describe("queryBuilder.ts - JSON updates via the default-db call forms", () => {
    it("updateJsonSet without a db argument resolves the builder's default db", async () => {
        const changed = await CPost.query(env.DB).whereEq("id", "p1").updateJsonSet("meta", "$.role", "admin");
        expect(changed).toBe(1);
        const row = await env.DB
            .prepare("SELECT json_extract(meta, '$.role') AS role FROM c100_posts WHERE id = 'p1'")
            .first<{ role: string }>();
        expect(row!.role).toBe("admin");
    });

    it("updateJsonPatch without a db argument merges the patch", async () => {
        const changed = await CPost.query(env.DB).whereEq("id", "p1").updateJsonPatch("meta", { theme: "dark" });
        expect(changed).toBe(1);
        const row = await env.DB
            .prepare("SELECT json_extract(meta, '$.theme') AS theme, json_extract(meta, '$.role') AS role FROM c100_posts WHERE id = 'p1'")
            .first<{ theme: string; role: string }>();
        expect(row!.theme).toBe("dark");
        expect(row!.role).toBe("user"); // merge, not replace
    });

    it("updateJsonRemove without a db argument removes the path", async () => {
        const changed = await CPost.query(env.DB).whereEq("id", "p1").updateJsonRemove("meta", "$.role");
        expect(changed).toBe(1);
        const row = await env.DB
            .prepare("SELECT json_extract(meta, '$.role') AS role FROM c100_posts WHERE id = 'p1'")
            .first<{ role: string | null }>();
        expect(row!.role).toBeNull();
    });
});

describe("queryBuilder.ts - prepared JSON updates without a WHERE clause", () => {
    it("toUpdateJsonSetPrepared with no filters updates every row", async () => {
        await CPost.query().toUpdateJsonSetPrepared(env.DB, "meta", "$.flag", 1).run();
        const row = await env.DB
            .prepare("SELECT COUNT(*) AS n FROM c100_posts WHERE json_extract(meta, '$.flag') = 1")
            .first<{ n: number }>();
        expect(row!.n).toBe(6);
    });

    it("toUpdateJsonPatchPrepared with no filters patches every row", async () => {
        await CPost.query().toUpdateJsonPatchPrepared(env.DB, "meta", { pv: 2 }).run();
        const row = await env.DB
            .prepare("SELECT COUNT(*) AS n FROM c100_posts WHERE json_extract(meta, '$.pv') = 2")
            .first<{ n: number }>();
        expect(row!.n).toBe(6);
    });

    it("toUpdateJsonRemovePrepared with no filters strips the path from every row", async () => {
        await CPost.query().toUpdateJsonSetPrepared(env.DB, "meta", "$.flag", 1).run();
        await CPost.query().toUpdateJsonRemovePrepared(env.DB, "meta", "$.flag").run();
        const row = await env.DB
            .prepare("SELECT COUNT(*) AS n FROM c100_posts WHERE json_extract(meta, '$.flag') IS NOT NULL")
            .first<{ n: number }>();
        expect(row!.n).toBe(0);
    });
});

describe("queryBuilder.ts - returning without filters", () => {
    it("updateReturning in the values-first form with no WHERE updates and returns all rows", async () => {
        const rows = await CPost.query(env.DB).updateReturning({ score: 99 });
        expect(rows.length).toBe(6);
        expect(rows.every((r) => r.score === 99)).toBe(true);
    });

    it("deleteReturning with no arguments deletes and returns all rows via the default db", async () => {
        const rows = await CPost.query(env.DB).deleteReturning();
        expect(rows.length).toBe(6);
        expect(await CPost.query().count(env.DB)).toBe(0);
    });
});

describe("queryBuilder.ts - foreign-kind clause objects are ignored by the compilers", () => {
    // The TWhereClause/THavingClause kind chains end with an else-if (not a
    // bare else), so a clause object whose kind matches no known arm falls
    // through silently. That false path is unreachable through the public API
    // (the unions are closed), so these tests inject a foreign-kind clause
    // into the builder's internal arrays and assert it contributes nothing.

    it("compileWhere skips a clause whose kind matches no known arm", async () => {
        const qb = CPost.query().whereEq("title", "Alpha");
        (qb as unknown as { wheres: Array<Record<string, unknown>> }).wheres.push({
            kind: "bogus",
            join: "AND",
        });

        const { sql, bindings } = qb.toSelectSql();
        // The real clause survives; the foreign one emits no SQL and no binding.
        expect(sql).toContain("WHERE title = ?");
        expect(sql).not.toContain("bogus");
        expect(bindings).toEqual(["Alpha"]);

        // The compiled query stays valid and filters as if the foreign clause
        // were absent.
        const rows = await qb.get(env.DB);
        expect(rows.map((r) => r.get("id"))).toEqual(["p1"]);
    });

    it("compileHaving skips a clause whose kind matches no known arm", async () => {
        const qb = CComment.query()
            .select(["post_id", "COUNT(*) as c"])
            .groupBy("post_id")
            .havingRaw("COUNT(*) >= 2");
        (qb as unknown as { havings: Array<Record<string, unknown>> }).havings.push({
            kind: "bogus",
            join: "AND",
        });

        const { sql } = qb.toSelectSql();
        expect(sql).toContain("HAVING (COUNT(*) >= 2)");
        expect(sql).not.toContain("bogus");

        const rows = await qb.get(env.DB);
        expect(rows.length).toBe(1);
        expect(rows[0].get("post_id")).toBe("p1");
        expect(rows[0].get("c")).toBe(3);
    });
});

describe("queryBuilder.ts - alias resolver defensive fallback", () => {
    it("falls back to the first token when a multi-token source has a nullish last token", () => {
        // aliasOfModelTable() guards `tokens[tokens.length - 1] ?? first`. A
        // real string can never split into a multi-token array whose last
        // element is undefined, so the fallback is reached only by feeding the
        // resolver a crafted table source whose trim().split() yields exactly
        // that shape. The observable contract: the resolver must fall back to
        // the first token (the model table) and qualify the soft-delete scope
        // with it.
        const qb = CSoft.query().join("c100_scoped", "c100_scoped.id = c100_soft.id");
        const crafted = {
            toString: () => "c100_soft",
            trim: () => ({ split: () => ["c100_soft", undefined] }),
        };
        (qb as unknown as { table: unknown }).table = crafted;

        const { sql } = qb.toSelectSql();
        // FROM renders via toString; the alias resolver consumed the crafted
        // token array, hit the ?? fallback, and qualified deleted_at with the
        // first token rather than emitting "undefined.deleted_at".
        expect(sql).toContain("FROM c100_soft");
        expect(sql).toContain("c100_soft.deleted_at IS NULL");
        expect(sql).not.toContain("undefined");
    });
});

describe("queryBuilder.ts - driver responses missing meta/results", () => {
    it("get/getWithMeta/firstWithMeta tolerate a response without meta or results", async () => {
        const stub = makeStubDb();

        const qb = CPost.query();
        const rows = await qb.get(stub);
        expect(rows.length).toBe(0);
        // recordMeta must not fabricate meta when the driver omits it.
        expect(qb.lastMeta()).toBeNull();

        const withMeta = await CPost.query().getWithMeta(stub);
        expect(withMeta.data.length).toBe(0);
        expect(withMeta.meta).toEqual({});
        expect(withMeta.bookmark).toBeNull();

        const firstMeta = await CPost.query().firstWithMeta(stub);
        expect(firstMeta.data).toBeNull();
        expect(firstMeta.meta).toEqual({});
    });

    it("pluck/update/delete/updateReturning/deleteReturning fall back to empty defaults", async () => {
        const stub = makeStubDb();
        expect(await CPost.query().pluck(stub, "title")).toEqual([]);
        expect(await CPost.query().whereEq("id", "p1").update(stub, { title: "x" })).toBe(0);
        expect(await CPost.query().whereEq("id", "p1").delete(stub)).toBe(0);
        expect(await CPost.query().whereEq("id", "p1").updateReturning(stub, { title: "x" })).toEqual([]);
        expect(await CPost.query().whereEq("id", "p1").deleteReturning(stub)).toEqual([]);
    });

    it("increment and the JSON update helpers report 0 changes without meta", async () => {
        const stub = makeStubDb();
        expect(await CPost.query().whereEq("id", "p1").increment(stub, "views")).toBe(0);
        expect(await CPost.query().whereEq("id", "p1").updateJsonSet(stub, "meta", "$.x", 1)).toBe(0);
        expect(await CPost.query().whereEq("id", "p1").updateJsonPatch(stub, "meta", { x: 1 })).toBe(0);
        expect(await CPost.query().whereEq("id", "p1").updateJsonRemove(stub, "meta", "$.x")).toBe(0);
    });

    it("PreparedQuery.all and .first tolerate missing results", async () => {
        const stub = makeStubDb();
        const prepared = CPost.query().whereEq("id", placeholder("pid")).prepare(stub);
        expect(await prepared.all({ pid: "p1" })).toEqual([]);
        expect(await prepared.first({ pid: "p1" })).toBeNull();
    });
});
