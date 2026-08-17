// increment.integration.test.ts
// Live D1 tests for QueryBuilder + instance increment()/decrement().

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BaseModel } from "../baseModel";
import { registerConnection } from "../registry";

interface CounterAttrs {
    id?: string;
    name?: string;
    views?: number;
    stock?: number;
    created_at?: string | Date;
    updated_at?: string | Date;
}

class Counter extends BaseModel<CounterAttrs> {
    static table = "inc_counters";
    static timestamps = true;
}

/** timestamps=false variant — exercises the no-updated_at branch of stepColumn. */
class CounterNoTs extends BaseModel<CounterAttrs> {
    static table = "inc_counters";
    static timestamps = false;
}

/** A model with a datetime-cast column — exercises `extra` cast dehydration. */
interface CastCounterAttrs { id?: string; views?: number; last_at?: Date | string | null }
class CounterCast extends BaseModel<CastCounterAttrs> {
    static table = "inc_counters";
    static timestamps = false;
    static casts = { last_at: "datetime" } as const;
}

beforeAll(async () => {
    await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS inc_counters (
            id TEXT PRIMARY KEY,
            name TEXT,
            views INTEGER DEFAULT 0,
            stock INTEGER DEFAULT 0,
            created_at TEXT,
            updated_at TEXT,
            last_at TEXT
        )`,
    ).run();
});

beforeEach(async () => {
    await env.DB.prepare("DELETE FROM inc_counters").run();
});

async function seed(id: string, views = 0, stock = 0): Promise<void> {
    await Counter.create(env.DB, { id, name: "n-" + id, views, stock });
}

describe("QueryBuilder.increment() / decrement()", () => {
    it("increments by 1 (default amount) scoped by where", async () => {
        await seed("a", 10);
        const n = await Counter.query().whereEq("id", "a").increment(env.DB, "views");
        expect(n).toBe(1);
        const row = await Counter.find(env.DB, "a");
        expect(row!.get("views")).toBe(11);
    });

    it("increments by an explicit amount", async () => {
        await seed("a", 10);
        await Counter.query().whereEq("id", "a").increment(env.DB, "views", 5);
        expect((await Counter.find(env.DB, "a"))!.get("views")).toBe(15);
    });

    it("sets extra columns in the same UPDATE", async () => {
        await seed("a", 10);
        await Counter.query().whereEq("id", "a").increment(env.DB, "views", 2, { name: "touched" });
        const row = await Counter.find(env.DB, "a");
        expect(row!.get("views")).toBe(12);
        expect(row!.get("name")).toBe("touched");
    });

    it("decrements a column", async () => {
        await seed("a", 0, 20);
        await Counter.query().whereEq("id", "a").decrement(env.DB, "stock", 3);
        expect((await Counter.find(env.DB, "a"))!.get("stock")).toBe(17);
    });

    it("applies to every matching row when unscoped", async () => {
        await seed("a", 1);
        await seed("b", 1);
        const n = await Counter.query().increment(env.DB, "views", 10);
        expect(n).toBe(2);
        expect((await Counter.find(env.DB, "a"))!.get("views")).toBe(11);
        expect((await Counter.find(env.DB, "b"))!.get("views")).toBe(11);
    });
});

describe("instance increment() / decrement()", () => {
    it("persists and syncs the in-memory attribute, touching updated_at", async () => {
        await seed("a", 10);
        const c = await Counter.find(env.DB, "a");
        const before = c!.get("updated_at");
        await new Promise((r) => setTimeout(r, 3));
        await c!.increment(env.DB, "views", 5);

        expect(c!.get("views")).toBe(15); // in-memory synced
        expect(c!.isDirty("views")).toBe(false); // reconciled, not dirty
        expect(c!.get("updated_at")).not.toBe(before); // timestamp touched

        const fresh = await Counter.find(env.DB, "a");
        expect(fresh!.get("views")).toBe(15); // persisted
    });

    it("decrements an instance column", async () => {
        await seed("a", 0, 20);
        const c = await Counter.find(env.DB, "a");
        await c!.decrement(env.DB, "stock", 8);
        expect(c!.get("stock")).toBe(12);
        expect((await Counter.find(env.DB, "a"))!.get("stock")).toBe(12);
    });

    it("sets extra columns and syncs them in-memory", async () => {
        await seed("a", 1);
        const c = await Counter.find(env.DB, "a");
        await c!.increment(env.DB, "views", 1, { name: "bumped" });
        expect(c!.get("name")).toBe("bumped");
        expect(c!.isDirty("name")).toBe(false);
    });

    it("does not disturb an unrelated dirty field", async () => {
        await seed("a", 1);
        const c = await Counter.find(env.DB, "a");
        c!.set("name", "pending-unsaved");
        expect(c!.isDirty("name")).toBe(true);

        await c!.increment(env.DB, "views", 1);

        expect(c!.get("views")).toBe(2);
        expect(c!.isDirty("views")).toBe(false);
        expect(c!.isDirty("name")).toBe(true); // still pending — increment must not clean it
    });
});

describe("increment/decrement — auto-resolve db + shorthand branches", () => {
    // Register env.DB as the default connection so the no-db-first overloads resolve.
    beforeAll(() => registerConnection("default", env.DB));

    it("QueryBuilder auto-resolves the db when none is passed", async () => {
        await seed("a", 10);
        const n = await Counter.query().whereEq("id", "a").increment("views", 5);
        expect(n).toBe(1);
        expect((await Counter.find(env.DB, "a"))!.get("views")).toBe(15);
    });

    it("QueryBuilder treats an object in the amount slot as `extra` (shorthand)", async () => {
        await seed("a", 10);
        // increment(column, { extra }) — no amount, object shorthand → +1 and set name.
        await Counter.query().whereEq("id", "a").increment("views", { name: "shorthand" });
        const row = await Counter.find(env.DB, "a");
        expect(row!.get("views")).toBe(11);
        expect(row!.get("name")).toBe("shorthand");
    });

    it("instance auto-resolves the db when none is passed", async () => {
        await seed("a", 10);
        const c = await Counter.find(env.DB, "a");
        await c!.increment("views", 5); // no db arg → registry default
        expect(c!.get("views")).toBe(15);
        expect((await Counter.find(env.DB, "a"))!.get("views")).toBe(15);
    });

    it("instance decrement auto-resolves the db", async () => {
        await seed("a", 0, 20);
        const c = await Counter.find(env.DB, "a");
        await c!.decrement("stock", 8); // no db arg
        expect(c!.get("stock")).toBe(12);
    });

    it("instance treats an object in the amount slot as `extra` (shorthand)", async () => {
        await seed("a", 1);
        const c = await Counter.find(env.DB, "a");
        await c!.increment("views", { name: "bumped" }); // object shorthand, no db
        expect(c!.get("views")).toBe(2);
        expect(c!.get("name")).toBe("bumped");
    });

    it("instance with timestamps=false does not touch updated_at", async () => {
        await seed("a", 5);
        const c = await CounterNoTs.find(env.DB, "a");
        const before = c!.get("updated_at");
        await c!.increment(env.DB, "views", 1);
        expect(c!.get("views")).toBe(6);
        expect(c!.get("updated_at")).toBe(before); // untouched — no timestamps
    });
});

describe("increment() fix_first regressions (#43)", () => {
    it("dehydrates `extra` values through casts (mass path) — a Date does not throw", async () => {
        await seed("c", 5);
        const when = new Date("2021-06-01T00:00:00.000Z");
        await CounterCast.query().whereEq("id", "c").increment(env.DB, "views", 2, { last_at: when });
        const raw = await env.DB.prepare("SELECT views, last_at FROM inc_counters WHERE id = ?").bind("c").first<{ views: number; last_at: unknown }>();
        expect(raw!.views).toBe(7);
        expect(typeof raw!.last_at).toBe("string"); // bound as ISO string, not a Date object
        const reread = await CounterCast.find(env.DB, "c");
        expect((reread!.get("last_at") as Date).toISOString()).toBe(when.toISOString());
    });

    it("dehydrates `extra` on the instance path too", async () => {
        await seed("c2", 0);
        const m = await CounterCast.find(env.DB, "c2");
        const when = new Date("2022-02-02T00:00:00.000Z");
        await m!.increment("views", 1, { last_at: when }); // object-in-amount-slot + cast dehydration
        const raw = await env.DB.prepare("SELECT last_at FROM inc_counters WHERE id = ?").bind("c2").first<{ last_at: unknown }>();
        expect(typeof raw!.last_at).toBe("string");
    });

    it("treats a NULL counter as 0 (COALESCE) — DB and memory agree", async () => {
        await env.DB.prepare("INSERT INTO inc_counters (id, name, views) VALUES (?,?,NULL)").bind("n1", "n").run();
        const m = await CounterNoTs.find(env.DB, "n1");
        await m!.increment("views", 5);
        expect(m!.get("views")).toBe(5); // in-memory (null → 0, +5)
        const raw = await env.DB.prepare("SELECT views FROM inc_counters WHERE id = ?").bind("n1").first<{ views: number }>();
        expect(raw!.views).toBe(5); // DB (COALESCE(NULL,0)+5)
    });

    it("computes the in-memory delta from the PERSISTED value, not an unsaved dirty change", async () => {
        await seed("d1", 10);
        const m = await CounterNoTs.find(env.DB, "d1");
        m!.set("views", 999); // dirty, never saved
        await m!.increment("views", 1);
        expect(m!.get("views")).toBe(11); // 10 (persisted) + 1 — not 999 + 1
        const raw = await env.DB.prepare("SELECT views FROM inc_counters WHERE id = ?").bind("d1").first<{ views: number }>();
        expect(raw!.views).toBe(11);
    });
});
