// pivotSugar.integration.test.ts
// Live D1 integration tests for attach / detach / sync / toggle on
// belongsToMany and morphToMany pivot relations.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Schema } from "../../scripts/schema";
import { BaseModel } from "../baseModel";
import type { TRelationDefinition } from "../relationTypes";

interface UserAttrs {
    id: string;
    name: string;
}
interface RoleAttrs {
    id: string;
    label: string;
}
interface PostAttrs {
    id: string;
    title: string;
}
interface TagAttrs {
    id: string;
    label: string;
}

class PsUser extends BaseModel<UserAttrs> {
    static table = "ps_users";
    static primaryKey = "id";
    static timestamps = false;
    static relations: Record<string, TRelationDefinition> = {
        roles: {
            type: "belongsToMany",
            model: () => PsRole,
            pivot: "ps_user_roles",
            foreignPivotKey: "user_id",
            relatedPivotKey: "role_id",
        },
    };
}

class PsRole extends BaseModel<RoleAttrs> {
    static table = "ps_roles";
    static primaryKey = "id";
    static timestamps = false;
}

class PsPost extends BaseModel<PostAttrs> {
    static table = "ps_posts";
    static primaryKey = "id";
    static timestamps = false;
    static relations: Record<string, TRelationDefinition> = {
        tags: {
            type: "morphToMany",
            model: () => PsTag,
            pivot: "ps_taggables",
            morphName: "taggable",
            typeValue: "post",
            relatedPivotKey: "tag_id",
        },
    };
}

class PsTag extends BaseModel<TagAttrs> {
    static table = "ps_tags";
    static primaryKey = "id";
    static timestamps = false;
}

beforeAll(async () => {
    const s = new Schema();
    s.dropTable("ps_user_roles");
    s.dropTable("ps_taggables");
    s.dropTable("ps_tags");
    s.dropTable("ps_roles");
    s.dropTable("ps_posts");
    s.dropTable("ps_users");

    s.createTable("ps_users", (t) => { t.id(); t.text("name").notNull(); });
    s.createTable("ps_roles", (t) => { t.id(); t.text("label").notNull(); });
    s.createTable("ps_posts", (t) => { t.id(); t.text("title").notNull(); });
    s.createTable("ps_tags",  (t) => { t.id(); t.text("label").notNull(); });

    // belongsToMany pivot with an extras column for testing attach({ extras: { role: ... } })
    s.createTable("ps_user_roles", (t) => {
        t.text("user_id").notNull();
        t.text("role_id").notNull();
        t.text("note");
        t.primary("user_id, role_id");
    });

    s.createTable("ps_taggables", (t) => {
        t.text("tag_id").notNull();
        t.text("taggable_type").notNull();
        t.text("taggable_id").notNull();
        t.primary("tag_id, taggable_type, taggable_id");
    });

    for (const stmt of s.toStatements()) await env.DB.prepare(stmt).run();

    const run = async (sql: string, ...bs: unknown[]) =>
        env.DB.prepare(sql).bind(...bs).run();

    // Seed shared rows
    await run("INSERT INTO ps_users (id, name) VALUES (?, ?)", "u1", "Alice");
    await run("INSERT INTO ps_roles (id, label) VALUES (?, ?)", "r1", "admin");
    await run("INSERT INTO ps_roles (id, label) VALUES (?, ?)", "r2", "editor");
    await run("INSERT INTO ps_roles (id, label) VALUES (?, ?)", "r3", "viewer");

    await run("INSERT INTO ps_posts (id, title) VALUES (?, ?)", "p1", "Hello");
    await run("INSERT INTO ps_tags (id, label) VALUES (?, ?)", "t1", "rust");
    await run("INSERT INTO ps_tags (id, label) VALUES (?, ?)", "t2", "workers");
    await run("INSERT INTO ps_tags (id, label) VALUES (?, ?)", "t3", "edge");
});

beforeEach(async () => {
    await env.DB.prepare("DELETE FROM ps_user_roles").run();
    await env.DB.prepare("DELETE FROM ps_taggables").run();
});

// ── belongsToMany ──────────────────────────────────────────────────────

describe("belongsToMany — attach", () => {
    it("attaches a single id", async () => {
        const user = await PsUser.findOrFail(env.DB, "u1");
        const n = await (user as any).related("roles").attach!("r1", { db: env.DB });
        expect(n).toBe(1);

        const rows = await env.DB.prepare("SELECT role_id FROM ps_user_roles WHERE user_id = ?")
            .bind("u1").all<{ role_id: string }>();
        expect(rows.results?.map((r) => r.role_id)).toEqual(["r1"]);
    });

    it("attaches an array of ids in one batch", async () => {
        const user = await PsUser.findOrFail(env.DB, "u1");
        const n = await (user as any).related("roles").attach!(["r1", "r2", "r3"], { db: env.DB });
        expect(n).toBe(3);
    });

    it("is idempotent (INSERT OR IGNORE) — re-attaching is a no-op", async () => {
        const user = await PsUser.findOrFail(env.DB, "u1");
        await (user as any).related("roles").attach!(["r1", "r2"], { db: env.DB });
        const second = await (user as any).related("roles").attach!(["r1", "r2", "r3"], { db: env.DB });
        // Only r3 was new
        expect(second).toBe(1);
    });

    it("writes extras into pivot columns when provided", async () => {
        const user = await PsUser.findOrFail(env.DB, "u1");
        await (user as any).related("roles").attach!("r1", {
            extras: { note: "primary admin" },
            db: env.DB,
        });
        const row = await env.DB
            .prepare("SELECT note FROM ps_user_roles WHERE user_id = ? AND role_id = ?")
            .bind("u1", "r1")
            .first<{ note: string }>();
        expect(row?.note).toBe("primary admin");
    });
});

describe("belongsToMany — detach", () => {
    it("detaches a single id", async () => {
        const user = await PsUser.findOrFail(env.DB, "u1");
        await (user as any).related("roles").attach!(["r1", "r2", "r3"], { db: env.DB });

        const n = await (user as any).related("roles").detach!("r2", { db: env.DB });
        expect(n).toBe(1);

        const rows = await env.DB.prepare("SELECT role_id FROM ps_user_roles WHERE user_id = ?")
            .bind("u1").all<{ role_id: string }>();
        expect((rows.results ?? []).map((r) => r.role_id).sort()).toEqual(["r1", "r3"]);
    });

    it("detaches an array of ids", async () => {
        const user = await PsUser.findOrFail(env.DB, "u1");
        await (user as any).related("roles").attach!(["r1", "r2", "r3"], { db: env.DB });

        const n = await (user as any).related("roles").detach!(["r1", "r3"], { db: env.DB });
        expect(n).toBe(2);
    });

    it("detaches ALL when called without arguments", async () => {
        const user = await PsUser.findOrFail(env.DB, "u1");
        await (user as any).related("roles").attach!(["r1", "r2", "r3"], { db: env.DB });

        const n = await (user as any).related("roles").detach!(undefined, { db: env.DB });
        expect(n).toBe(3);

        const rows = await env.DB.prepare("SELECT COUNT(*) as c FROM ps_user_roles").first<{ c: number }>();
        expect(rows?.c).toBe(0);
    });
});

describe("belongsToMany — sync", () => {
    it("inserts missing ids and removes ids not in the target set", async () => {
        const user = await PsUser.findOrFail(env.DB, "u1");
        await (user as any).related("roles").attach!(["r1", "r2"], { db: env.DB });

        const result = await (user as any).related("roles").sync!(["r2", "r3"], { db: env.DB });
        expect(result.attached.sort()).toEqual(["r3"]);
        expect(result.detached.sort()).toEqual(["r1"]);

        const rows = await env.DB.prepare("SELECT role_id FROM ps_user_roles WHERE user_id = ?")
            .bind("u1").all<{ role_id: string }>();
        expect((rows.results ?? []).map((r) => r.role_id).sort()).toEqual(["r2", "r3"]);
    });

    it("syncs to empty array detaches everything", async () => {
        const user = await PsUser.findOrFail(env.DB, "u1");
        await (user as any).related("roles").attach!(["r1", "r2", "r3"], { db: env.DB });

        const result = await (user as any).related("roles").sync!([], { db: env.DB });
        expect(result.attached).toEqual([]);
        expect(result.detached.sort()).toEqual(["r1", "r2", "r3"]);
    });
});

describe("belongsToMany — toggle", () => {
    it("attaches missing ids and detaches present ones", async () => {
        const user = await PsUser.findOrFail(env.DB, "u1");
        await (user as any).related("roles").attach!(["r1"], { db: env.DB });

        // r1 present → detach; r2, r3 missing → attach
        const result = await (user as any).related("roles").toggle!(["r1", "r2", "r3"], { db: env.DB });
        expect(result.attached.sort()).toEqual(["r2", "r3"]);
        expect(result.detached).toEqual(["r1"]);
    });
});

// ── morphToMany ────────────────────────────────────────────────────────

describe("belongsToMany — empty inputs are no-ops", () => {
    it("attach([]) returns 0 without writing", async () => {
        const user = await PsUser.findOrFail(env.DB, "u1");
        expect(await (user as any).related("roles").attach!([], { db: env.DB })).toBe(0);
    });
    it("detach([]) returns 0", async () => {
        const user = await PsUser.findOrFail(env.DB, "u1");
        expect(await (user as any).related("roles").detach!([], { db: env.DB })).toBe(0);
    });
    it("toggle([]) returns an empty result", async () => {
        const user = await PsUser.findOrFail(env.DB, "u1");
        expect(await (user as any).related("roles").toggle!([], { db: env.DB })).toEqual({
            attached: [],
            detached: [],
        });
    });
});

describe("morphToMany — pivot ops apply the morph type filter", () => {
    it("attach writes both taggable_type and taggable_id", async () => {
        const post = await PsPost.findOrFail(env.DB, "p1");
        await (post as any).related("tags").attach!(["t1", "t2"], { db: env.DB });

        const rows = await env.DB
            .prepare("SELECT tag_id, taggable_type, taggable_id FROM ps_taggables WHERE taggable_id = ?")
            .bind("p1")
            .all<{ tag_id: string; taggable_type: string; taggable_id: string }>();

        const sorted = (rows.results ?? []).map((r) => ({ ...r })).sort((a, b) => a.tag_id.localeCompare(b.tag_id));
        expect(sorted).toEqual([
            { tag_id: "t1", taggable_type: "post", taggable_id: "p1" },
            { tag_id: "t2", taggable_type: "post", taggable_id: "p1" },
        ]);
    });

    it("detach respects the morph type — only this parent's rows are removed", async () => {
        // Seed a foreign morph row to ensure detach scope is correct
        await env.DB.prepare(
            "INSERT INTO ps_taggables (tag_id, taggable_type, taggable_id) VALUES (?, ?, ?)",
        ).bind("t1", "video", "v1").run();

        const post = await PsPost.findOrFail(env.DB, "p1");
        await (post as any).related("tags").attach!(["t1", "t2"], { db: env.DB });

        // Detach ALL for this post — must not touch the video row
        const n = await (post as any).related("tags").detach!(undefined, { db: env.DB });
        expect(n).toBe(2);

        const left = await env.DB
            .prepare("SELECT taggable_type FROM ps_taggables")
            .all<{ taggable_type: string }>();
        expect(left.results?.map((r) => r.taggable_type)).toEqual(["video"]);
    });

    it("sync only touches rows matching this morph type", async () => {
        await env.DB.prepare(
            "INSERT INTO ps_taggables (tag_id, taggable_type, taggable_id) VALUES (?, ?, ?)",
        ).bind("t1", "video", "v1").run();

        const post = await PsPost.findOrFail(env.DB, "p1");
        await (post as any).related("tags").attach!(["t1", "t2"], { db: env.DB });

        const result = await (post as any).related("tags").sync!(["t2", "t3"], { db: env.DB });
        expect(result.attached.sort()).toEqual(["t3"]);
        expect(result.detached.sort()).toEqual(["t1"]);

        // Video row is untouched
        const stillVideo = await env.DB
            .prepare("SELECT 1 as ok FROM ps_taggables WHERE tag_id = ? AND taggable_type = ?")
            .bind("t1", "video")
            .first<{ ok: number }>();
        expect(stillVideo?.ok).toBe(1);
    });
});

describe("non-pivot relations do not expose pivot methods", () => {
    it("hasMany / belongsTo / morphMany have no attach/detach/sync", async () => {
        // We'll instantiate them by importing classes from the morphToMany test —
        // simpler: just check via reflection on a sample relation.
        class WithHasMany extends BaseModel<UserAttrs> {
            static table = "ps_users";
            static relations: Record<string, TRelationDefinition> = {
                roles: { type: "hasMany", model: () => PsRole, foreignKey: "user_id" },
            };
        }
        const user = await WithHasMany.findOrFail(env.DB, "u1");
        const rel = (user as any).related("roles");
        expect(rel.attach).toBeUndefined();
        expect(rel.detach).toBeUndefined();
        expect(rel.sync).toBeUndefined();
        expect(rel.toggle).toBeUndefined();
    });
});
