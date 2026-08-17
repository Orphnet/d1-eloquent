// transactionHookAbort.integration.test.ts
// Covers every before-hook abort branch of the tx collector: a hook returning
// false throws TransactionAborted and nothing is flushed (all-or-nothing).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BaseModel } from "../baseModel";
import { transaction, TransactionAborted } from "../transaction";

interface Attrs { id?: string; name?: string }

// No-hook model to seed persisted rows for the UPDATE/DELETE abort paths.
class HaSeed extends BaseModel<Attrs> { static table = "ha_rows"; static timestamps = false; }

// One hooked model per abort branch (same table, so we can seed then re-load).
class HaSavingCreate extends BaseModel<Attrs> {
    static table = "ha_rows"; static timestamps = false;
    static hooks = { saving: () => false };
}
class HaSavingUpdate extends BaseModel<Attrs> {
    static table = "ha_rows"; static timestamps = false;
    static hooks = { saving: () => false };
}
class HaUpdating extends BaseModel<Attrs> {
    static table = "ha_rows"; static timestamps = false;
    static hooks = { updating: () => false }; // saving passes, updating aborts
}
class HaDeleting extends BaseModel<Attrs> {
    static table = "ha_rows"; static timestamps = false;
    static hooks = { deleting: () => false };
}

beforeAll(async () => {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ha_rows (id TEXT PRIMARY KEY, name TEXT)`).run();
});
beforeEach(async () => {
    await env.DB.prepare("DELETE FROM ha_rows").run();
});

const count = () => HaSeed.query().count(env.DB);

describe("tx before-hook aborts (all-or-nothing)", () => {
    it("create: saving=false aborts the tx", async () => {
        await expect(
            transaction(env.DB, async (tx) => {
                await tx.create(HaSeed, { id: "a", name: "ok" });
                await tx.create(HaSavingCreate, { id: "b", name: "x" }); // saving → false
            }),
        ).rejects.toBeInstanceOf(TransactionAborted);
        expect(await count()).toBe(0); // the earlier create is rolled back (never flushed)
    });

    it("save (update path): saving=false aborts the tx", async () => {
        await HaSeed.create(env.DB, { id: "u1", name: "A" });
        const row = await HaSavingUpdate.find(env.DB, "u1"); // persisted → save() takes UPDATE path
        row!.set("name", "A2");
        await expect(
            transaction(env.DB, async (tx) => { await tx.save(row!); }),
        ).rejects.toBeInstanceOf(TransactionAborted);
        expect((await HaSeed.find(env.DB, "u1"))!.get("name")).toBe("A"); // unchanged
    });

    it("save (update path): updating=false aborts the tx", async () => {
        await HaSeed.create(env.DB, { id: "u2", name: "B" });
        const row = await HaUpdating.find(env.DB, "u2");
        row!.set("name", "B2");
        await expect(
            transaction(env.DB, async (tx) => { await tx.save(row!); }),
        ).rejects.toBeInstanceOf(TransactionAborted);
        expect((await HaSeed.find(env.DB, "u2"))!.get("name")).toBe("B");
    });

    it("delete(instance): deleting=false aborts the tx", async () => {
        await HaSeed.create(env.DB, { id: "d1", name: "C" });
        const row = await HaDeleting.find(env.DB, "d1");
        await expect(
            transaction(env.DB, async (tx) => { await tx.delete(row!); }),
        ).rejects.toBeInstanceOf(TransactionAborted);
        expect(await count()).toBe(1); // still there
    });

    it("an empty transaction (no ops) is a no-op and returns the closure value", async () => {
        const out = await transaction(env.DB, async () => 42); // flush() early-returns on 0 statements
        expect(out).toBe(42);
        expect(await count()).toBe(0);
    });
});

// Revisions-enabled model with revisionRedact + revisionOnly SET — exercises the
// "present" side of `ctor.revisionRedact ?? []` / `ctor.revisionOnly ?? null` in
// maybeRevision (default-configured models only ever take the fallback side).
class HaAudited extends BaseModel<{ id?: string; name?: string; secret?: string }> {
    static table = "ha_aud"; static timestamps = false;
    static revisions = { enabled: true, mode: "snapshot" } as const;
    static revisionRedact = ["secret"];
    static revisionOnly = ["id", "name", "secret"];
}

describe("tx revisions honour revisionRedact / revisionOnly", () => {
    beforeAll(async () => {
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ha_aud (id TEXT PRIMARY KEY, name TEXT, secret TEXT)`).run();
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS model_revisions (
            id TEXT PRIMARY KEY, model_table TEXT, model_pk TEXT, model_id TEXT, action TEXT,
            diff_json TEXT, before_json TEXT, after_json TEXT, actor_id TEXT, request_id TEXT,
            reason TEXT, created_at TEXT)`).run();
    });
    beforeEach(async () => {
        await env.DB.prepare("DELETE FROM ha_aud").run();
        await env.DB.prepare("DELETE FROM model_revisions").run();
    });

    it("writes a revision row with redact + only applied", async () => {
        const id = crypto.randomUUID();
        await transaction(
            env.DB,
            async (tx) => { await tx.create(HaAudited, { id, name: "n", secret: "s" }); },
            { revision: { actorId: "me" } },
        );
        const rev = await env.DB.prepare("SELECT after_json, actor_id FROM model_revisions WHERE model_id = ?").bind(id).first<{ after_json: string; actor_id: string }>();
        expect(rev).not.toBeNull();
        expect(rev!.actor_id).toBe("me");
        const after = JSON.parse(rev!.after_json);
        expect(after.secret).toBeUndefined(); // redacted
        expect(after.name).toBe("n"); // kept via `only`
    });
});
