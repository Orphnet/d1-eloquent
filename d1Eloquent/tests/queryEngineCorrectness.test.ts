// queryEngineCorrectness.test.ts
// Regression tests for query-engine correctness fixes:
//  - empty-array whereIn / whereNotIn no longer emit invalid `IN ()`
//  - the soft-delete scope no longer leaks past a top-level OR
//  - whereHas/whereDoesntHave callbacks with an inner OR stay correlated
//  - eager-load key batching (chunkKeys) stays under D1's bound-param cap

import { describe, it, expect } from "vitest";
import { QueryBuilder } from "../queryBuilder";
import { chunkKeys, EAGER_WHERE_IN_CHUNK } from "../relationResolver";

class Plain {
    static table = "plain";
    static primaryKey = "id";
    static softDeletes = false;
}

class SoftItem {
    static table = "items";
    static primaryKey = "id";
    static softDeletes = true;
}

describe("empty-array whereIn / whereNotIn", () => {
    it("whereIn([]) emits a constant-false predicate, never `IN ()`", () => {
        const { sql, bindings } = new QueryBuilder(Plain as any).whereIn("id", []).toSelectSql();
        expect(sql).toContain("WHERE 0 = 1");
        expect(sql).not.toContain("IN ()");
        expect(bindings).toEqual([]);
    });

    it("whereNotIn([]) emits a constant-true predicate (excludes nothing)", () => {
        const { sql, bindings } = new QueryBuilder(Plain as any).whereNotIn("id", []).toSelectSql();
        expect(sql).toContain("WHERE 1 = 1");
        expect(sql).not.toContain("NOT IN ()");
        expect(bindings).toEqual([]);
    });

    it("non-empty whereIn is unchanged", () => {
        const { sql, bindings } = new QueryBuilder(Plain as any).whereIn("id", ["a", "b"]).toSelectSql();
        expect(sql).toContain("id IN (?, ?)");
        expect(bindings).toEqual(["a", "b"]);
    });
});

describe("soft-delete scope vs top-level OR", () => {
    it("wraps user predicates in a group so the scope applies to all OR branches", () => {
        const { sql } = new QueryBuilder(SoftItem as any)
            .where("status", "=", "a")
            .orWhere("status", "=", "b")
            .toSelectSql();
        // Must be (a OR b) AND deleted_at, NOT a OR (b AND deleted_at)
        expect(sql).toContain("WHERE (status = ? OR status = ?) AND (deleted_at IS NULL)");
    });

    it("leaves a non-OR query byte-identical (no spurious grouping)", () => {
        const { sql } = new QueryBuilder(SoftItem as any).where("status", "=", "a").toSelectSql();
        expect(sql).toContain("WHERE status = ? AND (deleted_at IS NULL)");
        expect(sql).not.toContain("((");
    });

    it("does not group when soft-deletes are off", () => {
        const { sql } = new QueryBuilder(Plain as any)
            .where("status", "=", "a")
            .orWhere("status", "=", "b")
            .toSelectSql();
        expect(sql).toContain("WHERE status = ? OR status = ?");
        expect(sql).not.toContain("(status = ?");
    });

    it("withTrashed() does not inject a scope and does not group", () => {
        const { sql } = new QueryBuilder(SoftItem as any)
            .where("status", "=", "a")
            .orWhere("status", "=", "b")
            .withTrashed()
            .toSelectSql();
        expect(sql).not.toContain("deleted_at");
        expect(sql).toContain("WHERE status = ? OR status = ?");
    });
});

describe("soft-delete scope with a joined, aliased FROM", () => {
    // Regression: when the query has joins, the soft-delete scope is qualified to
    // this model's table. `this.table` is the raw FROM source, which may carry an
    // alias (`from("items i")`), so qualifying with the whole string produced the
    // invalid `items i.deleted_at` (`near "i": syntax error`). It must use the alias.
    it("qualifies deleted_at with the alias, not the raw FROM string", () => {
        const { sql } = new QueryBuilder(SoftItem as any)
            .from("items i")
            .join("users u", "i.user_id = u.id")
            .where("i.status", "=", "a")
            .toSelectSql();
        expect(sql).toContain("i.deleted_at IS NULL");
        expect(sql).not.toContain("items i.deleted_at");
    });

    it("handles an `AS` alias", () => {
        const { sql } = new QueryBuilder(SoftItem as any)
            .from("items AS it")
            .join("users u", "it.user_id = u.id")
            .toSelectSql();
        expect(sql).toContain("it.deleted_at IS NULL");
        expect(sql).not.toContain("items AS it.deleted_at");
    });

    it("qualifies with the table name when the joined FROM has no alias", () => {
        const { sql } = new QueryBuilder(SoftItem as any)
            .join("users u", "items.user_id = u.id")
            .toSelectSql();
        expect(sql).toContain("items.deleted_at IS NULL");
    });

    it("qualifies to the model's table when it is a JOIN, not the FROM (e.g. FTS search)", () => {
        // FROM an FTS/virtual table, joined to the model's real table. deleted_at
        // lives on `items` (aliased `i`), NOT on `items_fts`.
        const { sql } = new QueryBuilder(SoftItem as any)
            .from("items_fts")
            .join("items i", "items_fts.rowid = i.rowid")
            .toSelectSql();
        expect(sql).toContain("i.deleted_at IS NULL");
        expect(sql).not.toContain("items_fts.deleted_at");
    });

    it("uses the alias of a schema-qualified FROM (`main.items i`)", () => {
        const { sql } = new QueryBuilder(SoftItem as any)
            .from("main.items i")
            .join("users u", "i.user_id = u.id")
            .toSelectSql();
        expect(sql).toContain("i.deleted_at IS NULL");
        expect(sql).not.toContain("main.items i.deleted_at");
    });

    it("qualifies with the schema-qualified name when the joined FROM has no alias (`main.items`)", () => {
        const { sql } = new QueryBuilder(SoftItem as any)
            .from("main.items")
            .join("users u", "main.items.user_id = u.id")
            .toSelectSql();
        expect(sql).toContain("main.items.deleted_at IS NULL");
    });

    it("does not false-match a similarly-named table (`line_items` for model `items`)", () => {
        const { sql } = new QueryBuilder(SoftItem as any)
            .from("items i")
            .join("line_items li", "li.item_id = i.id")
            .toSelectSql();
        // must qualify with the model table's alias `i`, never `li`
        expect(sql).toContain("i.deleted_at IS NULL");
        expect(sql).not.toContain("li.deleted_at");
    });
});

describe("ORDER BY direction + LIMIT/OFFSET are runtime-guarded (SQL injection)", () => {
    it("orderBy rejects a non-asc/desc direction (the as-cast bypass)", () => {
        expect(() => new QueryBuilder(Plain as any).orderBy("id", "asc,(SELECT secret FROM users)" as never))
            .toThrow(/Invalid order direction/);
        expect(() => new QueryBuilder(Plain as any).orderByRank("DROP" as never)).toThrow(/Invalid order direction/);
    });
    it("orderBy still accepts asc/desc case-insensitively", () => {
        expect(() => new QueryBuilder(Plain as any).orderBy("id", "ASC" as never)).not.toThrow();
        const { sql } = new QueryBuilder(Plain as any).orderBy("id", "desc").toSelectSql();
        expect(sql).toContain("ORDER BY id DESC");
    });
    it("limit/offset reject a non-integer operand (query-string injection)", () => {
        expect(() => new QueryBuilder(Plain as any).limit("10 UNION SELECT 1" as never)).toThrow(/Invalid LIMIT/);
        expect(() => new QueryBuilder(Plain as any).offset("-1 OR 1=1" as never)).toThrow(/Invalid OFFSET/);
        expect(() => new QueryBuilder(Plain as any).limit(-1)).toThrow(/Invalid LIMIT/);
    });
    it("limit/offset accept a valid non-negative integer (and coerce a numeric string)", () => {
        expect(() => new QueryBuilder(Plain as any).limit(5).offset(10)).not.toThrow();
        const { sql } = new QueryBuilder(Plain as any).limit("5" as never).toSelectSql();
        expect(sql).toContain("LIMIT 5");
    });
});

describe("applyRelationConstraint (whereHas decorrelation guard)", () => {
    it("groups a callback that introduces a top-level OR", () => {
        const qb = new QueryBuilder(Plain as any).whereRaw("related.x = parent.y");
        qb.applyRelationConstraint((q) => q.where("a", "=", 1).orWhere("b", "=", 2));
        const { sql, bindings } = qb.toSelectSql();
        // correlation must stay ANDed against the whole OR group
        expect(sql).toContain("(related.x = parent.y) AND (a = ? OR b = ?)");
        expect(bindings).toEqual([1, 2]);
    });

    it("appends a single condition flat (simple-case SQL preserved)", () => {
        const qb = new QueryBuilder(Plain as any).whereRaw("related.x = parent.y");
        qb.applyRelationConstraint((q) => q.where("a", "=", 1));
        const { sql } = qb.toSelectSql();
        expect(sql).toContain("(related.x = parent.y) AND a = ?");
    });
});

describe("eager-load key chunking", () => {
    it("returns a single batch at or below the cap", () => {
        const keys = Array.from({ length: EAGER_WHERE_IN_CHUNK }, (_, i) => i);
        const batches = chunkKeys(keys);
        expect(batches).toHaveLength(1);
        expect(batches[0]).toHaveLength(EAGER_WHERE_IN_CHUNK);
    });

    it("splits above the cap without losing or duplicating keys", () => {
        const keys = Array.from({ length: EAGER_WHERE_IN_CHUNK * 2 + 5 }, (_, i) => i);
        const batches = chunkKeys(keys);
        expect(batches).toHaveLength(3);
        expect(batches.every((b) => b.length <= EAGER_WHERE_IN_CHUNK)).toBe(true);
        expect(batches.flat()).toEqual(keys);
    });

    it("handles an empty key list", () => {
        expect(chunkKeys([])).toEqual([[]]);
    });
});
