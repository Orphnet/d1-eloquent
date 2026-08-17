// sessionsAndMeta.test.ts
// Unit tests for QueryBuilder's D1 Sessions support and result metadata
// exposure. Uses a fake D1Database so we can observe how the QB routes calls
// and capture meta — no real D1 needed.

import { describe, it, expect } from "vitest";
import { QueryBuilder } from "../queryBuilder";

interface UAttrs {
    id?: string;
    name?: string;
}

class U {
    static table = "u";
    static primaryKey = "id";
    static softDeletes = false;
    attrs: UAttrs;
    constructor(attrs: UAttrs = {}) {
        this.attrs = attrs;
    }
    toObject() {
        return this.attrs as Record<string, unknown>;
    }
}

// ---- Fake D1 with optional session support ----------------------------------

type Call = { source: "db" | "session"; sql: string; bindings: unknown[] };

function makeFakeD1(opts: {
    resultsForAll?: Record<string, unknown>[];
    metaForAll?: Record<string, unknown>;
    metaForRun?: Record<string, unknown>;
    bookmark?: string;
} = {}) {
    const calls: Call[] = [];
    let sessionCreated = false;
    let bookmark = opts.bookmark ?? "bm-initial";

    const buildStatement = (source: "db" | "session", sql: string) => {
        const bindings: unknown[] = [];
        const stmt: any = {
            bind: (...args: unknown[]) => {
                bindings.push(...args);
                return stmt;
            },
            all: async () => {
                calls.push({ source, sql, bindings: [...bindings] });
                if (source === "session") bookmark = `bm-${calls.length}`;
                return {
                    results: opts.resultsForAll ?? [{ id: "u1", name: "Alice" }],
                    meta: opts.metaForAll ?? {
                        duration: 7,
                        rows_read: 42,
                        rows_written: 0,
                    },
                    success: true,
                };
            },
            run: async () => {
                calls.push({ source, sql, bindings: [...bindings] });
                if (source === "session") bookmark = `bm-${calls.length}`;
                return {
                    meta: opts.metaForRun ?? {
                        duration: 3,
                        rows_read: 0,
                        rows_written: 1,
                        changes: 1,
                        last_row_id: 1,
                    },
                    success: true,
                };
            },
            first: async () => null,
        };
        return stmt;
    };

    const db: any = {
        prepare: (sql: string) => buildStatement("db", sql),
        withSession: (_constraint?: string) => {
            sessionCreated = true;
            return {
                prepare: (sql: string) => buildStatement("session", sql),
                getBookmark: () => bookmark,
            };
        },
    };

    return { db, calls, isSessionCreated: () => sessionCreated, getBookmark: () => bookmark };
}

// ---- Tests ------------------------------------------------------------------

describe("QueryBuilder.withSession() — read replica session", () => {
    it("creates a session lazily on first query and routes prepare through it", async () => {
        const fake = makeFakeD1();
        const qb = new QueryBuilder(U).withSession("first-unconstrained");

        // No session created until a query runs
        expect(fake.isSessionCreated()).toBe(false);

        await qb.get(fake.db);
        expect(fake.isSessionCreated()).toBe(true);
        expect(fake.calls.length).toBe(1);
        expect(fake.calls[0].source).toBe("session");
    });

    it("reuses the same session across multiple queries on the same QB", async () => {
        const fake = makeFakeD1();
        const qb = new QueryBuilder(U).withSession();
        await qb.get(fake.db);
        await qb.count(fake.db);
        expect(fake.calls.length).toBe(2);
        expect(fake.calls.every((c) => c.source === "session")).toBe(true);
    });

    it("getBookmark() returns the latest bookmark from the active session", async () => {
        const fake = makeFakeD1({ bookmark: "bm-start" });
        const qb = new QueryBuilder(U).withSession();
        expect(qb.getBookmark()).toBe(null);
        await qb.get(fake.db);
        expect(qb.getBookmark()).toBe("bm-1");
        await qb.get(fake.db);
        expect(qb.getBookmark()).toBe("bm-2");
    });

    it("transparently falls back to the bare db when withSession is unavailable", async () => {
        // No withSession method on the fake db
        const noSessionDb: any = {
            prepare: (sql: string) => {
                const bindings: unknown[] = [];
                const stmt: any = {
                    bind: (...a: unknown[]) => {
                        bindings.push(...a);
                        return stmt;
                    },
                    all: async () => ({ results: [], meta: {}, success: true }),
                    run: async () => ({ meta: {}, success: true }),
                };
                return stmt;
            },
        };
        const qb = new QueryBuilder(U).withSession();
        await qb.get(noSessionDb);
        // No throw, bookmark stays null
        expect(qb.getBookmark()).toBe(null);
    });

    it("queries without withSession() do NOT create a session", async () => {
        const fake = makeFakeD1();
        const qb = new QueryBuilder(U);
        await qb.get(fake.db);
        expect(fake.isSessionCreated()).toBe(false);
        expect(fake.calls[0].source).toBe("db");
    });
});

describe("QueryBuilder.lastMeta() / getWithMeta() — D1 result metadata", () => {
    it("lastMeta() is null before any query has run", () => {
        const qb = new QueryBuilder(U);
        expect(qb.lastMeta()).toBeNull();
    });

    it("captures D1 meta after get()", async () => {
        const fake = makeFakeD1({
            metaForAll: { rows_read: 17, rows_written: 0, duration: 5 },
        });
        const qb = new QueryBuilder(U);
        await qb.get(fake.db);
        const meta = qb.lastMeta();
        expect(meta).not.toBeNull();
        expect(meta?.rows_read).toBe(17);
        expect(meta?.duration).toBe(5);
    });

    it("getWithMeta() returns data + meta + bookmark envelope", async () => {
        const fake = makeFakeD1({
            metaForAll: { rows_read: 9, rows_written: 0 },
            bookmark: "bm-init",
        });
        const qb = new QueryBuilder(U).withSession();
        const { data, meta, bookmark } = await qb.getWithMeta(fake.db);
        expect(data.length).toBeGreaterThan(0);
        expect(meta.rows_read).toBe(9);
        expect(bookmark).toBe("bm-1");
    });

    it("firstWithMeta() returns the model alongside meta", async () => {
        const fake = makeFakeD1();
        const qb = new QueryBuilder(U);
        const { data, meta, bookmark } = await qb.firstWithMeta(fake.db);
        expect(data).not.toBeNull();
        expect(meta).toBeDefined();
        expect(bookmark).toBe(null);
    });

    it("captures meta for mutations (insert, update, delete)", async () => {
        const fake = makeFakeD1({
            metaForRun: { changes: 1, last_row_id: 42, duration: 4 },
        });
        const qb = new QueryBuilder(U);
        await qb.insert(fake.db, { id: "1", name: "Bob" });
        expect(qb.lastMeta()?.changes).toBe(1);
        expect(qb.lastMeta()?.last_row_id).toBe(42);
    });
});
