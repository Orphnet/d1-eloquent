// coverage100.transactionPersistence.test.ts
// Closes the remaining coverage gaps in transaction.ts and
// managers/persistenceManager.ts. Every test asserts observable behavior of
// the branch it targets (DB state, hook firing, revision rows, error text).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BaseModel } from "../baseModel";
import { transaction, TransactionAborted, type Tx } from "../transaction";
import { registerConnection, unregisterConnection } from "../registry";
import type { CacheAdapter, CacheInvalidationEvent } from "../cacheAdapter";

interface UserAttrs { id?: string; name?: string }
interface SoftTsAttrs { id?: string; name?: string; created_at?: string; updated_at?: string; deleted_at?: string | null }
interface SoftAttrs { id?: string; name?: string; deleted_at?: string | null }

// ---------------------------------------------------------------------------
// transaction.ts fixtures
// ---------------------------------------------------------------------------

class TUser extends BaseModel<UserAttrs> { static table = "tx100_users"; static timestamps = false; }

// Ctors whose static `name` is forced to undefined so the `name ?? table`
// fallback in save / prepareInsertLike / collectInstanceDelete is exercised.
class NamelessSave extends BaseModel<UserAttrs> {
    static table = "tx100_users"; static timestamps = false;
    static hooks = { saving: () => false as const };
}
Object.defineProperty(NamelessSave, "name", { value: undefined });

class NamelessCreate extends BaseModel<UserAttrs> {
    static table = "tx100_users"; static timestamps = false;
    static hooks = { creating: () => false as const };
}
Object.defineProperty(NamelessCreate, "name", { value: undefined });

class NamelessDelete extends BaseModel<UserAttrs> {
    static table = "tx100_users"; static timestamps = false;
    static hooks = { deleting: () => false as const };
}
Object.defineProperty(NamelessDelete, "name", { value: undefined });

// Soft-delete model WITH timestamps - tx.delete must touch updated_at too.
class SoftTs extends BaseModel<SoftTsAttrs> {
    static table = "tx100_soft_ts"; static timestamps = true; static softDeletes = true;
}

// Revisions enabled but revisionRedact wiped to undefined - the
// `ctor.revisionRedact ?? []` fallback must leave the payload unredacted.
class TxNoRedact extends BaseModel<UserAttrs> {
    static table = "tx100_users"; static timestamps = false;
    static revisions = { enabled: true, mode: "snapshot" } as const;
    static revisionRedact = undefined as unknown as string[];
}

// Records gated after-hooks for the "missing meta" flush test.
const fakeDbHookCalls: string[] = [];
class GatedRec extends BaseModel<UserAttrs> {
    static table = "tx100_users"; static timestamps = false;
    static hooks = {
        updated: () => { fakeDbHookCalls.push("updated"); return true as const; },
        saved: () => { fakeDbHookCalls.push("saved"); return true as const; },
    };
}

// ---------------------------------------------------------------------------
// persistenceManager.ts fixtures
// ---------------------------------------------------------------------------

class PmRev extends BaseModel<UserAttrs> {
    static table = "pm100_plain"; static timestamps = false;
    static revisions = { enabled: true, mode: "diff" } as const;
}

const updBlockCalls: string[] = [];
class PmUpdBlock extends BaseModel<UserAttrs> {
    static table = "pm100_plain"; static timestamps = false;
    static hooks = {
        updating: () => false as const,
        updated: () => { updBlockCalls.push("updated"); return true as const; },
    };
}

class PmNoRedact extends BaseModel<UserAttrs> {
    static table = "pm100_plain"; static timestamps = false;
    static revisions = { enabled: true, mode: "snapshot" } as const;
    static revisionRedact = undefined as unknown as string[];
}

const softDeletedCalls: string[] = [];
class PmSoft extends BaseModel<SoftAttrs> {
    static table = "pm100_soft"; static timestamps = false; static softDeletes = true;
    static hooks = { deleted: () => { softDeletedCalls.push("deleted"); return true as const; } };
}

class PmSoftNoRedact extends BaseModel<SoftAttrs> {
    static table = "pm100_soft"; static timestamps = false; static softDeletes = true;
    static revisions = { enabled: true, mode: "snapshot" } as const;
    static revisionRedact = undefined as unknown as string[];
}

class PmHard extends BaseModel<UserAttrs> { static table = "pm100_plain"; static timestamps = false; }

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

beforeAll(async () => {
    registerConnection("default", env.DB);
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS tx100_users (id TEXT PRIMARY KEY, name TEXT)").run();
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS tx100_soft_ts (id TEXT PRIMARY KEY, name TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT)").run();
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS pm100_plain (id TEXT PRIMARY KEY, name TEXT)").run();
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS pm100_soft (id TEXT PRIMARY KEY, name TEXT, deleted_at TEXT)").run();
    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS model_revisions (
            id TEXT PRIMARY KEY, model_table TEXT NOT NULL, model_pk TEXT NOT NULL,
            model_id TEXT NOT NULL, action TEXT NOT NULL, diff_json TEXT,
            before_json TEXT, after_json TEXT, actor_id TEXT, request_id TEXT,
            reason TEXT, created_at TEXT NOT NULL
        )
    `).run();
});

afterAll(() => {
    unregisterConnection("default");
});

beforeEach(async () => {
    await env.DB.prepare("DELETE FROM tx100_users").run();
    await env.DB.prepare("DELETE FROM tx100_soft_ts").run();
    await env.DB.prepare("DELETE FROM pm100_plain").run();
    await env.DB.prepare("DELETE FROM pm100_soft").run();
    await env.DB.prepare("DELETE FROM model_revisions").run();
    fakeDbHookCalls.length = 0;
    updBlockCalls.length = 0;
    softDeletedCalls.length = 0;
});

// ---------------------------------------------------------------------------
// transaction.ts
// ---------------------------------------------------------------------------

describe("transaction.ts - remaining branch coverage", () => {
    it("tx.save abort message falls back to the table name when ctor.name is undefined (line 190)", async () => {
        await env.DB.prepare("INSERT INTO tx100_users (id, name) VALUES ('n1', 'orig')").run();
        const m = await NamelessSave.find(env.DB, "n1");
        expect(m).not.toBeNull();
        m!.set("name", "changed");
        let caught: unknown;
        await transaction(env.DB, async (tx) => { await tx.save(m!); }).catch((e: unknown) => { caught = e; });
        expect(caught).toBeInstanceOf(TransactionAborted);
        expect((caught as Error).message).toContain("tx100_users");
        expect((caught as Error).message).toContain("saving");
        // Nothing was written - the abort happened before any statement collected.
        const row = await env.DB.prepare("SELECT name FROM tx100_users WHERE id = 'n1'").first<{ name: string }>();
        expect(row!.name).toBe("orig");
    });

    it("tx.save on a clean persisted model collects NO statement and returns the instance (line 209)", async () => {
        await env.DB.prepare("INSERT INTO tx100_users (id, name) VALUES ('c1', 'same')").run();
        const m = await TUser.find(env.DB, "c1");
        let captured!: Tx;
        const ret = await transaction(env.DB, async (tx) => {
            captured = tx;
            return tx.save(m!);
        });
        expect(ret).toBe(m); // the very same instance is handed back
        expect(captured.results).toHaveLength(0); // nothing to write means nothing batched
        const row = await env.DB.prepare("SELECT name FROM tx100_users WHERE id = 'c1'").first<{ name: string }>();
        expect(row!.name).toBe("same");
    });

    it("tx.create abort message falls back to the table name when ctor.name is undefined (line 301)", async () => {
        let caught: unknown;
        await transaction(env.DB, async (tx) => {
            await tx.create(NamelessCreate, { id: crypto.randomUUID(), name: "x" });
        }).catch((e: unknown) => { caught = e; });
        expect(caught).toBeInstanceOf(TransactionAborted);
        expect((caught as Error).message).toContain("tx100_users");
        expect((caught as Error).message).toContain("creating");
        expect(await TUser.query().count(env.DB)).toBe(0);
    });

    it("tx.delete abort message falls back to the table name when ctor.name is undefined (line 338)", async () => {
        await env.DB.prepare("INSERT INTO tx100_users (id, name) VALUES ('d1', 'keep')").run();
        const m = await NamelessDelete.find(env.DB, "d1");
        let caught: unknown;
        await transaction(env.DB, async (tx) => { await tx.delete(m!); }).catch((e: unknown) => { caught = e; });
        expect(caught).toBeInstanceOf(TransactionAborted);
        expect((caught as Error).message).toContain("tx100_users");
        expect((caught as Error).message).toContain("deleting");
        expect(await TUser.query().count(env.DB)).toBe(1); // row survives the abort
    });

    it("tx.delete on a soft-delete model with timestamps touches updated_at (line 354)", async () => {
        await SoftTs.create(env.DB, { id: "st1", name: "a" });
        const sentinel = "2000-01-01T00:00:00.000Z";
        await env.DB.prepare("UPDATE tx100_soft_ts SET updated_at = ? WHERE id = 'st1'").bind(sentinel).run();
        const m = await SoftTs.find(env.DB, "st1");
        await transaction(env.DB, async (tx) => { await tx.delete(m!); });
        const row = await env.DB.prepare("SELECT updated_at, deleted_at FROM tx100_soft_ts WHERE id = 'st1'")
            .first<{ updated_at: string; deleted_at: string }>();
        expect(row!.deleted_at).not.toBeNull();
        expect(row!.updated_at).not.toBe(sentinel); // updated_at was touched by the delete
        expect(row!.updated_at).toBe(row!.deleted_at); // both set from the SAME now
    });

    it("in-tx revision with revisionRedact undefined falls back to [] and redacts nothing (line 405)", async () => {
        const id = crypto.randomUUID();
        await transaction(env.DB, async (tx) => { await tx.create(TxNoRedact, { id, name: "visible" }); });
        const rev = await env.DB.prepare("SELECT action, after_json FROM model_revisions WHERE model_id = ?")
            .bind(id).first<{ action: string; after_json: string }>();
        expect(rev).not.toBeNull();
        expect(rev!.action).toBe("create");
        expect(JSON.parse(rev!.after_json)).toMatchObject({ name: "visible" }); // no field redacted
    });

    it("a revision builder returning null is tolerated: data commits, no revision pushed (line 411)", async () => {
        // config.enabled is read twice on the create path: once by maybeRevision's
        // guard, once inside buildRevisionStatement. Answer true then false so the
        // guard passes but the builder returns null - the only way stmt can be falsy.
        let enabledReads = 0;
        const flipCfg = {
            get enabled(): boolean { enabledReads += 1; return enabledReads === 1; },
            mode: "snapshot" as const,
        };
        class TxFlip extends BaseModel<UserAttrs> {
            static table = "tx100_users"; static timestamps = false;
            static revisions = flipCfg;
        }
        const id = crypto.randomUUID();
        let captured!: Tx;
        await transaction(env.DB, async (tx) => {
            captured = tx;
            await tx.create(TxFlip, { id, name: "flip" });
        });
        expect(enabledReads).toBe(2); // guard + builder, nothing else reads it
        expect(captured.results).toHaveLength(1); // only the data INSERT was batched
        const row = await env.DB.prepare("SELECT name FROM tx100_users WHERE id = ?").bind(id).first<{ name: string }>();
        expect(row!.name).toBe("flip"); // data row committed fine
        const n = await env.DB.prepare("SELECT COUNT(*) c FROM model_revisions").first<{ c: number }>();
        expect(n!.c).toBe(0); // no revision row and no crash
    });

    it("an op missing persistedAfter defaults the model to persisted via ?? true (line 423)", async () => {
        // Every op-creation site in transaction.ts sets persistedAfter explicitly,
        // so the ?? true fallback only fires for an op shaped by older/foreign code.
        // Inject such an op (model set, persistedAfter omitted, valid dataIdx) into
        // the tx's internal ops list and assert the fallback stamps _persisted true.
        await env.DB.prepare("INSERT INTO tx100_users (id, name) VALUES ('pa1', 'before')").run();
        const legacy = new TUser();
        legacy.set("id", "pa-legacy");
        legacy.set("name", "x");
        expect((legacy as unknown as { _persisted: boolean })._persisted).toBe(false);
        expect(legacy.isDirty()).toBe(true);
        await transaction(env.DB, async (tx) => {
            // Collect a real data statement through the public API (bulk update op,
            // which records NO model of its own) so dataIdx 0 has a genuine result.
            tx.update(TUser.query().whereEq("id", "pa1"), { name: "after" });
            (tx as unknown as { ops: Array<{ model: unknown; dataIdx: number; afterHooks: string[] }> }).ops.push({
                model: legacy,
                dataIdx: 0,
                afterHooks: [],
            });
        });
        // The real statement committed...
        const row = await env.DB.prepare("SELECT name FROM tx100_users WHERE id = 'pa1'").first<{ name: string }>();
        expect(row!.name).toBe("after");
        // ...and the finalize loop took the ?? true fallback for the injected op:
        expect((legacy as unknown as { _persisted: boolean })._persisted).toBe(true);
        expect(legacy.isDirty()).toBe(false); // syncOriginal ran on the same pass
    });

    it("a batch result without meta counts as 'no rows changed': gated after-hooks stay silent (line 431)", async () => {
        // Positive control on real D1: an update that changed a row fires updated+saved.
        await env.DB.prepare("INSERT INTO tx100_users (id, name) VALUES ('g1', 'A')").run();
        const control = await GatedRec.find(env.DB, "g1");
        await transaction(env.DB, async (tx) => {
            control!.set("name", "B");
            await tx.save(control!);
        });
        expect(fakeDbHookCalls).toEqual(["updated", "saved"]);

        // Now flush against a D1-compatible adapter whose results carry NO meta:
        // the `?? 0` fallback must treat that as 0 changes and skip the hooks.
        fakeDbHookCalls.length = 0;
        const m = await GatedRec.find(env.DB, "g1");
        m!.set("name", "C");
        const batches: unknown[][] = [];
        const fakeDb = {
            prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({ sql, args }) }),
            batch: async (stmts: unknown[]) => {
                batches.push(stmts);
                return stmts.map(() => ({ success: true, results: [], meta: undefined }));
            },
        } as unknown as D1Database;
        await transaction(fakeDb, async (tx) => { await tx.save(m!); });
        expect(batches).toHaveLength(1);
        expect(batches[0]).toHaveLength(1); // exactly the UPDATE statement was flushed
        expect(fakeDbHookCalls).toEqual([]); // missing meta gates the after-hooks OFF
        expect((m as unknown as { _persisted: boolean })._persisted).toBe(true); // stamped regardless
        expect(m!.isDirty("name")).toBe(false); // the pending change was still settled post-flush
    });
});

// ---------------------------------------------------------------------------
// managers/persistenceManager.ts
// ---------------------------------------------------------------------------

describe("persistenceManager.ts - remaining branch coverage", () => {
    it("saving a clean persisted model performs no UPDATE: no update revision is written (line 82)", async () => {
        const created = await PmRev.create(env.DB, { id: "r1", name: "same" });
        expect(created.get("id")).toBe("r1");
        const m = await PmRev.find(env.DB, "r1");
        await m!.save(env.DB); // nothing dirty -> performUpdate returns 0
        const revs = await env.DB.prepare("SELECT action FROM model_revisions WHERE model_id = 'r1'").all();
        expect(revs.results.map((r) => (r as { action: string }).action)).toEqual(["create"]); // no update revision
        const row = await env.DB.prepare("SELECT name FROM pm100_plain WHERE id = 'r1'").first<{ name: string }>();
        expect(row!.name).toBe("same");
        expect(m!.isDirty()).toBe(false);
    });

    it("an updating hook returning false cancels save: no write, no after-hook, model stays dirty (line 105)", async () => {
        await env.DB.prepare("INSERT INTO pm100_plain (id, name) VALUES ('b1', 'orig')").run();
        const m = await PmUpdBlock.find(env.DB, "b1");
        m!.set("name", "blocked");
        await m!.save(env.DB); // updating -> false, save returns early
        const row = await env.DB.prepare("SELECT name FROM pm100_plain WHERE id = 'b1'").first<{ name: string }>();
        expect(row!.name).toBe("orig"); // DB untouched
        expect(updBlockCalls).toEqual([]); // updated after-hook never fired
        expect(m!.isDirty()).toBe(true); // originals NOT synced - change still pending
    });

    it("create + update revisions with revisionRedact undefined fall back to [] (lines 137, 179)", async () => {
        const m = await PmNoRedact.create(env.DB, { id: "nr1", name: "open" });
        m.set("name", "open2");
        await m.save(env.DB);
        const revs = await env.DB.prepare(
            "SELECT action, after_json FROM model_revisions WHERE model_id = 'nr1' ORDER BY created_at, action",
        ).all();
        const actions = revs.results.map((r) => (r as { action: string }).action).sort();
        expect(actions).toEqual(["create", "update"]);
        for (const r of revs.results as { action: string; after_json: string }[]) {
            const after = JSON.parse(r.after_json) as { name?: string };
            expect(after.name).toBe(r.action === "create" ? "open" : "open2"); // nothing redacted
        }
    });

    it("hard-delete revision with revisionRedact undefined falls back to [] (line 276)", async () => {
        const m = await PmNoRedact.create(env.DB, { id: "nr2", name: "gone" });
        const ok = await m.delete(env.DB);
        expect(ok).toBe(true);
        const row = await env.DB.prepare("SELECT id FROM pm100_plain WHERE id = 'nr2'").first();
        expect(row).toBeNull(); // hard delete removed the row
        const rev = await env.DB.prepare(
            "SELECT before_json FROM model_revisions WHERE model_id = 'nr2' AND action = 'delete'",
        ).first<{ before_json: string }>();
        expect(rev).not.toBeNull();
        expect(JSON.parse(rev!.before_json)).toMatchObject({ name: "gone" }); // unredacted snapshot
    });

    it("soft delete without an explicit db resolves via the registry (line 227 else-branch)", async () => {
        await PmSoft.create(env.DB, { id: "ps1", name: "n" });
        const m = await PmSoft.find(env.DB, "ps1");
        const ok = await m!.delete(); // no db argument - registry 'default' connection
        expect(ok).toBe(true);
        const row = await env.DB.prepare("SELECT deleted_at FROM pm100_soft WHERE id = 'ps1'").first<{ deleted_at: string | null }>();
        expect(row!.deleted_at).not.toBeNull(); // trashed, not destroyed
        expect(softDeletedCalls).toEqual(["deleted"]); // changed > 0 fired the hook
    });

    it("soft-delete revision with revisionRedact undefined falls back to []; restore writes an update revision (lines 241, 329)", async () => {
        const m = await PmSoftNoRedact.create(env.DB, { id: "psr1", name: "soft" });
        expect(await m.delete(env.DB)).toBe(true);
        expect(await m.restore(env.DB)).toBe(true);
        const revs = await env.DB.prepare(
            "SELECT action, before_json FROM model_revisions WHERE model_id = 'psr1'",
        ).all();
        const actions = revs.results.map((r) => (r as { action: string }).action).sort();
        expect(actions).toEqual(["create", "delete", "update"]); // delete AND restore audited
        const del = (revs.results as { action: string; before_json: string | null }[]).find((r) => r.action === "delete");
        expect(JSON.parse(del!.before_json!)).toMatchObject({ name: "soft" }); // unredacted
        const row = await env.DB.prepare("SELECT deleted_at FROM pm100_soft WHERE id = 'psr1'").first<{ deleted_at: string | null }>();
        expect(row!.deleted_at).toBeNull(); // restored for real
    });

    it("soft delete matching zero rows returns false and skips the deleted hook (line 256 else-branch)", async () => {
        await PmSoft.create(env.DB, { id: "ps2", name: "n" });
        const m = await PmSoft.find(env.DB, "ps2");
        await env.DB.prepare("DELETE FROM pm100_soft WHERE id = 'ps2'").run(); // yank the row out from under it
        softDeletedCalls.length = 0;
        const ok = await m!.delete(env.DB);
        expect(ok).toBe(false); // 0-row UPDATE reports failure
        expect(softDeletedCalls).toEqual([]); // deleted hook gated off
    });

    it("hard delete invalidates the cache adapter with a delete event (lines 281-286)", async () => {
        await PmHard.create(env.DB, { id: "ph1", name: "x" });
        const m = await PmHard.find(env.DB, "ph1");
        const events: CacheInvalidationEvent[] = [];
        const cache = { invalidate: async (e: CacheInvalidationEvent) => { events.push(e); } } as CacheAdapter;
        const ok = await m!.delete(env.DB, { cache });
        expect(ok).toBe(true);
        expect(events).toEqual([{ table: "pm100_plain", id: "ph1", action: "delete" }]);
        expect(await env.DB.prepare("SELECT id FROM pm100_plain WHERE id = 'ph1'").first()).toBeNull();
    });

    it("hard delete matching zero rows returns false, fires no hook, invalidates no cache (line 289 else-branch)", async () => {
        await PmHard.create(env.DB, { id: "ph2", name: "x" });
        const m = await PmHard.find(env.DB, "ph2");
        await env.DB.prepare("DELETE FROM pm100_plain WHERE id = 'ph2'").run();
        const events: CacheInvalidationEvent[] = [];
        const cache = { invalidate: async (e: CacheInvalidationEvent) => { events.push(e); } } as CacheAdapter;
        const ok = await m!.delete(env.DB, { cache });
        expect(ok).toBe(false);
        expect(events).toEqual([]); // no invalidation for a no-op delete
    });

    it("restore on a model without a primary key returns false (line 302)", async () => {
        const m = new PmSoft();
        const ok = await m.restore(env.DB);
        expect(ok).toBe(false);
        expect(await env.DB.prepare("SELECT COUNT(*) c FROM pm100_soft").first<{ c: number }>().then((r) => r!.c)).toBe(0);
    });

    it("restore without an explicit db resolves via the registry (line 315 else-branch)", async () => {
        await PmSoft.create(env.DB, { id: "pr1", name: "n" });
        const m = await PmSoft.find(env.DB, "pr1");
        await m!.delete(env.DB); // trash it first
        const ok = await m!.restore(); // no db argument - registry 'default' connection
        expect(ok).toBe(true);
        const row = await env.DB.prepare("SELECT deleted_at FROM pm100_soft WHERE id = 'pr1'").first<{ deleted_at: string | null }>();
        expect(row!.deleted_at).toBeNull(); // live again
    });
});
