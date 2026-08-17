// datePartWheres.integration.test.ts
// Live D1 tests for whereDate / whereMonth / whereYear / whereDay / whereTime.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BaseModel } from "../baseModel";

interface EventAttrs { id?: string; at?: string }

class DpEvent extends BaseModel<EventAttrs> {
    static table = "dp_events";
    static timestamps = false;
}

// Same data, but the `at` column is stored via the built-in `timestamp` cast
// (integer unix-epoch seconds) rather than an ISO string.
class DpTsEvent extends BaseModel<{ id?: string; at?: Date | number }> {
    static table = "dp_ts_events";
    static timestamps = false;
    static casts = { at: "timestamp" as const };
}

beforeAll(async () => {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS dp_events (id TEXT PRIMARY KEY, at TEXT)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS dp_ts_events (id TEXT PRIMARY KEY, at INTEGER)`).run();
});

beforeEach(async () => {
    await env.DB.prepare("DELETE FROM dp_events").run();
    await DpEvent.create(env.DB, { id: "e1", at: "2026-01-15 09:30:00" });
    await DpEvent.create(env.DB, { id: "e2", at: "2026-01-20 14:00:00" });
    await DpEvent.create(env.DB, { id: "e3", at: "2025-03-05 09:30:00" });
});

const ids = (rows: DpEvent[]) => rows.map((r) => r.get("id")).sort();

describe("date-part where helpers", () => {
    it("whereDate (equality)", async () => {
        const rows = await DpEvent.query().whereDate("at", "2026-01-15").get(env.DB);
        expect(ids(rows)).toEqual(["e1"]);
    });

    it("whereDate (operator + Date value)", async () => {
        const rows = await DpEvent.query().whereDate("at", ">=", new Date("2026-01-16")).get(env.DB);
        expect(ids(rows)).toEqual(["e2"]);
    });

    it("whereMonth (numeric, zero-padded internally)", async () => {
        const rows = await DpEvent.query().whereMonth("at", 1).get(env.DB);
        expect(ids(rows)).toEqual(["e1", "e2"]);
    });

    it("whereMonth (string '01')", async () => {
        const rows = await DpEvent.query().whereMonth("at", "01").get(env.DB);
        expect(ids(rows)).toEqual(["e1", "e2"]);
    });

    it("whereYear", async () => {
        const rows = await DpEvent.query().whereYear("at", 2026).get(env.DB);
        expect(ids(rows)).toEqual(["e1", "e2"]);
    });

    it("whereDay", async () => {
        const rows = await DpEvent.query().whereDay("at", 15).get(env.DB);
        expect(ids(rows)).toEqual(["e1"]);
    });

    it("whereTime", async () => {
        const rows = await DpEvent.query().whereTime("at", "09:30:00").get(env.DB);
        expect(ids(rows)).toEqual(["e1", "e3"]);
    });

    it("whereTime (operator form)", async () => {
        const rows = await DpEvent.query().whereTime("at", ">=", "10:00:00").get(env.DB);
        expect(ids(rows)).toEqual(["e2"]); // only 14:00:00 is >= 10:00:00
    });

    it("whereTime (Date value → HH:MM:SS)", async () => {
        const rows = await DpEvent.query().whereTime("at", new Date("2026-01-20T14:00:00Z")).get(env.DB);
        expect(ids(rows)).toEqual(["e2"]);
    });
});

describe("date-part where helpers - timestamp-cast (unix-epoch) columns (regression)", () => {
    // Before the fix these all returned [] - SQLite read the integer epoch as a
    // Julian day. The helpers now emit `date(at, 'unixepoch')` etc. for timestamp-cast
    // columns, so they match the same way as ISO-string columns.
    beforeEach(async () => {
        await env.DB.prepare("DELETE FROM dp_ts_events").run();
        await DpTsEvent.create(env.DB, { id: "t1", at: new Date("2026-01-15T09:30:00Z") });
        await DpTsEvent.create(env.DB, { id: "t2", at: new Date("2026-01-20T14:00:00Z") });
        await DpTsEvent.create(env.DB, { id: "t3", at: new Date("2025-03-05T09:30:00Z") });
    });

    it("whereDate matches the right day", async () => {
        const rows = await DpTsEvent.query().whereDate("at", "2026-01-15").get(env.DB);
        expect(ids(rows)).toEqual(["t1"]);
    });
    it("whereYear matches", async () => {
        const rows = await DpTsEvent.query().whereYear("at", 2026).get(env.DB);
        expect(ids(rows)).toEqual(["t1", "t2"]);
    });
    it("whereMonth matches", async () => {
        const rows = await DpTsEvent.query().whereMonth("at", 3).get(env.DB);
        expect(ids(rows)).toEqual(["t3"]);
    });
    it("whereDay matches", async () => {
        const rows = await DpTsEvent.query().whereDay("at", 20).get(env.DB);
        expect(ids(rows)).toEqual(["t2"]);
    });
    it("whereTime (operator form) matches", async () => {
        const rows = await DpTsEvent.query().whereTime("at", ">=", "10:00:00").get(env.DB);
        expect(ids(rows)).toEqual(["t2"]);
    });
});
