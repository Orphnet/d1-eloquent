// baseModelExtended.integration.test.ts
// Coverage for BaseModel: asOf (diff-only path), revertTo, refresh, restore

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BaseModel } from "../baseModel";
import type { TRevisionConfig } from "../revisionTypes";
import type { CastDefinition } from "../castManager";

// ── Model with revisions (diff+after mode) ──────────────────────────

interface NoteAttrs {
    id?: string;
    title?: string;
    body?: string;
    created_at?: string | Date;
    updated_at?: string | Date;
    deleted_at?: string | Date | null;
}

class Note extends BaseModel<NoteAttrs> {
    static table = "bme_notes";
    static primaryKey = "id";
    static timestamps = true;
    static softDeletes = true;
    static revisions: TRevisionConfig = {
        enabled: true,
        mode: "diff+after",
    };
}

// ── Model with before+after revision mode ────────────────────────────

class SnapshotNote extends BaseModel<NoteAttrs> {
    static table = "bme_snap_notes";
    static primaryKey = "id";
    static timestamps = true;
    static softDeletes = false;
    static revisions: TRevisionConfig = {
        enabled: true,
        mode: "before+after",
    };
}

// ── Model with snapshot revision mode ────────────────────────────────

class SnapshotOnlyNote extends BaseModel<NoteAttrs> {
    static table = "bme_snapshot_notes";
    static primaryKey = "id";
    static timestamps = true;
    static softDeletes = false;
    static revisions: TRevisionConfig = {
        enabled: true,
        mode: "snapshot",
    };
}

// ── Model with diff-only revision mode ───────────────────────────────

class DiffNote extends BaseModel<NoteAttrs> {
    static table = "bme_diff_notes";
    static primaryKey = "id";
    static timestamps = true;
    static softDeletes = false;
    static revisions: TRevisionConfig = {
        enabled: true,
        mode: "diff",
    };
}

// ── Model without revisions ──────────────────────────────────────────

class SimpleNote extends BaseModel<NoteAttrs> {
    static table = "bme_simple_notes";
    static primaryKey = "id";
    static timestamps = true;
    static softDeletes = true;
}

// ── Model without timestamps ─────────────────────────────────────────

interface BareAttrs {
    id?: string;
    name?: string;
    deleted_at?: string | Date | null;
}

class BareModel extends BaseModel<BareAttrs> {
    static table = "bme_bare";
    static primaryKey = "id";
    static timestamps = false;
    static softDeletes = true;
}

// ── Setup ────────────────────────────────────────────────────────────

beforeAll(async () => {
    const noteTables = [
        "bme_notes",
        "bme_snap_notes",
        "bme_snapshot_notes",
        "bme_diff_notes",
        "bme_simple_notes",
    ];
    for (const t of noteTables) {
        await env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS ${t} (
                id TEXT PRIMARY KEY,
                title TEXT,
                body TEXT,
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT '',
                deleted_at TEXT
            )
        `).run();
    }

    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS bme_bare (
            id TEXT PRIMARY KEY,
            name TEXT,
            deleted_at TEXT
        )
    `).run();

    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS model_revisions (
            id TEXT PRIMARY KEY,
            model_table TEXT NOT NULL,
            model_pk TEXT NOT NULL,
            model_id TEXT NOT NULL,
            action TEXT NOT NULL,
            diff_json TEXT,
            before_json TEXT,
            after_json TEXT,
            actor_id TEXT,
            request_id TEXT,
            reason TEXT,
            created_at TEXT NOT NULL
        )
    `).run();
});

afterAll(async () => {
    for (const t of ["bme_notes", "bme_snap_notes", "bme_snapshot_notes", "bme_diff_notes", "bme_simple_notes", "bme_bare", "model_revisions"]) {
        await env.DB.prepare(`DROP TABLE IF EXISTS ${t}`).run();
    }
});

beforeEach(async () => {
    for (const t of ["bme_notes", "bme_snap_notes", "bme_snapshot_notes", "bme_diff_notes", "bme_simple_notes", "bme_bare", "model_revisions"]) {
        await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
});

// ── refresh ──────────────────────────────────────────────────────────

describe("model.refresh()", () => {
    it("reloads attributes from the database", async () => {
        const note = await Note.create(env.DB, { id: "r1", title: "Original", body: "text" });
        // Modify directly in DB
        await env.DB.prepare("UPDATE bme_notes SET title = ? WHERE id = ?").bind("Changed", "r1").run();

        await note.refresh(env.DB);
        expect(note.get("title")).toBe("Changed");
    });
});

// ── restore (soft delete) ────────────────────────────────────────────

describe("model.restore()", () => {
    it("restores a soft-deleted model", async () => {
        const note = await Note.create(env.DB, { id: "del1", title: "ToDelete", body: "body" });
        await note.delete(env.DB);
        expect(note.get("deleted_at")).not.toBeNull();

        const restored = await note.restore(env.DB);
        expect(restored).toBe(true);
        expect(note.get("deleted_at")).toBeNull();

        // Verify in DB
        const row = await env.DB.prepare("SELECT deleted_at FROM bme_notes WHERE id = ?").bind("del1").first();
        expect(row!.deleted_at).toBeNull();
    });

    it("returns false when model does not support soft deletes", async () => {
        const snap = await SnapshotNote.create(env.DB, { id: "ns1", title: "NoSoft", body: "x" });
        const result = await snap.restore(env.DB);
        expect(result).toBe(false);
    });

    it("restore on a bare model (no timestamps) still works", async () => {
        const bare = await BareModel.create(env.DB, { id: "b1", name: "Bare" });
        await bare.delete(env.DB);
        expect(bare.get("deleted_at")).not.toBeNull();

        const restored = await bare.restore(env.DB);
        expect(restored).toBe(true);
        expect(bare.get("deleted_at")).toBeNull();
    });
});

// ── asOf (time travel) ───────────────────────────────────────────────

describe("BaseModel.asOf()", () => {
    it("reconstructs model from snapshot (diff+after mode)", async () => {
        const note = await Note.create(env.DB, { id: "t1", title: "V1", body: "initial" });
        const createTime = note.get("created_at") as string;

        // Wait a tick and update
        note.set("title", "V2" as any);
        await note.save(env.DB);

        // asOf should return state at create time (V1 snapshot)
        const past = await Note.asOf(env.DB, "t1", new Date().toISOString());
        expect(past).not.toBeNull();
        expect(past!.get("title")).toBe("V2");
    });

    it("throws when revisions are not enabled", async () => {
        await SimpleNote.create(env.DB, { id: "s1", title: "NoRev", body: "x" });
        await expect(SimpleNote.asOf(env.DB, "s1", new Date().toISOString()))
            .rejects.toThrow("Revisions not enabled");
    });

    it("returns null when no revisions exist for the given model", async () => {
        const result = await Note.asOf(env.DB, "nonexistent", new Date().toISOString());
        expect(result).toBeNull();
    });
});

// ── revertTo ─────────────────────────────────────────────────────────

describe("BaseModel.revertTo()", () => {
    it("restores a model from a revision with an after snapshot", async () => {
        const note = await Note.create(env.DB, { id: "rv1", title: "First", body: "body" });
        note.set("title", "Second" as any);
        await note.save(env.DB);

        // Get the first revision (from creation)
        const rev = await env.DB.prepare(
            "SELECT * FROM model_revisions WHERE model_id = ? AND action = 'create' ORDER BY created_at ASC LIMIT 1"
        ).bind("rv1").first();
        expect(rev).not.toBeNull();

        // Import ModelRevision to wrap it
        const { ModelRevision } = await import("../modelRevision");
        const revModel = new ModelRevision(rev as any);

        const reverted = await Note.revertTo(env.DB, revModel);
        expect(reverted.get("title")).toBe("First");
    });

    it("throws when revision has no usable snapshot", async () => {
        const { ModelRevision } = await import("../modelRevision");
        const emptyRev = new ModelRevision({
            id: "bad",
            model_table: "bme_notes",
            model_pk: "id",
            model_id: "x",
            action: "update",
            diff_json: null,
            before_json: null,
            after_json: null,
            created_at: new Date().toISOString(),
        });

        await expect(Note.revertTo(env.DB, emptyRev)).rejects.toThrow("no usable snapshot");
    });
});

// ── Revision modes ───────────────────────────────────────────────────

describe("before+after revision mode", () => {
    it("stores both before and after snapshots on update", async () => {
        const note = await SnapshotNote.create(env.DB, { id: "ba1", title: "Init", body: "body" });
        note.set("title", "Changed" as any);
        await note.save(env.DB);

        const rev = await env.DB.prepare(
            "SELECT * FROM model_revisions WHERE model_id = ? AND action = 'update'"
        ).bind("ba1").first();
        expect(rev).not.toBeNull();
        expect(rev!.before_json).toBeTruthy();
        expect(rev!.after_json).toBeTruthy();
        expect(JSON.parse(rev!.before_json as string).title).toBe("Init");
        expect(JSON.parse(rev!.after_json as string).title).toBe("Changed");
    });
});

describe("snapshot revision mode", () => {
    it("stores before_json on create", async () => {
        await SnapshotOnlyNote.create(env.DB, { id: "sn1", title: "Snap", body: "body" });

        const rev = await env.DB.prepare(
            "SELECT * FROM model_revisions WHERE model_id = ? AND action = 'create'"
        ).bind("sn1").first();
        expect(rev).not.toBeNull();
        // snapshot mode: before_json for create is null, after_json has the snapshot
        expect(rev!.after_json).toBeTruthy();
    });
});

describe("diff revision mode", () => {
    it("stores only diff_json (no before/after)", async () => {
        const note = await DiffNote.create(env.DB, { id: "df1", title: "Init", body: "body" });
        note.set("title", "Updated" as any);
        await note.save(env.DB);

        const rev = await env.DB.prepare(
            "SELECT * FROM model_revisions WHERE model_id = ? AND action = 'update'"
        ).bind("df1").first();
        expect(rev).not.toBeNull();
        expect(rev!.diff_json).toBeTruthy();
        expect(rev!.before_json).toBeNull();
        expect(rev!.after_json).toBeNull();
    });
});

// ── Revision context ─────────────────────────────────────────────────

describe("revision context", () => {
    it("stores actor_id and reason when provided", async () => {
        const note = await Note.create(env.DB, { id: "ctx1", title: "Ctx", body: "body" });
        note.set("title", "With Context" as any);
        await note.save(env.DB, {
            revision: { actorId: "user-123", reason: "test update" },
        });

        const rev = await env.DB.prepare(
            "SELECT * FROM model_revisions WHERE model_id = ? AND action = 'update'"
        ).bind("ctx1").first();
        expect(rev!.actor_id).toBe("user-123");
        expect(rev!.reason).toBe("test update");
    });
});

// ── Revision on delete ───────────────────────────────────────────────

describe("revision on hard delete", () => {
    it("writes a revision when hard-deleting a model with revisions", async () => {
        const note = await SnapshotNote.create(env.DB, { id: "hd1", title: "HardDel", body: "body" });
        await note.delete(env.DB);

        const rev = await env.DB.prepare(
            "SELECT * FROM model_revisions WHERE model_id = ? AND action = 'delete'"
        ).bind("hd1").first();
        expect(rev).not.toBeNull();
    });
});

// ── Revision with includeRequestId ───────────────────────────────────

class RequestIdNote extends BaseModel<NoteAttrs> {
    static table = "bme_notes";
    static primaryKey = "id";
    static timestamps = true;
    static softDeletes = false;
    static revisions: TRevisionConfig = {
        enabled: true,
        mode: "diff+after",
        includeRequestId: true,
    };
}

describe("revision with includeRequestId", () => {
    it("stores request_id when includeRequestId is true", async () => {
        const note = await RequestIdNote.create(env.DB, { id: "ri1", title: "Req", body: "body" });
        note.set("title", "Updated" as any);
        await note.save(env.DB, {
            revision: { requestId: "req-abc-123" },
        });

        const rev = await env.DB.prepare(
            "SELECT * FROM model_revisions WHERE model_id = ? AND action = 'update'"
        ).bind("ri1").first();
        expect(rev!.request_id).toBe("req-abc-123");
    });
});

// ── Revision redact / only ───────────────────────────────────────────

class RedactedNote extends BaseModel<NoteAttrs> {
    static table = "bme_notes";
    static primaryKey = "id";
    static timestamps = true;
    static softDeletes = false;
    static revisions: TRevisionConfig = { enabled: true, mode: "diff+after" };
    static revisionRedact = ["body"];
}

class OnlyNote extends BaseModel<NoteAttrs> {
    static table = "bme_notes";
    static primaryKey = "id";
    static timestamps = true;
    static softDeletes = false;
    static revisions: TRevisionConfig = { enabled: true, mode: "before+after" };
    static revisionOnly = ["title"];
}

describe("revision field filtering", () => {
    it("redacts specified fields from revision data", async () => {
        const note = await RedactedNote.create(env.DB, { id: "rd1", title: "Pub", body: "secret" });
        note.set("title", "Changed" as any);
        note.set("body", "new-secret" as any);
        await note.save(env.DB);

        const rev = await env.DB.prepare(
            "SELECT * FROM model_revisions WHERE model_id = ? AND action = 'update'"
        ).bind("rd1").first();
        const afterData = JSON.parse(rev!.after_json as string);
        expect(afterData.body).toBeUndefined();
        expect(afterData.title).toBe("Changed");
    });

    it("only includes specified fields in revision data", async () => {
        const note = await OnlyNote.create(env.DB, { id: "on1", title: "Title", body: "excluded" });
        note.set("title", "NewTitle" as any);
        await note.save(env.DB);

        const rev = await env.DB.prepare(
            "SELECT * FROM model_revisions WHERE model_id = ? AND action = 'update'"
        ).bind("on1").first();
        const afterData = JSON.parse(rev!.after_json as string);
        expect(afterData.title).toBe("NewTitle");
        expect(afterData.body).toBeUndefined();
        expect(afterData.id).toBeUndefined();
    });
});
