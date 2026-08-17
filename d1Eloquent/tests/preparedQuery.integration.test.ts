// preparedQuery.integration.test.ts
// Live D1 tests for prepare() + placeholder() reusable prepared queries.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BaseModel } from "../baseModel";
import { placeholder, PreparedQuery } from "../queryBuilder";
import type { TRelationDefinition } from "../relationTypes";

interface UserAttrs { id?: string; email?: string; tier?: string; active?: number }
interface PqPostAttrs { id?: string; user_id?: string; title?: string }
interface PqDocAttrs { id?: string; title?: string; deleted_at?: string | Date | null }

class PqPost extends BaseModel<PqPostAttrs> {
    static table = "pq_posts";
    static timestamps = false;
}

// Soft-delete model — the compiled prepared SQL must carry the `deleted_at IS NULL`
// scope injected by toSelectSql() (regression #53).
class PqDoc extends BaseModel<PqDocAttrs> {
    static table = "pq_docs";
    static timestamps = false;
    static softDeletes = true;
}

class PqUser extends BaseModel<UserAttrs> {
    static table = "pq_users";
    static timestamps = false;
    static casts = { active: "boolean" } as const;
    static relations: Record<string, TRelationDefinition> = {
        posts: { type: "hasMany", model: () => PqPost, foreignKey: "user_id" },
    };
}

beforeAll(async () => {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS pq_users (id TEXT PRIMARY KEY, email TEXT, tier TEXT, active INTEGER)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS pq_posts (id TEXT PRIMARY KEY, user_id TEXT, title TEXT)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS pq_docs (id TEXT PRIMARY KEY, title TEXT, deleted_at TEXT)`).run();
});

beforeEach(async () => {
    await env.DB.prepare("DELETE FROM pq_users").run();
    await env.DB.prepare("DELETE FROM pq_posts").run();
    await env.DB.prepare("DELETE FROM pq_docs").run();
    await PqUser.create(env.DB, { id: "u1", email: "a@x.com", tier: "pro", active: true });
    await PqUser.create(env.DB, { id: "u2", email: "b@x.com", tier: "free", active: true });
    await PqUser.create(env.DB, { id: "u3", email: "c@x.com", tier: "pro", active: false });
    await PqPost.create(env.DB, { id: "p1", user_id: "u1", title: "T1" });
    await PqPost.create(env.DB, { id: "p2", user_id: "u1", title: "T2" });
    await PqPost.create(env.DB, { id: "p3", user_id: "u3", title: "T3" });
});

describe("prepare() + placeholder()", () => {
    it("compiles once and reuses with different params", async () => {
        const byEmail = PqUser.query().whereEq("email", placeholder("email")).prepare(env.DB);
        expect((await byEmail.first({ email: "a@x.com" }))!.get("id")).toBe("u1");
        expect((await byEmail.first({ email: "b@x.com" }))!.get("id")).toBe("u2");
        expect(await byEmail.first({ email: "missing@x.com" })).toBeNull();
    });

    it("mixes static values with placeholders", async () => {
        const proByEmail = PqUser.query()
            .whereEq("tier", "pro") // static
            .where("email", "=", placeholder("email")) // placeholder
            .prepare(env.DB);
        expect((await proByEmail.first({ email: "a@x.com" }))!.get("id")).toBe("u1"); // pro + a
        expect(await proByEmail.first({ email: "b@x.com" })).toBeNull(); // b is free, not pro
    });

    it("get() returns hydrated models; placeholder params bind RAW (no cast)", async () => {
        // Placeholders bind raw DB values — the boolean cast is NOT applied to the
        // param, so pass 1 (not true). The RESULT is still hydrated on read.
        const active = PqUser.query().whereEq("active", placeholder("flag")).orderBy("id").prepare(env.DB);
        const rows = await active.get({ flag: 1 });
        expect(rows.map((r) => r.get("id"))).toEqual(["u1", "u2"]);
        expect(rows[0].get("active")).toBe(true); // result hydrated to boolean
    });

    it("all() returns raw rows", async () => {
        const byTier = PqUser.query().whereEq("tier", placeholder("t")).prepare(env.DB);
        const rows = await byTier.all({ t: "pro" });
        expect(rows.length).toBe(2);
        expect(rows[0]).toHaveProperty("email");
    });

    it("throws when a placeholder value is missing", async () => {
        const q = PqUser.query().whereEq("email", placeholder("email")).prepare(env.DB);
        await expect(q.first({})).rejects.toThrow(/placeholder 'email'/i);
    });
});

describe("prepare() — db override + defaults (branch coverage)", () => {
    it("accepts an explicit db override on all()/get()/first()", async () => {
        const proByTier = PqUser.query().whereEq("tier", placeholder("t")).orderBy("id").prepare(env.DB);
        // second arg = explicit db → exercises the `db ?? this.db` left operand.
        expect((await proByTier.all({ t: "pro" }, env.DB)).length).toBe(2);
        expect((await proByTier.get({ t: "pro" }, env.DB)).map((r) => r.get("id"))).toEqual(["u1", "u3"]);
        expect((await proByTier.first({ t: "pro" }, env.DB))!.get("id")).toBe("u1");
    });

    it("defaults params to {} when called with no args", async () => {
        const allUsers = PqUser.query().orderBy("id").prepare(env.DB); // no placeholders
        expect((await allUsers.all()).length).toBe(3); // params = {} default
        expect((await allUsers.get()).map((r) => r.get("id"))).toEqual(["u1", "u2", "u3"]);
        expect((await allUsers.first())!.get("id")).toBe("u1");
    });

    it("hydrates a model ctor without asProxy via the plain-model branch", async () => {
        // A plain (non-BaseModel) ctor has no asProxy() → exercises the `: model` else branch.
        class PlainRow {
            static table = "pq_users";
            static primaryKey = "id";
            attrs: Record<string, unknown>;
            constructor(attrs: Record<string, unknown> = {}) { this.attrs = attrs; }
            toObject() { return this.attrs; }
        }
        const pq = new PreparedQuery(PlainRow as never, "SELECT * FROM pq_users ORDER BY id", [], env.DB);
        const rows = await pq.get();
        expect(rows.length).toBe(3);
        expect(rows[0] instanceof PlainRow).toBe(true); // returned as-is, not proxy-wrapped
    });
});

describe("prepare() — eager loading + first() (regression #53)", () => {
    it("loads eager .with() relations through the prepared path", async () => {
        const q = PqUser.query().with(["posts"]).whereEq("tier", placeholder("t")).orderBy("id").prepare(env.DB);
        const pros = await q.get({ t: "pro" });
        const u1 = pros.find((u) => u.get("id") === "u1")!;
        const u3 = pros.find((u) => u.get("id") === "u3")!;
        expect((u1.relations.posts as PqPost[]).map((p) => p.get("id")).sort()).toEqual(["p1", "p2"]);
        expect((u3.relations.posts as PqPost[]).map((p) => p.get("id"))).toEqual(["p3"]);
    });

    it("loads eager relations on first() too", async () => {
        const q = PqUser.query().with(["posts"]).whereEq("id", placeholder("id")).prepare(env.DB);
        const u1 = await q.first({ id: "u1" });
        expect(u1).not.toBeNull();
        expect((u1!.relations.posts as PqPost[]).map((p) => p.get("id")).sort()).toEqual(["p1", "p2"]);
    });

    it("first() returns exactly one model for a multi-match query", async () => {
        const q = PqUser.query().whereEq("tier", placeholder("t")).orderBy("id").prepare(env.DB);
        const one = await q.first({ t: "pro" }); // matches u1 + u3
        expect(one!.get("id")).toBe("u1");
    });

    it("throws at prepare() for an unknown eager relation (guard not bypassed)", () => {
        expect(() => PqUser.query().with(["nope"]).prepare(env.DB)).toThrow(/Unknown eager relation/);
    });
});

describe("prepare() — soft-delete scoping (regression #53)", () => {
    it("get() through the prepared path excludes soft-deleted rows", async () => {
        await PqDoc.create(env.DB, { id: "d1", title: "live" });
        const trashed = await PqDoc.create(env.DB, { id: "d2", title: "gone" });
        await trashed.delete(env.DB); // soft delete → sets deleted_at, row stays in the table

        // Sanity: the trashed row physically exists (exclusion is the scope, not a missing insert).
        const raw = await env.DB.prepare("SELECT deleted_at FROM pq_docs WHERE id = ?").bind("d2").first();
        expect(raw!.deleted_at).not.toBeNull();

        // The prepared SQL is compiled from toSelectSql(), which injects `deleted_at IS NULL`.
        const q = PqDoc.query().orderBy("id").prepare(env.DB);
        const rows = await q.get();
        expect(rows.map((r) => r.get("id"))).toEqual(["d1"]); // d2 (trashed) scoped out
    });

    it("first() through the prepared path skips the trashed row", async () => {
        const trashed = await PqDoc.create(env.DB, { id: "d1", title: "gone" });
        await trashed.delete(env.DB);
        await PqDoc.create(env.DB, { id: "d2", title: "live" });

        // d1 sorts first but is trashed → the prepared LIMIT-1 first() must return d2.
        const q = PqDoc.query().orderBy("id").prepare(env.DB);
        const first = await q.first();
        expect(first).not.toBeNull();
        expect(first!.get("id")).toBe("d2");
    });

    it("all() (raw rows) through the prepared path also carries the soft-delete scope", async () => {
        await PqDoc.create(env.DB, { id: "d1", title: "live" });
        const trashed = await PqDoc.create(env.DB, { id: "d2", title: "gone" });
        await trashed.delete(env.DB);

        const rows = await PqDoc.query().orderBy("id").prepare(env.DB).all();
        expect(rows.length).toBe(1);
        expect(rows[0].id).toBe("d1");
    });

    it("preserves the soft-delete scope alongside placeholder params", async () => {
        await PqDoc.create(env.DB, { id: "d1", title: "keep" });
        const trashed = await PqDoc.create(env.DB, { id: "d2", title: "keep" });
        await trashed.delete(env.DB); // same title, but trashed

        const byTitle = PqDoc.query().whereEq("title", placeholder("t")).orderBy("id").prepare(env.DB);
        // Both rows share title="keep"; the scope + placeholder together leave only the live row.
        expect((await byTitle.get({ t: "keep" })).map((r) => r.get("id"))).toEqual(["d1"]);
        expect((await byTitle.first({ t: "keep" }))!.get("id")).toBe("d1");
    });
});
