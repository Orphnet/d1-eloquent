// multiDb.test.ts
// Unit tests for per-query connection routing via qb.on(name). Uses fake D1
// bindings so we can assert which connection a query was prepared against
// without spinning up multiple workerd databases.

import { describe, it, expect, beforeEach } from "vitest";
import { BaseModel } from "../baseModel";
import { configure } from "../config";
import { clearConnections } from "../registry";

interface UserAttrs {
    id: string;
    name: string;
}

class User extends BaseModel<UserAttrs> {
    static table = "users";
    static primaryKey = "id";
    static timestamps = false;
}

// Helper: a fake D1Database that records every prepare() call so tests can
// assert WHICH binding executed a given query.
function fakeDb(tag: string) {
    const calls: Array<{ sql: string; bindings: unknown[] }> = [];
    const stmt = (sql: string) => ({
        bind: (...bindings: unknown[]) => ({
            ...stmt(sql),
            all: async <T = unknown>() => {
                calls.push({ sql, bindings });
                return { results: [] as T[], success: true, meta: {} };
            },
            first: async <T = unknown>() => {
                calls.push({ sql, bindings });
                return null as T | null;
            },
            run: async () => {
                calls.push({ sql, bindings });
                return { success: true, meta: { changes: 0 } };
            },
        }),
        all: async <T = unknown>() => {
            calls.push({ sql, bindings: [] });
            return { results: [] as T[], success: true, meta: {} };
        },
    });
    return {
        db: {
            _tag: tag,
            prepare: (sql: string) => stmt(sql),
        } as unknown as D1Database,
        calls,
    };
}

describe("QueryBuilder.on(name) — per-query connection routing", () => {
    beforeEach(() => clearConnections());

    it("routes to the named connection from the registry", async () => {
        const primary = fakeDb("primary");
        const analytics = fakeDb("analytics");
        configure({ DB: primary.db }, { connections: { analytics: analytics.db } });

        await User.query().on("analytics").get();

        expect(analytics.calls.length).toBe(1);
        expect(primary.calls.length).toBe(0);
        expect(analytics.calls[0].sql).toContain("FROM users");
    });

    it("falls back to default when on() is not called", async () => {
        const primary = fakeDb("primary");
        const analytics = fakeDb("analytics");
        configure({ DB: primary.db }, { connections: { analytics: analytics.db } });

        await User.query().get();

        expect(primary.calls.length).toBe(1);
        expect(analytics.calls.length).toBe(0);
    });

    it("explicit db argument takes priority over on()", async () => {
        const primary = fakeDb("primary");
        const analytics = fakeDb("analytics");
        const oneOff = fakeDb("oneoff");
        configure({ DB: primary.db }, { connections: { analytics: analytics.db } });

        await User.query().on("analytics").get(oneOff.db);

        expect(oneOff.calls.length).toBe(1);
        expect(analytics.calls.length).toBe(0);
    });

    it("throws when the connection name is unknown", async () => {
        const primary = fakeDb("primary");
        configure({ DB: primary.db });

        await expect(User.query().on("missing").get()).rejects.toThrow(
            /Unknown connection: "missing"/,
        );
    });

    it("propagates through paginate's internal count query", async () => {
        const primary = fakeDb("primary");
        const analytics = fakeDb("analytics");
        configure({ DB: primary.db }, { connections: { analytics: analytics.db } });

        await User.query().on("analytics").paginate(1, 10);

        // Two queries: COUNT(*) and the data fetch — both must hit analytics.
        expect(analytics.calls.length).toBe(2);
        expect(primary.calls.length).toBe(0);
        expect(analytics.calls[0].sql).toMatch(/COUNT/);
    });
});
