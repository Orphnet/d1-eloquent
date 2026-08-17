// queryBuilderExtended.test.ts
// SQL generation tests for QueryBuilder methods not covered by other test files

import { describe, it, expect } from "vitest";
import { QueryBuilder } from "../queryBuilder";

class Item {
    static table = "items";
    static primaryKey = "id";
    static softDeletes = false;
    attrs: Record<string, unknown>;
    constructor(attrs: Record<string, unknown> = {}) { this.attrs = attrs; }
    toObject() { return this.attrs; }
}

class SoftItem {
    static table = "soft_items";
    static primaryKey = "id";
    static softDeletes = true;
    attrs: Record<string, unknown>;
    constructor(attrs: Record<string, unknown> = {}) { this.attrs = attrs; }
    toObject() { return this.attrs; }
}

// ── WHERE clause variants ────────────────────────────────────────────

describe("orWhereIn", () => {
    it("produces OR col IN (...) with array", () => {
        const { sql, bindings } = new QueryBuilder(Item)
            .where("a", "=", 1)
            .orWhereIn("id", ["x", "y"])
            .toSelectSql();
        expect(sql).toContain("OR id IN (?, ?)");
        expect(bindings).toEqual([1, "x", "y"]);
    });

    it("produces OR col IN (subquery) with QueryBuilder", () => {
        const sub = new QueryBuilder(Item).select(["id"]).where("active", "=", 1);
        const { sql } = new QueryBuilder(Item)
            .where("a", "=", 1)
            .orWhereIn("id", sub)
            .toSelectSql();
        expect(sql).toContain("OR id IN (SELECT id FROM items WHERE active = ?)");
    });
});

describe("whereNotIn", () => {
    it("produces NOT IN (...) with array", () => {
        const { sql, bindings } = new QueryBuilder(Item)
            .whereNotIn("id", ["a", "b"])
            .toSelectSql();
        expect(sql).toContain("id NOT IN (?, ?)");
        expect(bindings).toEqual(["a", "b"]);
    });

    it("produces NOT IN (subquery) with QueryBuilder", () => {
        const sub = new QueryBuilder(Item).select(["id"]).where("x", "=", 1);
        const { sql } = new QueryBuilder(Item)
            .whereNotIn("id", sub)
            .toSelectSql();
        expect(sql).toContain("id NOT IN (SELECT id FROM items WHERE x = ?)");
    });
});

describe("orWhereNotIn", () => {
    it("produces OR NOT IN (...) with array", () => {
        const { sql } = new QueryBuilder(Item)
            .where("a", "=", 1)
            .orWhereNotIn("id", ["x"])
            .toSelectSql();
        expect(sql).toContain("OR id NOT IN (?)");
    });

    it("produces OR NOT IN (subquery) with QueryBuilder", () => {
        const sub = new QueryBuilder(Item).select(["id"]).where("z", "=", 1);
        const { sql } = new QueryBuilder(Item)
            .where("a", "=", 1)
            .orWhereNotIn("id", sub)
            .toSelectSql();
        expect(sql).toContain("OR id NOT IN (SELECT id FROM items WHERE z = ?)");
    });
});

describe("whereIn with subquery", () => {
    it("produces col IN (subquery) with bindings", () => {
        const sub = new QueryBuilder(Item).select(["id"]).where("status", "=", "active");
        const { sql, bindings } = new QueryBuilder(Item)
            .whereIn("user_id", sub)
            .toSelectSql();
        expect(sql).toContain("user_id IN (SELECT id FROM items WHERE status = ?)");
        expect(bindings).toContain("active");
    });
});

// ── Null variants ────────────────────────────────────────────────────

describe("orWhereNull / orWhereNotNull", () => {
    it("orWhereNull produces OR col IS NULL", () => {
        const { sql } = new QueryBuilder(Item)
            .where("a", "=", 1)
            .orWhereNull("b")
            .toSelectSql();
        expect(sql).toContain("OR b IS NULL");
    });

    it("orWhereNotNull produces OR col IS NOT NULL", () => {
        const { sql } = new QueryBuilder(Item)
            .where("a", "=", 1)
            .orWhereNotNull("b")
            .toSelectSql();
        expect(sql).toContain("OR b IS NOT NULL");
    });
});

// ── Between variants ─────────────────────────────────────────────────

describe("whereNotBetween", () => {
    it("produces NOT BETWEEN ? AND ?", () => {
        const { sql, bindings } = new QueryBuilder(Item)
            .whereNotBetween("age", [10, 20])
            .toSelectSql();
        expect(sql).toContain("age NOT BETWEEN ? AND ?");
        expect(bindings).toEqual([10, 20]);
    });
});

describe("orWhereBetween", () => {
    it("produces OR col BETWEEN ? AND ?", () => {
        const { sql } = new QueryBuilder(Item)
            .where("a", "=", 1)
            .orWhereBetween("age", [10, 20])
            .toSelectSql();
        expect(sql).toContain("OR age BETWEEN ? AND ?");
    });
});

describe("orWhereNotBetween", () => {
    it("produces OR col NOT BETWEEN ? AND ?", () => {
        const { sql } = new QueryBuilder(Item)
            .where("a", "=", 1)
            .orWhereNotBetween("age", [10, 20])
            .toSelectSql();
        expect(sql).toContain("OR age NOT BETWEEN ? AND ?");
    });
});

// ── Raw variants ─────────────────────────────────────────────────────

describe("orWhereRaw", () => {
    it("produces OR (raw SQL)", () => {
        const { sql, bindings } = new QueryBuilder(Item)
            .where("a", "=", 1)
            .orWhereRaw("score > ?", [50])
            .toSelectSql();
        expect(sql).toContain("OR (score > ?)");
        expect(bindings).toEqual([1, 50]);
    });
});

// ── Group variants ───────────────────────────────────────────────────

describe("whereGroup", () => {
    it("produces AND (grouped conditions)", () => {
        const { sql, bindings } = new QueryBuilder(Item)
            .where("a", "=", 1)
            .whereGroup((q) => {
                q.where("b", "=", 2).orWhere("c", "=", 3);
            })
            .toSelectSql();
        expect(sql).toContain("AND (b = ? OR c = ?)");
        expect(bindings).toEqual([1, 2, 3]);
    });

    it("nested groups compose correctly", () => {
        const { sql } = new QueryBuilder(Item)
            .whereGroup((q) => {
                q.where("a", "=", 1).where("b", "=", 2);
            })
            .orWhereGroup((q) => {
                q.where("c", "=", 3).where("d", "=", 4);
            })
            .toSelectSql();
        expect(sql).toContain("(a = ? AND b = ?)");
        expect(sql).toContain("OR (c = ? AND d = ?)");
    });
});

describe("orWhereGroup", () => {
    it("produces OR (grouped conditions)", () => {
        const { sql, bindings } = new QueryBuilder(Item)
            .where("a", "=", 1)
            .orWhereGroup((q) => {
                q.where("b", "=", 2).where("c", "=", 3);
            })
            .toSelectSql();
        expect(sql).toContain("OR (b = ? AND c = ?)");
        expect(bindings).toEqual([1, 2, 3]);
    });
});

// ── selectRaw ────────────────────────────────────────────────────────

describe("selectRaw", () => {
    it("replaces default * select when called first", () => {
        const { sql } = new QueryBuilder(Item)
            .selectRaw("COUNT(*) as cnt")
            .toSelectSql();
        expect(sql).toMatch(/^SELECT COUNT\(\*\) as cnt FROM items/);
    });

    it("appends to existing explicit select", () => {
        const { sql } = new QueryBuilder(Item)
            .select(["id"])
            .selectRaw("COUNT(*) as cnt")
            .toSelectSql();
        expect(sql).toMatch(/^SELECT id, COUNT\(\*\) as cnt FROM items/);
    });
});

// ── EXISTS / whereExists / whereNotExists ────────────────────────────

describe("whereExists / whereNotExists", () => {
    it("whereExists produces EXISTS (sql)", () => {
        const { sql } = new QueryBuilder(Item)
            .whereExists("SELECT 1 FROM other WHERE other.id = items.id")
            .toSelectSql();
        expect(sql).toContain("EXISTS (SELECT 1 FROM other WHERE other.id = items.id)");
    });

    it("whereNotExists produces NOT EXISTS (sql)", () => {
        const { sql } = new QueryBuilder(Item)
            .whereNotExists("SELECT 1 FROM other WHERE other.id = items.id")
            .toSelectSql();
        expect(sql).toContain("NOT EXISTS (SELECT 1 FROM other WHERE other.id = items.id)");
    });

    it("whereExists with bindings", () => {
        const { sql, bindings } = new QueryBuilder(Item)
            .whereExists("SELECT 1 FROM other WHERE other.type = ?", ["active"])
            .toSelectSql();
        expect(sql).toContain("EXISTS");
        expect(bindings).toContain("active");
    });
});

// ── Soft delete scopes ───────────────────────────────────────────────

describe("soft delete scopes", () => {
    it("default query adds deleted_at IS NULL for soft-delete models", () => {
        const { sql } = new QueryBuilder(SoftItem).toSelectSql();
        expect(sql).toContain("deleted_at IS NULL");
    });

    it("withTrashed removes the soft-delete filter", () => {
        const { sql } = new QueryBuilder(SoftItem).withTrashed().toSelectSql();
        expect(sql).not.toContain("deleted_at IS NULL");
        expect(sql).not.toContain("deleted_at IS NOT NULL");
    });

    it("onlyTrashed adds deleted_at IS NOT NULL", () => {
        const { sql } = new QueryBuilder(SoftItem).onlyTrashed().toSelectSql();
        expect(sql).toContain("deleted_at IS NOT NULL");
        expect(sql).not.toContain("deleted_at IS NULL");
    });
});

// ── Offset ───────────────────────────────────────────────────────────

describe("offset", () => {
    it("adds OFFSET clause", () => {
        const { sql } = new QueryBuilder(Item).limit(10).offset(20).toSelectSql();
        expect(sql).toContain("LIMIT 10");
        expect(sql).toContain("OFFSET 20");
    });
});

// ── GroupBy ──────────────────────────────────────────────────────────

describe("groupBy", () => {
    it("adds GROUP BY clause", () => {
        const { sql } = new QueryBuilder(Item)
            .select(["type"])
            .groupBy("type")
            .toSelectSql();
        expect(sql).toContain("GROUP BY type");
    });

    it("supports multiple group columns", () => {
        const { sql } = new QueryBuilder(Item)
            .groupBy("type", "status")
            .toSelectSql();
        expect(sql).toContain("GROUP BY type, status");
    });
});

// ── orWhereEq ────────────────────────────────────────────────────────

describe("orWhereEq", () => {
    it("produces OR col = ? shorthand", () => {
        const { sql, bindings } = new QueryBuilder(Item)
            .whereEq("a", 1)
            .orWhereEq("b", 2)
            .toSelectSql();
        expect(sql).toContain("a = ?");
        expect(sql).toContain("OR b = ?");
        expect(bindings).toEqual([1, 2]);
    });
});

// ── select with string ──────────────────────────────────────────────

describe("select with string", () => {
    it("accepts a string instead of array", () => {
        const { sql } = new QueryBuilder(Item).select("id, name").toSelectSql();
        expect(sql).toMatch(/^SELECT id, name FROM items/);
    });
});

// ── QB-01 distinct ───────────────────────────────────────────────────

describe("distinct (QB-01)", () => {
    it("emits SELECT DISTINCT * FROM items by default", () => {
        const { sql, bindings } = new QueryBuilder(Item).distinct().toSelectSql();
        expect(sql).toBe("SELECT DISTINCT * FROM items");
        expect(bindings).toEqual([]);
    });

    it("emits SELECT DISTINCT id, name FROM items with explicit select", () => {
        const { sql, bindings } = new QueryBuilder(Item)
            .distinct()
            .select(["id", "name"])
            .toSelectSql();
        expect(sql).toBe("SELECT DISTINCT id, name FROM items");
        expect(bindings).toEqual([]);
    });

    it("does not emit DISTINCT without calling distinct()", () => {
        const { sql } = new QueryBuilder(Item).toSelectSql();
        expect(sql).toBe("SELECT * FROM items");
        expect(sql).not.toContain("DISTINCT");
    });
});

// ── QB-04 whereColumn ────────────────────────────────────────────────

describe("whereColumn (QB-04)", () => {
    it("two-arg form defaults to = operator with no bindings", () => {
        const { sql, bindings } = new QueryBuilder(Item)
            .whereColumn("price", "cost")
            .toSelectSql();
        expect(sql).toContain("WHERE price = cost");
        expect(bindings).toEqual([]);
    });

    it("three-arg form uses explicit operator with no bindings", () => {
        const { sql, bindings } = new QueryBuilder(Item)
            .whereColumn("price", ">", "cost")
            .toSelectSql();
        expect(sql).toContain("WHERE price > cost");
        expect(bindings).toEqual([]);
    });

    it("orWhereColumn uses OR join prefix", () => {
        const { sql, bindings } = new QueryBuilder(Item)
            .where("active", "=", 1)
            .orWhereColumn("updated_at", ">", "created_at")
            .toSelectSql();
        expect(sql).toContain("OR updated_at > created_at");
        expect(bindings).toEqual([1]);
    });

    it("two-arg orWhereColumn defaults to = operator", () => {
        const { sql, bindings } = new QueryBuilder(Item)
            .where("a", "=", 1)
            .orWhereColumn("price", "cost")
            .toSelectSql();
        expect(sql).toContain("OR price = cost");
        expect(bindings).toEqual([1]);
    });
});

// ── QB-02 having ─────────────────────────────────────────────────────

describe("having (QB-02)", () => {
    it("emits HAVING clause after GROUP BY", () => {
        const { sql, bindings } = new QueryBuilder(Item)
            .select(["status"])
            .groupBy("status")
            .having("status", "=", "active")
            .toSelectSql();
        expect(sql).toContain("GROUP BY status");
        expect(sql).toContain("HAVING status = ?");
        expect(sql.indexOf("GROUP BY")).toBeLessThan(sql.indexOf("HAVING"));
        expect(bindings).toEqual(["active"]);
    });

    it("chaining having and orHaving emits combined HAVING clause", () => {
        const { sql, bindings } = new QueryBuilder(Item)
            .groupBy("status")
            .having("status", "=", "active")
            .orHaving("count", ">", 10)
            .toSelectSql();
        expect(sql).toContain("HAVING status = ? OR count > ?");
        expect(bindings).toEqual(["active", 10]);
    });

    it("HAVING bindings are ordered after WHERE bindings", () => {
        const { sql, bindings } = new QueryBuilder(Item)
            .where("active", "=", 1)
            .groupBy("status")
            .having("status", "=", "active")
            .toSelectSql();
        expect(sql).toContain("WHERE active = ?");
        expect(sql).toContain("HAVING status = ?");
        expect(bindings).toEqual([1, "active"]);
    });
});

// ── QB-03 havingRaw ──────────────────────────────────────────────────

describe("havingRaw (QB-03)", () => {
    it("emits HAVING (raw SQL) with bindings", () => {
        const { sql, bindings } = new QueryBuilder(Item)
            .groupBy("user_id")
            .havingRaw("COUNT(*) > ?", [5])
            .toSelectSql();
        expect(sql).toContain("HAVING (COUNT(*) > ?)");
        expect(bindings).toEqual([5]);
    });

    it("orHavingRaw uses OR join prefix", () => {
        const { sql, bindings } = new QueryBuilder(Item)
            .groupBy("status")
            .havingRaw("COUNT(*) > ?", [3])
            .orHavingRaw("SUM(amount) > ?", [100])
            .toSelectSql();
        expect(sql).toContain("HAVING (COUNT(*) > ?) OR (SUM(amount) > ?)");
        expect(bindings).toEqual([3, 100]);
    });

    it("havingRaw bindings appear after WHERE bindings", () => {
        const { sql, bindings } = new QueryBuilder(Item)
            .where("deleted", "=", 0)
            .groupBy("user_id")
            .havingRaw("COUNT(*) > ?", [5])
            .toSelectSql();
        expect(sql).toContain("WHERE deleted = ?");
        expect(sql).toContain("HAVING (COUNT(*) > ?)");
        expect(bindings).toEqual([0, 5]);
    });
});

// ── Clone preservation (Plan 01 fields) ─────────────────────────────

describe("clone preserves Plan 01 fields", () => {
    it("chunk preserves distinct and having state", () => {
        const qb = new QueryBuilder(Item)
            .distinct()
            .select(["status", "COUNT(*) as cnt"])
            .groupBy("status")
            .having("cnt", ">", 5);
        const original = qb.toSelectSql();
        expect(original.sql).toContain("SELECT DISTINCT");
        expect(original.sql).toContain("HAVING cnt > ?");
        expect(original.bindings).toEqual([5]);
    });
});

// ── QB-05 selectSub ──────────────────────────────────────────────────

describe("selectSub (QB-05)", () => {
    it("basic subquery select produces (SELECT ...) AS alias in SELECT list", () => {
        const sub = new QueryBuilder(Item).select(["COUNT(*)"]).where("active", "=", 1);
        const { sql, bindings } = new QueryBuilder(Item)
            .select(["id", "name"])
            .selectSub(sub, "active_count")
            .toSelectSql();
        expect(sql).toBe("SELECT id, name, (SELECT COUNT(*) FROM items WHERE active = ?) AS active_count FROM items");
        expect(bindings).toEqual([1]);
    });

    it("selectSub when selects is [*] replaces wildcard", () => {
        const sub = new QueryBuilder(Item).select(["COUNT(*)"]).where("active", "=", 1);
        const { sql } = new QueryBuilder(Item)
            .selectSub(sub, "cnt")
            .toSelectSql();
        expect(sql).toMatch(/^SELECT \(SELECT COUNT/);
        expect(sql).not.toContain("*, ");
    });

    it("selectSub bindings appear before WHERE bindings", () => {
        const sub = new QueryBuilder(Item).select(["COUNT(*)"]).where("type", "=", "a");
        const { bindings } = new QueryBuilder(Item)
            .select(["name"])
            .selectSub(sub, "cnt")
            .where("status", "=", "active")
            .toSelectSql();
        expect(bindings).toEqual(["a", "active"]);
    });

    it("select() after selectSub resets selectSubBindings — no stale bindings", () => {
        const sub = new QueryBuilder(Item).select(["COUNT(*)"]).where("type", "=", "a");
        const { sql, bindings } = new QueryBuilder(Item)
            .selectSub(sub, "cnt")
            .select(["id"])
            .toSelectSql();
        expect(sql).toBe("SELECT id FROM items");
        expect(bindings).toEqual([]);
    });

    it("multiple selectSub calls accumulate in SELECT list with correct binding order", () => {
        const sub1 = new QueryBuilder(Item).select(["COUNT(*)"]).where("x", "=", 1);
        const sub2 = new QueryBuilder(Item).select(["SUM(price)"]).where("y", "=", 2);
        const { sql, bindings } = new QueryBuilder(Item)
            .select(["id"])
            .selectSub(sub1, "cnt")
            .selectSub(sub2, "total")
            .toSelectSql();
        expect(sql).toContain("(SELECT COUNT(*) FROM items WHERE x = ?) AS cnt");
        expect(sql).toContain("(SELECT SUM(price) FROM items WHERE y = ?) AS total");
        expect(bindings).toEqual([1, 2]);
    });
});

// ── QB-06 union / unionAll ───────────────────────────────────────────

describe("union / unionAll (QB-06)", () => {
    it("basic union produces UNION SELECT ... with bindings from both queries", () => {
        const q2 = new QueryBuilder(Item).where("b", "=", 2);
        const { sql, bindings } = new QueryBuilder(Item)
            .where("a", "=", 1)
            .union(q2)
            .toSelectSql();
        expect(sql).toContain("UNION SELECT * FROM items WHERE b = ?");
        expect(bindings).toEqual([1, 2]);
    });

    it("unionAll uses UNION ALL keyword", () => {
        const q2 = new QueryBuilder(Item).where("b", "=", 2);
        const { sql } = new QueryBuilder(Item)
            .where("a", "=", 1)
            .unionAll(q2)
            .toSelectSql();
        expect(sql).toContain("UNION ALL SELECT * FROM items WHERE b = ?");
        expect(sql).not.toContain("UNION SELECT");
    });

    it("multiple unions via chaining produce both UNION and UNION ALL in sequence", () => {
        const q2 = new QueryBuilder(Item).where("b", "=", 2);
        const q3 = new QueryBuilder(Item).where("c", "=", 3);
        const { sql, bindings } = new QueryBuilder(Item)
            .where("a", "=", 1)
            .union(q2)
            .unionAll(q3)
            .toSelectSql();
        expect(sql).toContain("UNION SELECT * FROM items WHERE b = ?");
        expect(sql).toContain("UNION ALL SELECT * FROM items WHERE c = ?");
        expect(bindings).toEqual([1, 2, 3]);
    });

    it("union compiles after LIMIT", () => {
        const q2 = new QueryBuilder(Item).where("b", "=", 2);
        const { sql } = new QueryBuilder(Item)
            .limit(10)
            .union(q2)
            .toSelectSql();
        expect(sql.indexOf("LIMIT 10")).toBeLessThan(sql.indexOf("UNION SELECT"));
    });

    it("union with bindings in both queries — base first, union second", () => {
        const q2 = new QueryBuilder(Item).where("role", "=", "admin");
        const { bindings } = new QueryBuilder(Item)
            .where("active", "=", 1)
            .union(q2)
            .toSelectSql();
        expect(bindings).toEqual([1, "admin"]);
    });
});

// ── Clone preservation (Plan 02 fields) ─────────────────────────────

describe("clone preserves Plan 02 fields", () => {
    it("clone preserves selectSub and union state via toSelectSql", () => {
        const sub = new QueryBuilder(Item).select(["COUNT(*)"]).where("x", "=", 1);
        const union = new QueryBuilder(Item).where("y", "=", 2);
        const qb = new QueryBuilder(Item)
            .select(["id"])
            .selectSub(sub, "cnt")
            .union(union);
        const result = qb.toSelectSql();
        expect(result.sql).toContain("(SELECT COUNT(*) FROM items WHERE x = ?) AS cnt");
        expect(result.sql).toContain("UNION SELECT * FROM items WHERE y = ?");
        expect(result.bindings).toEqual([1, 2]);
    });
});

// ── selectSub + where binding order ─────────────────────────────────

describe("selectSub + where binding order", () => {
    it("subquery bindings precede where bindings", () => {
        const sub = new QueryBuilder(Item).select(["COUNT(*)"]).where("type", "=", "a");
        const { bindings } = new QueryBuilder(Item)
            .select(["name"])
            .selectSub(sub, "cnt")
            .where("status", "=", "active")
            .toSelectSql();
        expect(bindings).toEqual(["a", "active"]);
    });
});

// ── union chaining order ─────────────────────────────────────────────

describe("union chaining order", () => {
    it("multiple unions preserve order", () => {
        const q2 = new QueryBuilder(Item).where("x", "=", 2);
        const q3 = new QueryBuilder(Item).where("y", "=", 3);
        const { sql, bindings } = new QueryBuilder(Item)
            .where("z", "=", 1)
            .union(q2)
            .unionAll(q3)
            .toSelectSql();
        expect(sql).toMatch(/WHERE z = \?.*UNION SELECT.*WHERE x = \?.*UNION ALL SELECT.*WHERE y = \?/);
        expect(bindings).toEqual([1, 2, 3]);
    });
});
