// transactionProxySync.integration.test.ts
// Regression: flush() must sync internal bookkeeping on the RAW model, not
// through the attribute proxy. Passing a proxied model (from find()) to
// tx.save()/tx.delete() used to route `_persisted`, `_wasRecentlyCreated`,
// `original` and `lastChanges` writes through the proxy set trap into
// target.set(), polluting attrs with phantom dirty columns - a follow-up
// UPDATE then tried to SET nonexistent columns and threw.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BaseModel } from "../baseModel";
import { transaction } from "../transaction";

interface ProxyUserAttrs { id?: string; name?: string }
class TxProxyUser extends BaseModel<ProxyUserAttrs> {
  static table = "tx_proxy_users";
  static timestamps = false;
}

const INTERNAL_KEYS = ["_persisted", "_wasRecentlyCreated", "original", "lastChanges"];

beforeAll(async () => {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS tx_proxy_users (id TEXT PRIMARY KEY, name TEXT NOT NULL)`,
  ).run();
});
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM tx_proxy_users").run();
});

function rawOf(model: object): { attrs: Record<string, unknown>; dirty: Set<string> } {
  return (model as { $model: { attrs: Record<string, unknown>; dirty: Set<string> } }).$model;
}

describe("transaction() - flush syncs proxied models without attr pollution", () => {
  it("tx.save(proxied) leaves attrs clean and the model non-dirty", async () => {
    const id = crypto.randomUUID();
    await TxProxyUser.create(env.DB, { id, name: "before" });
    const found = await TxProxyUser.find(env.DB, id);
    expect(found).not.toBeNull();
    const user = found!;

    user.set("name", "after");
    await transaction(env.DB, async (tx) => {
      await tx.save(user);
    });

    const raw = rawOf(user);
    for (const key of INTERNAL_KEYS) {
      expect(Object.hasOwn(raw.attrs, key), `attrs polluted with '${key}'`).toBe(false);
    }
    expect([...raw.dirty]).toEqual([]);
    expect(user.get("name")).toBe("after");
  });

  it("a follow-up plain save() after tx.save(proxied) still works", async () => {
    const id = crypto.randomUUID();
    await TxProxyUser.create(env.DB, { id, name: "v1" });
    const found = await TxProxyUser.find(env.DB, id);
    const user = found!;

    user.set("name", "v2");
    await transaction(env.DB, async (tx) => {
      await tx.save(user);
    });

    // Pre-fix this threw: UPDATE ... SET lastChanges = ?, original = ?, _persisted = ?
    user.set("name", "v3");
    await user.save(env.DB);

    const row = await env.DB.prepare("SELECT name FROM tx_proxy_users WHERE id = ?").bind(id).first<{ name: string }>();
    expect(row?.name).toBe("v3");
  });

  it("tx.delete(proxied) on a hard-delete model stamps persistence on the raw model", async () => {
    const id = crypto.randomUUID();
    await TxProxyUser.create(env.DB, { id, name: "doomed" });
    const user = (await TxProxyUser.find(env.DB, id))!;

    await transaction(env.DB, async (tx) => {
      await tx.delete(user);
    });

    const raw = rawOf(user);
    for (const key of INTERNAL_KEYS) {
      expect(Object.hasOwn(raw.attrs, key), `attrs polluted with '${key}'`).toBe(false);
    }
    expect((user as unknown as { _persisted: boolean })._persisted).toBe(false);
    expect(await TxProxyUser.query().count(env.DB)).toBe(0);
  });
});
