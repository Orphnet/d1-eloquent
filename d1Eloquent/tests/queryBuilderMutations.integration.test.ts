// queryBuilderMutations.integration.test.ts
// Integration tests covering QueryBuilder mutation/scalar/iteration methods

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { QueryBuilder } from "../queryBuilder";
import { BaseModel } from "../baseModel";

interface RowAttrs {
    id?: string;
    name?: string;
    score?: number;
    deleted_at?: string | null;
}

class Row {
    static table = "qbm_rows";
    static primaryKey = "id";
    static softDeletes = false;
    attrs: RowAttrs;
    constructor(attrs: RowAttrs = {}) { this.attrs = attrs; }
    toObject() { return this.attrs as Record<string, unknown>; }
}

class SoftRow extends BaseModel<RowAttrs> {
    static table = "qbm_soft_rows";
    static primaryKey = "id";
    static softDeletes = true;
    static timestamps = false;
}

beforeAll(async () => {
    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS qbm_rows (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            score INTEGER NOT NULL DEFAULT 0
        )
    `).run();
    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS qbm_soft_rows (
            id TEXT PRIMARY KEY,
            name TEXT,
            score INTEGER NOT NULL DEFAULT 0,
            deleted_at TEXT
        )
    `).run();
});

afterAll(async () => {
    await env.DB.prepare("DROP TABLE IF EXISTS qbm_rows").run();
    await env.DB.prepare("DROP TABLE IF EXISTS qbm_soft_rows").run();
});

beforeEach(async () => {
    await env.DB.prepare("DELETE FROM qbm_rows").run();
    await env.DB.prepare("DELETE FROM qbm_soft_rows").run();
});

// ── insert / insertOrIgnore ──────────────────────────────────────────

describe("insert", () => {
    it("inserts a row", async () => {
        await new QueryBuilder(Row).insert(env.DB, { id: "r1", name: "A", score: 1 });
        const row = await env.DB.prepare("SELECT * FROM qbm_rows WHERE id = ?").bind("r1").first();
        expect(row!.name).toBe("A");
    });
});

describe("insertOrIgnore", () => {
    it("inserts when no conflict", async () => {
        await new QueryBuilder(Row).insertOrIgnore(env.DB, { id: "i1", name: "B", score: 2 });
        const row = await env.DB.prepare("SELECT * FROM qbm_rows WHERE id = ?").bind("i1").first();
        expect(row!.name).toBe("B");
    });

    it("silently ignores on conflict", async () => {
        await env.DB.prepare("INSERT INTO qbm_rows (id, name, score) VALUES (?, ?, ?)").bind("i2", "Orig", 10).run();
        await new QueryBuilder(Row).insertOrIgnore(env.DB, { id: "i2", name: "New", score: 99 });
        const row = await env.DB.prepare("SELECT * FROM qbm_rows WHERE id = ?").bind("i2").first();
        expect(row!.name).toBe("Orig");
    });
});

// ── update / delete ──────────────────────────────────────────────────

describe("update", () => {
    it("returns number of changed rows", async () => {
        await env.DB.prepare("INSERT INTO qbm_rows (id, name, score) VALUES (?, ?, ?)").bind("u1", "A", 1).run();
        await env.DB.prepare("INSERT INTO qbm_rows (id, name, score) VALUES (?, ?, ?)").bind("u2", "B", 2).run();

        const changed = await new QueryBuilder(Row)
            .where("score", "<", 10)
            .update(env.DB, { name: "Updated" });
        expect(changed).toBe(2);
    });

    it("returns 0 for empty updates", async () => {
        const changed = await new QueryBuilder(Row).update(env.DB, {});
        expect(changed).toBe(0);
    });

    it("update without WHERE updates all rows", async () => {
        await env.DB.prepare("INSERT INTO qbm_rows (id, name, score) VALUES (?, ?, ?)").bind("w1", "A", 1).run();
        const changed = await new QueryBuilder(Row).update(env.DB, { name: "All" });
        expect(changed).toBe(1);
    });
});

describe("delete (QB)", () => {
    it("returns number of deleted rows", async () => {
        await env.DB.prepare("INSERT INTO qbm_rows (id, name, score) VALUES (?, ?, ?)").bind("d1", "A", 1).run();
        await env.DB.prepare("INSERT INTO qbm_rows (id, name, score) VALUES (?, ?, ?)").bind("d2", "B", 2).run();

        const deleted = await new QueryBuilder(Row).whereEq("id", "d1").delete(env.DB);
        expect(deleted).toBe(1);
    });

    it("delete without WHERE deletes all rows", async () => {
        await env.DB.prepare("INSERT INTO qbm_rows (id, name, score) VALUES (?, ?, ?)").bind("da", "X", 1).run();
        await env.DB.prepare("INSERT INTO qbm_rows (id, name, score) VALUES (?, ?, ?)").bind("db", "Y", 2).run();
        const deleted = await new QueryBuilder(Row).delete(env.DB);
        expect(deleted).toBe(2);
    });
});

// ── Scalar: pluck / value ────────────────────────────────────────────

describe("pluck", () => {
    it("returns flat array of a single column", async () => {
        await env.DB.prepare("INSERT INTO qbm_rows (id, name, score) VALUES (?, ?, ?)").bind("p1", "Alice", 10).run();
        await env.DB.prepare("INSERT INTO qbm_rows (id, name, score) VALUES (?, ?, ?)").bind("p2", "Bob", 20).run();

        const names = await new QueryBuilder(Row).orderBy("name").pluck(env.DB, "name");
        expect(names).toEqual(["Alice", "Bob"]);
    });
});

describe("value", () => {
    it("returns a single scalar from first row", async () => {
        await env.DB.prepare("INSERT INTO qbm_rows (id, name, score) VALUES (?, ?, ?)").bind("v1", "Eve", 42).run();

        const score = await new QueryBuilder(Row).whereEq("id", "v1").value(env.DB, "score");
        expect(score).toBe(42);
    });

    it("returns null when no rows match", async () => {
        const val = await new QueryBuilder(Row).whereEq("id", "nonexistent").value(env.DB, "name");
        expect(val).toBeNull();
    });
});

// ── Aggregates ───────────────────────────────────────────────────────

describe("aggregates (D1)", () => {
    beforeEach(async () => {
        await env.DB.prepare("INSERT INTO qbm_rows (id, name, score) VALUES (?, ?, ?)").bind("a1", "A", 10).run();
        await env.DB.prepare("INSERT INTO qbm_rows (id, name, score) VALUES (?, ?, ?)").bind("a2", "B", 20).run();
        await env.DB.prepare("INSERT INTO qbm_rows (id, name, score) VALUES (?, ?, ?)").bind("a3", "C", 30).run();
    });

    it("sum returns total", async () => {
        const total = await new QueryBuilder(Row).sum(env.DB, "score");
        expect(total).toBe(60);
    });

    it("avg returns average", async () => {
        const avg = await new QueryBuilder(Row).avg(env.DB, "score");
        expect(avg).toBe(20);
    });

    it("min returns minimum", async () => {
        const min = await new QueryBuilder(Row).min(env.DB, "score");
        expect(min).toBe(10);
    });

    it("max returns maximum", async () => {
        const max = await new QueryBuilder(Row).max(env.DB, "score");
        expect(max).toBe(30);
    });

    it("count returns row count", async () => {
        const c = await new QueryBuilder(Row).count(env.DB);
        expect(c).toBe(3);
    });
});

// ── chunk ────────────────────────────────────────────────────────────

describe("chunk", () => {
    beforeEach(async () => {
        for (let i = 0; i < 5; i++) {
            await env.DB.prepare("INSERT INTO qbm_rows (id, name, score) VALUES (?, ?, ?)")
                .bind(`ch${i}`, `N${i}`, i)
                .run();
        }
    });

    it("iterates in chunks of given size", async () => {
        const chunks: number[] = [];
        await new QueryBuilder(Row).orderBy("id").chunk(env.DB, 2, async (models) => {
            chunks.push(models.length);
        });
        expect(chunks).toEqual([2, 2, 1]);
    });

    it("stops early when callback returns false", async () => {
        let calls = 0;
        await new QueryBuilder(Row).orderBy("id").chunk(env.DB, 2, async () => {
            calls++;
            return false;
        });
        expect(calls).toBe(1);
    });

    it("handles empty result set without calling callback", async () => {
        await env.DB.prepare("DELETE FROM qbm_rows").run();
        let calls = 0;
        await new QueryBuilder(Row).chunk(env.DB, 2, async () => {
            calls++;
        });
        expect(calls).toBe(0);
    });
});

// ── Prepared statements ──────────────────────────────────────────────

describe("prepared statements", () => {
    it("toInsertPrepared creates an executable prepared statement", async () => {
        const stmt = new QueryBuilder(Row).toInsertPrepared(env.DB, { id: "tp1", name: "Prep", score: 5 });
        await stmt.run();
        const row = await env.DB.prepare("SELECT * FROM qbm_rows WHERE id = ?").bind("tp1").first();
        expect(row!.name).toBe("Prep");
    });

    it("toInsertOrIgnorePrepared skips on conflict", async () => {
        await env.DB.prepare("INSERT INTO qbm_rows (id, name, score) VALUES (?, ?, ?)").bind("tp2", "Orig", 1).run();
        const stmt = new QueryBuilder(Row).toInsertOrIgnorePrepared(env.DB, { id: "tp2", name: "New", score: 99 });
        await stmt.run();
        const row = await env.DB.prepare("SELECT * FROM qbm_rows WHERE id = ?").bind("tp2").first();
        expect(row!.name).toBe("Orig");
    });

    it("toUpsertPrepared creates upsert statement", async () => {
        await env.DB.prepare("INSERT INTO qbm_rows (id, name, score) VALUES (?, ?, ?)").bind("tp3", "Old", 1).run();
        const stmt = new QueryBuilder(Row).toUpsertPrepared(env.DB, { id: "tp3", name: "Upserted", score: 77 }, ["id"]);
        await stmt.run();
        const row = await env.DB.prepare("SELECT * FROM qbm_rows WHERE id = ?").bind("tp3").first();
        expect(row!.name).toBe("Upserted");
    });

    it("toUpsertPrepared with empty updateCols produces DO NOTHING", async () => {
        await env.DB.prepare("INSERT INTO qbm_rows (id, name, score) VALUES (?, ?, ?)").bind("tp4", "Keep", 1).run();
        const stmt = new QueryBuilder(Row).toUpsertPrepared(env.DB, { id: "tp4", name: "Skip", score: 0 }, ["id"], []);
        await stmt.run();
        const row = await env.DB.prepare("SELECT * FROM qbm_rows WHERE id = ?").bind("tp4").first();
        expect(row!.name).toBe("Keep");
    });

    it("toUpdatePrepared creates update statement with WHERE", async () => {
        await env.DB.prepare("INSERT INTO qbm_rows (id, name, score) VALUES (?, ?, ?)").bind("tp5", "Before", 1).run();
        const stmt = new QueryBuilder(Row).whereEq("id", "tp5").toUpdatePrepared(env.DB, { name: "After" });
        await stmt.run();
        const row = await env.DB.prepare("SELECT * FROM qbm_rows WHERE id = ?").bind("tp5").first();
        expect(row!.name).toBe("After");
    });

    it("toDeletePrepared creates delete statement with WHERE", async () => {
        await env.DB.prepare("INSERT INTO qbm_rows (id, name, score) VALUES (?, ?, ?)").bind("tp6", "Gone", 1).run();
        const stmt = new QueryBuilder(Row).whereEq("id", "tp6").toDeletePrepared(env.DB);
        await stmt.run();
        const row = await env.DB.prepare("SELECT * FROM qbm_rows WHERE id = ?").bind("tp6").first();
        expect(row).toBeNull();
    });
});

// ── onlyTrashed ──────────────────────────────────────────────────────

describe("onlyTrashed (D1)", () => {
    it("returns only soft-deleted rows", async () => {
        const active = await SoftRow.create(env.DB, { id: "ot1", name: "Active", score: 1 });
        const deleted = await SoftRow.create(env.DB, { id: "ot2", name: "Deleted", score: 2 });
        await deleted.delete(env.DB);

        const trashed = await SoftRow.query().onlyTrashed().get(env.DB);
        expect(trashed.length).toBe(1);
        expect(trashed[0].get("name")).toBe("Deleted");
    });
});

// ── paginate ─────────────────────────────────────────────────────────

describe("paginate (D1)", () => {
    beforeEach(async () => {
        for (let i = 1; i <= 7; i++) {
            await env.DB.prepare("INSERT INTO qbm_rows (id, name, score) VALUES (?, ?, ?)")
                .bind(`pg${i}`, `Item${i}`, i)
                .run();
        }
    });

    it("returns paginated data with correct metadata", async () => {
        const result = await new QueryBuilder(Row).orderBy("id").paginate(env.DB, 1, 3);
        expect(result.data.length).toBe(3);
        expect(result.total).toBe(7);
        expect(result.page).toBe(1);
        expect(result.perPage).toBe(3);
        expect(result.lastPage).toBe(3);
    });

    it("returns last page correctly", async () => {
        const result = await new QueryBuilder(Row).orderBy("id").paginate(env.DB, 3, 3);
        expect(result.data.length).toBe(1);
        expect(result.page).toBe(3);
    });
});
