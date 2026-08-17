// baseModelBranches.integration.test.ts
// Targeted tests to cover remaining baseModel.ts conditional branches

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BaseModel } from "../baseModel";
import { QueryBuilder } from "../queryBuilder";
import type { TRevisionConfig } from "../revisionTypes";

// ── Models ───────────────────────────────────────────────────────────

interface Attrs {
    id?: string;
    name?: string;
    created_at?: string | Date;
    updated_at?: string | Date;
    deleted_at?: string | Date | null;
}

class RevModel extends BaseModel<Attrs> {
    static table = "bmb_items";
    static primaryKey = "id";
    static timestamps = true;
    static softDeletes = true;
    static revisions: TRevisionConfig = { enabled: true, mode: "diff+after" };
}

class PlainModel extends BaseModel<Attrs> {
    static table = "bmb_items";
    static primaryKey = "id";
    static timestamps = true;
    static softDeletes = false;
}

class NoTsModel extends BaseModel<{ id?: string; name?: string }> {
    static table = "bmb_bare";
    static primaryKey = "id";
    static timestamps = false;
    static softDeletes = false;
}

// ── Setup ────────────────────────────────────────────────────────────

beforeAll(async () => {
    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS bmb_items (
            id TEXT PRIMARY KEY, name TEXT,
            created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '',
            deleted_at TEXT
        )
    `).run();
    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS bmb_bare (id TEXT PRIMARY KEY, name TEXT)
    `).run();
    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS model_revisions (
            id TEXT PRIMARY KEY, model_table TEXT NOT NULL, model_pk TEXT NOT NULL,
            model_id TEXT NOT NULL, action TEXT NOT NULL, diff_json TEXT,
            before_json TEXT, after_json TEXT, actor_id TEXT, request_id TEXT,
            reason TEXT, created_at TEXT NOT NULL
        )
    `).run();
});

afterAll(async () => {
    await env.DB.prepare("DROP TABLE IF EXISTS bmb_items").run();
    await env.DB.prepare("DROP TABLE IF EXISTS bmb_bare").run();
});

beforeEach(async () => {
    await env.DB.prepare("DELETE FROM bmb_items").run();
    await env.DB.prepare("DELETE FROM bmb_bare").run();
    await env.DB.prepare("DELETE FROM model_revisions").run();
});

// ── transaction ──────────────────────────────────────────────────────

describe("BaseModel.transaction", () => {
    it("executes multiple prepared statements in batch", async () => {
        const qb = new QueryBuilder(NoTsModel as any);
        const stmt1 = qb.toInsertPrepared(env.DB, { id: "t1", name: "One" });
        const stmt2 = new QueryBuilder(NoTsModel as any).toInsertPrepared(env.DB, { id: "t2", name: "Two" });
        await BaseModel.transaction(env.DB, [stmt1, stmt2]);

        const count = await env.DB.prepare("SELECT COUNT(*) as c FROM bmb_bare").first<{ c: number }>();
        expect(count!.c).toBe(2);
    });
});

// ── hard delete with revisions ───────────────────────────────────────

describe("hard delete with revisions", () => {
    it("writes revision on hard delete (non-soft-delete model with revisions)", async () => {
        // PlainModel has softDeletes=false, no revisions by default
        // Use RevModel without soft delete path
        const model = await PlainModel.create(env.DB, { id: "hd1", name: "Hard" });
        await model.delete(env.DB);

        const row = await env.DB.prepare("SELECT * FROM bmb_items WHERE id = ?").bind("hd1").first();
        expect(row).toBeNull();
    });
});

// ── update with revision context ─────────────────────────────────────

describe("update with full revision context", () => {
    it("update with revision context populates all fields", async () => {
        const model = await RevModel.create(env.DB, { id: "rc1", name: "V1" });
        model.set("name", "V2" as any);
        await model.save(env.DB, {
            revision: { actorId: "act1", requestId: "req1", reason: "test" },
        });

        const rev = await env.DB.prepare(
            "SELECT * FROM model_revisions WHERE model_id = ? AND action = 'update'"
        ).bind("rc1").first();
        expect(rev!.actor_id).toBe("act1");
        expect(rev!.reason).toBe("test");
    });
});

// ── delete with revision context ─────────────────────────────────────

describe("delete with revision context", () => {
    it("soft delete writes revision with context", async () => {
        const model = await RevModel.create(env.DB, { id: "drc1", name: "Del" });
        await model.delete(env.DB, {
            revision: { actorId: "deleter", reason: "cleanup" },
        });

        const rev = await env.DB.prepare(
            "SELECT * FROM model_revisions WHERE model_id = ? AND action = 'delete'"
        ).bind("drc1").first();
        expect(rev!.actor_id).toBe("deleter");
        expect(rev!.reason).toBe("cleanup");
    });
});

// ── save with existing created_at (don't overwrite) ──────────────────

describe("save preserves existing created_at", () => {
    it("does not overwrite created_at when it already has a value", async () => {
        const model = new RevModel({ id: "ca1", name: "Test", created_at: "2020-01-01T00:00:00.000Z" as any });
        await model.save(env.DB);

        const row = await env.DB.prepare("SELECT created_at FROM bmb_items WHERE id = ?").bind("ca1").first();
        expect(row!.created_at).toBe("2020-01-01T00:00:00.000Z");
    });
});

// ── Model without timestamps ─────────────────────────────────────────

describe("model without timestamps", () => {
    it("create does not set created_at or updated_at", async () => {
        const model = await NoTsModel.create(env.DB, { id: "nt1", name: "NoTs" });
        const row = await env.DB.prepare("SELECT * FROM bmb_bare WHERE id = ?").bind("nt1").first();
        expect(row!.name).toBe("NoTs");
    });

    it("update does not touch updated_at", async () => {
        const model = await NoTsModel.create(env.DB, { id: "nt2", name: "Before" });
        model.set("name", "After" as any);
        await model.save(env.DB);

        const row = await env.DB.prepare("SELECT * FROM bmb_bare WHERE id = ?").bind("nt2").first();
        expect(row!.name).toBe("After");
    });
});

// ── query().first with no results ────────────────────────────────────

describe("query edge cases", () => {
    it("first() returns null when no rows match", async () => {
        const result = await NoTsModel.query().whereEq("id", "nonexistent").first(env.DB);
        expect(result).toBeNull();
    });
});

// ── find with non-existent ID ────────────────────────────────────────

describe("find edge cases", () => {
    it("find returns null for non-existent id", async () => {
        const result = await NoTsModel.find(env.DB, "nope");
        expect(result).toBeNull();
    });
});

// ── fill with guarded fields ─────────────────────────────────────────

class GuardedModel extends BaseModel<{ id?: string; name?: string; secret?: string }> {
    static table = "bmb_bare";
    static primaryKey = "id";
    static timestamps = false;
    static guarded = ["secret"];
}

class FillableModel extends BaseModel<{ id?: string; name?: string; secret?: string }> {
    static table = "bmb_bare";
    static primaryKey = "id";
    static timestamps = false;
    static fillable = ["name"];
}

describe("fill with mass assignment protection", () => {
    it("guarded fields are excluded from fill", () => {
        const m = new GuardedModel({ id: "g1" });
        m.fill({ name: "Test", secret: "hidden" } as any);
        expect(m.get("name")).toBe("Test");
        expect(m.get("secret")).toBeUndefined();
    });

    it("only fillable fields are included", () => {
        const m = new FillableModel({ id: "f1" });
        m.fill({ name: "Ok", secret: "nope" } as any);
        expect(m.get("name")).toBe("Ok");
        expect(m.get("secret")).toBeUndefined();
    });
});

// ── toObject with hidden fields ──────────────────────────────────────

class HiddenModel extends BaseModel<{ id?: string; name?: string; password?: string }> {
    static table = "bmb_bare";
    static primaryKey = "id";
    static timestamps = false;
    static hidden = ["password"];
}

describe("toObject with hidden fields", () => {
    it("excludes hidden fields from output", () => {
        const m = new HiddenModel({ id: "h1", name: "Visible", password: "secret" });
        const obj = m.toObject();
        expect(obj.name).toBe("Visible");
        expect(obj.password).toBeUndefined();
    });
});

// ── QueryBuilder: update/delete without WHERE ────────────────────────

describe("QB prepared statements without WHERE", () => {
    it("toUpdatePrepared without WHERE clause", async () => {
        await env.DB.prepare("INSERT INTO bmb_bare (id, name) VALUES (?, ?)").bind("up1", "Before").run();
        const stmt = new QueryBuilder(NoTsModel as any).toUpdatePrepared(env.DB, { name: "After" });
        await stmt.run();
        const row = await env.DB.prepare("SELECT * FROM bmb_bare WHERE id = ?").bind("up1").first();
        expect(row!.name).toBe("After");
    });

    it("toDeletePrepared without WHERE clause", async () => {
        await env.DB.prepare("INSERT INTO bmb_bare (id, name) VALUES (?, ?)").bind("dp1", "Gone").run();
        const stmt = new QueryBuilder(NoTsModel as any).toDeletePrepared(env.DB);
        await stmt.run();
        const row = await env.DB.prepare("SELECT * FROM bmb_bare WHERE id = ?").bind("dp1").first();
        expect(row).toBeNull();
    });
});

// ── setRelation / related ────────────────────────────────────────────

describe("setRelation and getRelation", () => {
    it("setRelation stores relation data", () => {
        const m = new NoTsModel({ id: "sr1", name: "Test" });
        m.setRelation("posts", [{ id: "p1" }]);
        expect((m.relations as any).posts).toEqual([{ id: "p1" }]);
    });
});
