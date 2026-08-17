// transaction.integration.test.ts
// Live D1 integration tests for transaction() — the write-only unit-of-work.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BaseModel } from "../baseModel";
import { transaction, TransactionAborted, type Tx } from "../transaction";

interface UserAttrs { id?: string; name?: string }
interface PostAttrs { id?: string; user_id?: string; title?: string }
interface DocAttrs { id?: string; meta?: string }
class TxUser extends BaseModel<UserAttrs> { static table = "tx_users"; static timestamps = false; }

// A model whose `creating` before-hook always cancels — used to prove that a
// hook returning false aborts the ENTIRE unit of work.
class TxGuarded extends BaseModel<UserAttrs> {
  static table = "tx_users"; static timestamps = false;
  static hooks = { creating: () => false as const };
}
class TxPost extends BaseModel<PostAttrs> { static table = "tx_posts"; static timestamps = false; }
class TxDoc extends BaseModel<DocAttrs> { static table = "tx_docs"; static timestamps = false; }

// A revisions-enabled model. keyStrategy=false so an explicit null PK stays
// null (the default "uuid" strategy would auto-fill it), letting the rollback
// test fail the batch via the NOT NULL primary key.
interface AuditedAttrs { id?: string; v?: number }
class TxAudited extends BaseModel<AuditedAttrs> {
  static table = "tx_aud"; static timestamps = false;
  static keyStrategy = false as const;
  static revisions = { enabled: true, mode: "snapshot" } as const;
}

// A soft-delete model — tx.delete() must trash (set deleted_at), never hard-DELETE.
class TxSoft extends BaseModel<{ id?: string; name?: string; deleted_at?: string | null }> {
  static table = "tx_soft"; static timestamps = false; static softDeletes = true;
}
// A revisions model in `diff` mode — proves the in-batch revision carries a real diff.
class TxDiff extends BaseModel<{ id?: string; name?: string }> {
  static table = "tx_diff"; static timestamps = false;
  static revisions = { enabled: true, mode: "diff" } as const;
}
// Records what the `creating` hook observed, to prove hooks run pre-stamp.
const creatingSawId: (string | undefined)[] = [];
class TxHookOrder extends BaseModel<{ id?: string; name?: string }> {
  static table = "tx_users"; static timestamps = false;
  static hooks = { creating: (m: TxHookOrder) => { creatingSawId.push(m.get("id") as string | undefined); return true as const; } };
}

// Records after-hook invocations, to prove update/delete after-hooks fire only
// when a row actually changed (parity with the non-tx path).
const gatedHookCalls: string[] = [];
class TxGatedHooks extends BaseModel<UserAttrs> {
  static table = "tx_users"; static timestamps = false;
  static hooks = {
    updated: () => { gatedHookCalls.push("updated"); return true as const; },
    deleted: () => { gatedHookCalls.push("deleted"); return true as const; },
  };
}

beforeAll(async () => {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS tx_users (id TEXT PRIMARY KEY, name TEXT NOT NULL)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS tx_posts (id TEXT PRIMARY KEY, user_id TEXT, title TEXT)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS tx_docs (id TEXT PRIMARY KEY, meta TEXT)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS tx_aud (id TEXT PRIMARY KEY NOT NULL, v INTEGER)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS tx_soft (id TEXT PRIMARY KEY, name TEXT, deleted_at TEXT)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS tx_diff (id TEXT PRIMARY KEY, name TEXT)`).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS model_revisions (
      id TEXT PRIMARY KEY, model_table TEXT NOT NULL, model_pk TEXT NOT NULL,
      model_id TEXT NOT NULL, action TEXT NOT NULL, diff_json TEXT,
      before_json TEXT, after_json TEXT, actor_id TEXT, request_id TEXT,
      reason TEXT, created_at TEXT NOT NULL
    )
  `).run();
});
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM tx_posts").run();
  await env.DB.prepare("DELETE FROM tx_users").run();
  await env.DB.prepare("DELETE FROM tx_docs").run();
  await env.DB.prepare("DELETE FROM tx_aud").run();
  await env.DB.prepare("DELETE FROM tx_soft").run();
  await env.DB.prepare("DELETE FROM tx_diff").run();
  await env.DB.prepare("DELETE FROM model_revisions").run();
});

describe("transaction() — create + atomicity", () => {
  it("creates related rows atomically (parent + child via client UUID)", async () => {
    const uid = crypto.randomUUID();
    const user = await transaction(env.DB, async (tx) => {
      const u = await tx.create(TxUser, { id: uid, name: "Alice" });
      await tx.create(TxPost, { id: crypto.randomUUID(), user_id: u.get("id"), title: "hi" });
      return u;
    });
    expect(user.get("id")).toBe(uid);
    expect(await TxUser.query().count(env.DB)).toBe(1);
    expect(await TxPost.query().count(env.DB)).toBe(1);
  });

  it("rolls back everything when a statement fails (NOT NULL violation)", async () => {
    await expect(transaction(env.DB, async (tx) => {
      await tx.create(TxUser, { id: crypto.randomUUID(), name: "Ok" });
      await tx.create(TxUser, { id: crypto.randomUUID() }); // name is NOT NULL → batch fails
    })).rejects.toThrow();
    expect(await TxUser.query().count(env.DB)).toBe(0); // nothing persisted
  });
});

describe("transaction() — save/update/delete", () => {
  it("commits a loaded-instance update, a bulk update, and a delete atomically", async () => {
    await TxUser.create(env.DB, { id: "u1", name: "A" });
    await TxUser.create(env.DB, { id: "u2", name: "B" });
    const u1 = await TxUser.find(env.DB, "u1");
    await transaction(env.DB, async (tx) => {
      u1!.set("name", "A2");
      await tx.save(u1!);                                             // UPDATE by PK
      tx.update(TxUser.query().whereEq("id", "u2"), { name: "B2" });  // bulk update
    });
    expect((await TxUser.find(env.DB, "u1"))!.get("name")).toBe("A2");
    expect((await TxUser.find(env.DB, "u2"))!.get("name")).toBe("B2");
  });

  it("delete(query) removes rows in the same tx", async () => {
    await TxUser.create(env.DB, { id: "u1", name: "A" });
    await transaction(env.DB, async (tx) => { tx.delete(TxUser.query().whereEq("id", "u1")); });
    expect(await TxUser.query().count(env.DB)).toBe(0);
  });

  it("delete(instance) removes the row by PK in the same tx", async () => {
    await TxUser.create(env.DB, { id: "u1", name: "A" });
    const u1 = await TxUser.find(env.DB, "u1");
    await transaction(env.DB, async (tx) => { await tx.delete(u1!); });
    expect(await TxUser.query().count(env.DB)).toBe(0);
  });

  it("save(unpersisted instance) inserts, and a failed batch rolls back the save", async () => {
    // insert path via save
    const fresh = new TxUser({ id: "u9", name: "Fresh" });
    await transaction(env.DB, async (tx) => { await tx.save(fresh); });
    expect((await TxUser.find(env.DB, "u9"))!.get("name")).toBe("Fresh");

    // rollback path: the save's UPDATE is discarded when a later statement fails
    const u9 = await TxUser.find(env.DB, "u9");
    await expect(transaction(env.DB, async (tx) => {
      u9!.set("name", "Changed");
      await tx.save(u9!);
      await tx.create(TxUser, { id: crypto.randomUUID() }); // name NOT NULL → batch fails
    })).rejects.toThrow();
    expect((await TxUser.find(env.DB, "u9"))!.get("name")).toBe("Fresh"); // save reverted
  });
});

describe("transaction() — upsert + updateJson*", () => {
  it("upsert covers both paths atomically: insert (no conflict) and update (conflict)", async () => {
    await TxUser.create(env.DB, { id: "u1", name: "Old" });
    const freshId = crypto.randomUUID();
    await transaction(env.DB, async (tx) => {
      const fresh = await tx.upsert(TxUser, { id: freshId, name: "New" }, ["id"]);       // insert path
      const clash = await tx.upsert(TxUser, { id: "u1", name: "Updated" }, ["id"]);       // conflict → update
      expect(fresh.get("id")).toBe(freshId);
      expect(clash.get("name")).toBe("Updated");
    });
    expect(await TxUser.query().count(env.DB)).toBe(2);
    expect((await TxUser.find(env.DB, freshId))!.get("name")).toBe("New");
    expect((await TxUser.find(env.DB, "u1"))!.get("name")).toBe("Updated");
  });

  it("updateJsonSet / updateJsonPatch / updateJsonRemove commit in the same batch", async () => {
    await TxDoc.create(env.DB, { id: "d1", meta: JSON.stringify({ a: 1, b: 2 }) });
    await transaction(env.DB, async (tx) => {
      tx.updateJsonSet(TxDoc.query().whereEq("id", "d1"), "meta", "$.a", 9);
      tx.updateJsonPatch(TxDoc.query().whereEq("id", "d1"), "meta", { c: 3 });
      tx.updateJsonRemove(TxDoc.query().whereEq("id", "d1"), "meta", "$.b");
    });
    const meta = JSON.parse((await TxDoc.find(env.DB, "d1"))!.get("meta") as string) as Record<string, unknown>;
    expect(meta).toEqual({ a: 9, c: 3 });
  });

  it("rolls back upsert + JSON ops together when the batch fails", async () => {
    await TxDoc.create(env.DB, { id: "d1", meta: JSON.stringify({ a: 1 }) });
    await expect(transaction(env.DB, async (tx) => {
      await tx.upsert(TxUser, { id: "u1", name: "X" }, ["id"]);
      tx.updateJsonSet(TxDoc.query().whereEq("id", "d1"), "meta", "$.a", 9);
      await tx.create(TxUser, { id: crypto.randomUUID() }); // name NOT NULL → batch fails
    })).rejects.toThrow();
    expect(await TxUser.query().count(env.DB)).toBe(0);                                  // upsert reverted
    expect(JSON.parse((await TxDoc.find(env.DB, "d1"))!.get("meta") as string).a).toBe(1); // json op reverted
  });
});

describe("transaction() — revisions in-batch", () => {
  it("writes the data row AND its revision row atomically", async () => {
    const id = crypto.randomUUID();
    await transaction(env.DB, async (tx) => { await tx.create(TxAudited, { id, v: 1 }); },
      { revision: { actorId: "system" } });
    const rev = await env.DB.prepare("SELECT * FROM model_revisions WHERE model_id = ?").bind(id).first();
    expect(rev).not.toBeNull();
    expect((rev as { actor_id: string }).actor_id).toBe("system");
  });

  it("rolls back the revision row when the data batch fails", async () => {
    await expect(transaction(env.DB, async (tx) => {
      await tx.create(TxAudited, { id: crypto.randomUUID(), v: 1 });
      await tx.create(TxAudited, { id: null as never, v: 2 }); // PK NULL → batch fails
    })).rejects.toThrow();
    const n = await env.DB.prepare("SELECT COUNT(*) c FROM model_revisions").first<{ c: number }>();
    expect(n!.c).toBe(0); // no orphan audit row
    expect(await TxAudited.query().count(env.DB)).toBe(0); // data rolled back too
  });

  it("skipRevisions writes data only", async () => {
    const id = crypto.randomUUID();
    await transaction(env.DB, async (tx) => { await tx.create(TxAudited, { id, v: 1 }); }, { skipRevisions: true });
    const n = await env.DB.prepare("SELECT COUNT(*) c FROM model_revisions").first<{ c: number }>();
    expect(n!.c).toBe(0);
    expect(await TxAudited.query().count(env.DB)).toBe(1); // data row still written
  });
});

describe("transaction() — per-op results + before-hook abort", () => {
  it("a before-hook returning false aborts the whole tx", async () => {
    await expect(transaction(env.DB, async (tx) => {
      await tx.create(TxUser, { id: crypto.randomUUID(), name: "ok" });
      await tx.create(TxGuarded, { id: crypto.randomUUID(), name: "guarded" }); // creating → false
    })).rejects.toBeInstanceOf(TransactionAborted);
    expect(await TxUser.query().count(env.DB)).toBe(0); // earlier op discarded too
  });

  it("exposes ordered per-statement results after the tx resolves", async () => {
    let captured!: Tx;
    await transaction(env.DB, async (tx) => {
      captured = tx;
      expect(tx.results).toEqual([]); // nothing has executed mid-closure
      await tx.create(TxUser, { id: crypto.randomUUID(), name: "a" });
      await tx.create(TxUser, { id: crypto.randomUUID(), name: "b" });
    });
    expect(captured.results).toHaveLength(2); // one D1Result per collected statement, in order
    expect(captured.results[0]?.meta.changes).toBe(1);
    expect(captured.results[1]?.meta.changes).toBe(1);
  });

  it("maps each instance op's data-statement result onto its model via recordMeta", async () => {
    const seen: Array<{ changes?: number }> = [];
    class TxMetaUser extends BaseModel<UserAttrs> {
      static table = "tx_users"; static timestamps = false;
      recordMeta(meta: { changes?: number }): void { seen.push(meta); }
    }
    await TxUser.create(env.DB, { id: "u1", name: "A" });
    await TxUser.create(env.DB, { id: "u2", name: "B" });
    let captured!: Tx;
    await transaction(env.DB, async (tx) => {
      captured = tx;
      tx.update(TxUser.query(), { name: "Z" });                             // stmt 0 → changes 2
      await tx.create(TxAudited, { id: crypto.randomUUID(), v: 1 });        // stmt 1 (data) + stmt 2 (revision)
      await tx.create(TxMetaUser, { id: crypto.randomUUID(), name: "m" });  // stmt 3 → changes 1
    });
    expect(captured.results).toHaveLength(4);
    // The model received ITS OWN data-statement result (changes 1), not the
    // bulk update's (changes 2) — indices survive interleaved revision stmts.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.changes).toBe(1);
  });
});

describe("transaction() — fix_first regressions (#55)", () => {
  it("tx.delete() soft-deletes (sets deleted_at) instead of hard-DELETEing the row", async () => {
    await TxSoft.create(env.DB, { id: "s1", name: "keep" });
    await transaction(env.DB, async (tx) => {
      const m = await TxSoft.find(env.DB, "s1");
      await tx.delete(m!);
    });
    // The row must still exist — trashed, not destroyed.
    const raw = await env.DB.prepare("SELECT deleted_at FROM tx_soft WHERE id = ?").bind("s1").first<{ deleted_at: string | null }>();
    expect(raw).not.toBeNull();
    expect(raw!.deleted_at).not.toBeNull();
    // Default scope hides it; withTrashed() still finds it.
    expect(await TxSoft.find(env.DB, "s1")).toBeNull();
    expect(await TxSoft.query().withTrashed().whereEq("id", "s1").first(env.DB)).not.toBeNull();
  });

  it("records a populated diff_json for writes inside a transaction (not empty {})", async () => {
    await transaction(env.DB, async (tx) => {
      await tx.create(TxDiff, { id: "d1", name: "Alice" });
    });
    const rev = await env.DB.prepare("SELECT diff_json FROM model_revisions WHERE model_id = ?").bind("d1").first<{ diff_json: string }>();
    expect(rev).not.toBeNull();
    expect(JSON.parse(rev!.diff_json)).toMatchObject({ name: "Alice" });
  });

  it("fires the creating hook BEFORE the auto primary key is applied", async () => {
    creatingSawId.length = 0;
    const u = await transaction(env.DB, async (tx) => tx.create(TxHookOrder, { name: "Bob" }));
    expect(creatingSawId).toEqual([undefined]); // hook saw no id yet
    expect(u.get("id")).toBeTruthy(); // model received an auto id afterwards
  });

  it("sets wasRecentlyCreated on tx.create / tx.save(insert) / tx.upsert, false on update", async () => {
    const [created, savedInsert, upserted] = await transaction(env.DB, async (tx) => {
      const a = await tx.create(TxUser, { id: "w1", name: "A" });
      const b = new TxUser({ id: "w2", name: "B" });
      await tx.save(b);
      const c = await tx.upsert(TxUser, { id: "w3", name: "C" }, ["id"]);
      return [a, b, c];
    });
    expect(created.wasRecentlyCreated).toBe(true);
    expect(savedInsert.wasRecentlyCreated).toBe(true);
    expect(upserted.wasRecentlyCreated).toBe(true);

    const loaded = await TxUser.find(env.DB, "w1");
    expect(loaded!.wasRecentlyCreated).toBe(false); // freshly loaded
    await transaction(env.DB, async (tx) => { loaded!.set("name", "A2"); await tx.save(loaded!); });
    expect(loaded!.wasRecentlyCreated).toBe(false); // an update never flips it
  });
});

describe("Model.transaction — closure overload + raw-statement array", () => {
  it("Model.transaction(db, fn) runs the closure form", async () => {
    const u = await TxUser.transaction(env.DB, async (tx) => tx.create(TxUser, { id: crypto.randomUUID(), name: "z" }));
    expect(u.get("name")).toBe("z");
  });

  it("Model.transaction(db, stmts[]) still batches raw statements", async () => {
    const s = TxUser.query().toInsertPrepared(env.DB, { id: crypto.randomUUID(), name: "raw" });
    const res = await TxUser.transaction(env.DB, [s]);
    expect(Array.isArray(res)).toBe(true);
    expect(await TxUser.query().count(env.DB)).toBe(1);
  });
});

describe("transaction() - revision + hook parity with the non-tx path", () => {
  it("tx.upsert() writes an audit revision for a revisions-enabled model (was: none)", async () => {
    await transaction(env.DB, async (tx) => {
      await tx.upsert(TxAudited, { id: "a1", v: 1 }, ["id"]);
    });
    const revs = await env.DB.prepare(
      "SELECT action FROM model_revisions WHERE model_table = 'tx_aud' AND model_id = 'a1'",
    ).all();
    expect(revs.results.length).toBe(1);
    expect((revs.results[0] as { action: string }).action).toBe("create");
  });

  it("update/delete after-hooks fire only when a row actually changed", async () => {
    gatedHookCalls.length = 0;
    // Positive control: an update that matches a live row fires `updated`.
    await env.DB.prepare("INSERT INTO tx_users (id, name) VALUES ('u1', 'A')").run();
    const live = await TxGatedHooks.find(env.DB, "u1");
    await transaction(env.DB, async (tx) => {
      live!.set("name", "B");
      await tx.save(live!);
    });
    expect(gatedHookCalls).toEqual(["updated"]);

    // Now the row is deleted out-of-band, so a tx update/delete matches 0 rows:
    // neither `updated` nor `deleted` may fire (matches persistenceManager's changed>0 gate).
    gatedHookCalls.length = 0;
    const stale = await TxGatedHooks.find(env.DB, "u1");
    await env.DB.prepare("DELETE FROM tx_users WHERE id = 'u1'").run();
    await transaction(env.DB, async (tx) => {
      stale!.set("name", "C");
      await tx.save(stale!); // 0-row UPDATE
      await tx.delete(stale!); // 0-row DELETE
    });
    expect(gatedHookCalls).toEqual([]);
  });
});
