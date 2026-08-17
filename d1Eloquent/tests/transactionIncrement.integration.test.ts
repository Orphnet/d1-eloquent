// transactionIncrement.integration.test.ts
// tx.increment / tx.decrement - atomic counter/balance adjustments alongside
// other writes in one db.batch(). Routes through the same hardened stepColumn
// as QueryBuilder.increment (COALESCE NULL-safety + cast-dehydrated extras).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BaseModel } from "../baseModel";
import { transaction } from "../transaction";

interface WalletAttrs { id?: string; balance?: number | null }
interface LedgerAttrs { id?: string; wallet_id?: string; amount?: number }
class TxiWallet extends BaseModel<WalletAttrs> { static table = "txi_wallet"; static timestamps = false; }
class TxiLedger extends BaseModel<LedgerAttrs> { static table = "txi_ledger"; static timestamps = false; }

beforeAll(async () => {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS txi_wallet (id TEXT PRIMARY KEY, balance INTEGER)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS txi_ledger (id TEXT PRIMARY KEY, wallet_id TEXT, amount INTEGER)`).run();
});
beforeEach(async () => {
    await env.DB.prepare("DELETE FROM txi_ledger").run();
    await env.DB.prepare("DELETE FROM txi_wallet").run();
    await TxiWallet.create(env.DB, { id: "w1", balance: 1000 });
});

describe("tx.increment / tx.decrement", () => {
    it("decrement + insert commit atomically (debit wallet + ledger row)", async () => {
        await transaction(env.DB, async (tx) => {
            tx.decrement(TxiWallet.query().whereEq("id", "w1"), "balance", 300);
            await tx.create(TxiLedger, { id: crypto.randomUUID(), wallet_id: "w1", amount: -300 });
        });
        expect((await TxiWallet.find(env.DB, "w1"))!.get("balance")).toBe(700);
        expect(await TxiLedger.query().count(env.DB)).toBe(1);
    });

    it("increment with extra columns in the same statement", async () => {
        await transaction(env.DB, async (tx) => {
            tx.increment(TxiWallet.query().whereEq("id", "w1"), "balance", 50, { id: "w1" });
        });
        expect((await TxiWallet.find(env.DB, "w1"))!.get("balance")).toBe(1050);
    });

    it("increment/decrement default to 1 when amount is omitted", async () => {
        await transaction(env.DB, async (tx) => {
            tx.increment(TxiWallet.query().whereEq("id", "w1"), "balance"); // +1
            tx.decrement(TxiWallet.query().whereEq("id", "w1"), "balance"); // -1
        });
        expect((await TxiWallet.find(env.DB, "w1"))!.get("balance")).toBe(1000); // net 0
    });

    it("treats a NULL counter as 0 (COALESCE hardening carried into the tx path)", async () => {
        await env.DB.prepare("UPDATE txi_wallet SET balance = NULL WHERE id = 'w1'").run();
        await transaction(env.DB, async (tx) => {
            tx.increment(TxiWallet.query().whereEq("id", "w1"), "balance", 5);
        });
        // NULL + 5 would be NULL without COALESCE; the hardened path yields 5.
        expect((await TxiWallet.find(env.DB, "w1"))!.get("balance")).toBe(5);
    });

    it("rolls back the decrement when a later statement fails", async () => {
        await TxiLedger.create(env.DB, { id: "L1", wallet_id: "w1", amount: 0 });
        await expect(
            transaction(env.DB, async (tx) => {
                tx.decrement(TxiWallet.query().whereEq("id", "w1"), "balance", 300);
                await tx.create(TxiLedger, { id: "L1", wallet_id: "w1", amount: -300 }); // dup PK → batch fails
            }),
        ).rejects.toThrow();
        expect((await TxiWallet.find(env.DB, "w1"))!.get("balance")).toBe(1000); // decrement rolled back
    });
});
