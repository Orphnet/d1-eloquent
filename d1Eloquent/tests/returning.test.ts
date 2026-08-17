// returning.test.ts
// Unit tests for the RETURNING-clause builders. Pure SQL inspection via a
// fake D1 — no real D1 needed.

import { describe, it, expect } from "vitest";
import { QueryBuilder } from "../queryBuilder";

class P {
    static table = "posts";
    static primaryKey = "id";
    static softDeletes = false;
    attrs: Record<string, unknown>;
    constructor(attrs: Record<string, unknown> = {}) {
        this.attrs = attrs;
    }
    toObject() {
        return this.attrs;
    }
}

function fakeDb(result: Record<string, unknown>[] = [{ id: "p1", created_at: "now" }]) {
    const calls: { sql: string; bindings: unknown[] }[] = [];
    const db: any = {
        prepare: (sql: string) => {
            const bindings: unknown[] = [];
            const stmt: any = {
                bind: (...a: unknown[]) => {
                    bindings.push(...a);
                    return stmt;
                },
                all: async () => {
                    calls.push({ sql, bindings: [...bindings] });
                    return { results: result, meta: { changes: result.length }, success: true };
                },
                run: async () => {
                    calls.push({ sql, bindings: [...bindings] });
                    return { meta: { changes: result.length }, success: true };
                },
            };
            return stmt;
        },
    };
    return { db, calls };
}

describe("QueryBuilder.insertReturning", () => {
    it("emits INSERT ... RETURNING * by default", async () => {
        const { db, calls } = fakeDb();
        const row = await new QueryBuilder(P).insertReturning(db, { id: "p1", title: "Hi" });
        expect(calls[0].sql).toBe(
            "INSERT INTO posts (id, title) VALUES (?, ?) RETURNING *",
        );
        expect(calls[0].bindings).toEqual(["p1", "Hi"]);
        expect(row).toEqual({ id: "p1", created_at: "now" });
    });

    it("emits explicit column list when provided", async () => {
        const { db, calls } = fakeDb();
        await new QueryBuilder(P).insertReturning(db, { id: "p1", title: "Hi" }, ["id", "created_at"]);
        expect(calls[0].sql).toBe(
            "INSERT INTO posts (id, title) VALUES (?, ?) RETURNING id, created_at",
        );
    });

    it("returns null when no row was produced", async () => {
        const { db } = fakeDb([]);
        const row = await new QueryBuilder(P).insertReturning(db, { id: "p1" });
        expect(row).toBeNull();
    });

    it("works with auto-resolved db (passes values only)", async () => {
        const { db, calls } = fakeDb();
        const qb = new QueryBuilder(P).setDefaultDb(db);
        await qb.insertReturning({ id: "p2", title: "Sans db" });
        expect(calls[0].sql).toContain("INSERT INTO posts");
    });
});

describe("QueryBuilder.updateReturning", () => {
    it("emits UPDATE ... WHERE ... RETURNING *", async () => {
        const { db, calls } = fakeDb([{ id: "p1", title: "new" }]);
        const rows = await new QueryBuilder(P)
            .whereEq("id", "p1")
            .updateReturning(db, { title: "new" });
        expect(calls[0].sql).toBe(
            "UPDATE posts SET title = ? WHERE id = ? RETURNING *",
        );
        expect(calls[0].bindings).toEqual(["new", "p1"]);
        expect(rows.length).toBe(1);
        expect(rows[0].title).toBe("new");
    });

    it("returns [] when no columns to update", async () => {
        const { db } = fakeDb();
        const rows = await new QueryBuilder(P).updateReturning(db, {});
        expect(rows).toEqual([]);
    });

    it("emits explicit RETURNING column list", async () => {
        const { db, calls } = fakeDb();
        await new QueryBuilder(P)
            .whereEq("id", "p1")
            .updateReturning(db, { views: 1 }, ["id", "views"]);
        expect(calls[0].sql.endsWith("RETURNING id, views")).toBe(true);
    });
});

describe("QueryBuilder.deleteReturning", () => {
    it("emits DELETE ... WHERE ... RETURNING *", async () => {
        const { db, calls } = fakeDb([{ id: "p1" }]);
        const rows = await new QueryBuilder(P).whereEq("id", "p1").deleteReturning(db);
        expect(calls[0].sql).toBe("DELETE FROM posts WHERE id = ? RETURNING *");
        expect(calls[0].bindings).toEqual(["p1"]);
        expect(rows.length).toBe(1);
    });

    it("emits explicit RETURNING column list", async () => {
        const { db, calls } = fakeDb([{ id: "p1" }]);
        await new QueryBuilder(P).whereEq("id", "p1").deleteReturning(db, ["id"]);
        expect(calls[0].sql.endsWith("RETURNING id")).toBe(true);
    });

    it("works with auto-resolved db (no args)", async () => {
        const { db, calls } = fakeDb();
        const qb = new QueryBuilder(P).setDefaultDb(db).whereEq("id", "p1");
        await qb.deleteReturning();
        expect(calls[0].sql).toContain("DELETE FROM posts");
    });
});
