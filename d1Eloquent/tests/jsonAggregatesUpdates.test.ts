// jsonAggregatesUpdates.test.ts
// SQL-generation unit tests for JSON aggregate selects, JSON path ordering,
// and JSON update helpers (json_set / json_patch / json_remove).
// Live D1 round-trips are covered separately in jsonField.integration.test.ts.

import { describe, it, expect } from "vitest";
import { QueryBuilder } from "../queryBuilder";

interface DocAttrs {
    id?: string;
    user_id?: string;
    tags?: string;
    config?: string;
    name?: string;
}

class Doc {
    static table = "docs";
    static primaryKey = "id";
    static softDeletes = false;
    attrs: DocAttrs;
    constructor(attrs: DocAttrs = {}) { this.attrs = attrs; }
    toObject() { return this.attrs as Record<string, unknown>; }
}

describe("QueryBuilder.selectJsonGroupArray — json_group_array aggregate", () => {
    it("appends json_group_array(expr) AS alias to SELECT", () => {
        const qb = new QueryBuilder(Doc)
            .select(["user_id"])
            .selectJsonGroupArray("tag", "tags")
            .groupBy("user_id");
        const { sql } = qb.toSelectSql();
        expect(sql).toContain("json_group_array(tag) AS tags");
        expect(sql).toContain("GROUP BY user_id");
    });

    it("replaces * when no other selects have been set", () => {
        const qb = new QueryBuilder(Doc).selectJsonGroupArray("name", "names");
        const { sql } = qb.toSelectSql();
        expect(sql).not.toContain("SELECT *");
        expect(sql).toContain("json_group_array(name) AS names");
    });

    it("accepts complex expressions like json_extract inside the aggregate", () => {
        const qb = new QueryBuilder(Doc)
            .select(["customer_id"])
            .selectJsonGroupArray("json_extract(line_items, '$.sku')", "skus")
            .groupBy("customer_id");
        const { sql } = qb.toSelectSql();
        expect(sql).toContain("json_group_array(json_extract(line_items, '$.sku')) AS skus");
    });
});

describe("QueryBuilder.selectJsonGroupObject — json_group_object aggregate", () => {
    it("emits json_group_object(key, value) AS alias", () => {
        const qb = new QueryBuilder(Doc)
            .select(["user_id"])
            .selectJsonGroupObject("key", "value", "settings")
            .groupBy("user_id");
        const { sql } = qb.toSelectSql();
        expect(sql).toContain("json_group_object(key, value) AS settings");
    });

    it("replaces * when no other selects have been set", () => {
        const qb = new QueryBuilder(Doc).selectJsonGroupObject("k", "v", "kvs");
        const { sql } = qb.toSelectSql();
        expect(sql).not.toContain("SELECT *");
        expect(sql).toContain("json_group_object(k, v) AS kvs");
    });
});

describe("QueryBuilder.orderByJsonPath", () => {
    it("emits ORDER BY json_extract(col, path) <dir>", () => {
        const qb = new QueryBuilder(Doc).orderByJsonPath("config", "$.priority", "desc");
        const { sql } = qb.toSelectSql();
        expect(sql).toContain("ORDER BY json_extract(config, '$.priority') DESC");
    });

    it("defaults to ascending direction", () => {
        const qb = new QueryBuilder(Doc).orderByJsonPath("config", "$.priority");
        const { sql } = qb.toSelectSql();
        expect(sql).toContain("ORDER BY json_extract(config, '$.priority') ASC");
    });

    it("escapes single quotes in the path", () => {
        const qb = new QueryBuilder(Doc).orderByJsonPath("config", "$.it's", "asc");
        const { sql } = qb.toSelectSql();
        expect(sql).toContain("json_extract(config, '$.it''s')");
    });
});

// updateJsonSet / updateJsonPatch / updateJsonRemove tests need to capture the
// SQL that would be sent to D1. Use a recording fake-db.

function recorder() {
    const calls: Array<{ sql: string; bindings: unknown[] }> = [];
    return {
        db: {
            prepare: (sql: string) => ({
                bind: (...bindings: unknown[]) => ({
                    run: async () => {
                        calls.push({ sql, bindings });
                        return { success: true, meta: { changes: 1 } };
                    },
                }),
            }),
        } as unknown as D1Database,
        calls,
    };
}

describe("QueryBuilder.updateJsonSet — json_set(col, path, value)", () => {
    it("emits UPDATE ... SET col = json_set(col, ?, ?) WHERE ...", async () => {
        const { db, calls } = recorder();
        await new QueryBuilder(Doc).whereEq("id", "d1").updateJsonSet(db, "config", "$.role", "admin");
        expect(calls.length).toBe(1);
        expect(calls[0].sql).toBe(
            "UPDATE docs SET config = json_set(config, ?, ?) WHERE id = ?",
        );
        expect(calls[0].bindings).toEqual(["$.role", "admin", "d1"]);
    });

    it("returns the affected row count from meta.changes", async () => {
        const { db } = recorder();
        const n = await new QueryBuilder(Doc).whereEq("id", "d1").updateJsonSet(db, "config", "$.x", 1);
        expect(n).toBe(1);
    });
});

describe("QueryBuilder.updateJsonPatch — json_patch(col, patch)", () => {
    it("emits UPDATE ... SET col = json_patch(col, ?) WHERE ...", async () => {
        const { db, calls } = recorder();
        await new QueryBuilder(Doc).whereEq("id", "d1")
            .updateJsonPatch(db, "config", { theme: "dark", count: 3 });
        expect(calls[0].sql).toBe(
            "UPDATE docs SET config = json_patch(config, ?) WHERE id = ?",
        );
        expect(JSON.parse(calls[0].bindings[0] as string)).toEqual({ theme: "dark", count: 3 });
        expect(calls[0].bindings[1]).toBe("d1");
    });
});

describe("QueryBuilder.updateJsonRemove — json_remove(col, ...paths)", () => {
    it("emits a single-path UPDATE with one placeholder", async () => {
        const { db, calls } = recorder();
        await new QueryBuilder(Doc).whereEq("id", "d1")
            .updateJsonRemove(db, "config", "$.legacy");
        expect(calls[0].sql).toBe(
            "UPDATE docs SET config = json_remove(config, ?) WHERE id = ?",
        );
        expect(calls[0].bindings).toEqual(["$.legacy", "d1"]);
    });

    it("emits a multi-path UPDATE with one placeholder per path", async () => {
        const { db, calls } = recorder();
        await new QueryBuilder(Doc).whereEq("id", "d1")
            .updateJsonRemove(db, "config", ["$.a", "$.b", "$.c"]);
        expect(calls[0].sql).toBe(
            "UPDATE docs SET config = json_remove(config, ?, ?, ?) WHERE id = ?",
        );
        expect(calls[0].bindings).toEqual(["$.a", "$.b", "$.c", "d1"]);
    });

    it("returns 0 without executing when paths is empty", async () => {
        const { db, calls } = recorder();
        const n = await new QueryBuilder(Doc).whereEq("id", "d1").updateJsonRemove(db, "config", []);
        expect(n).toBe(0);
        expect(calls.length).toBe(0);
    });
});
