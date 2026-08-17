// queryBuilder.when.test.ts
// Tests for when(), whereNotIn, whereNull/whereNotNull, whereBetween/whereNotBetween, NOT LIKE

import { QueryBuilder } from "../queryBuilder";

class TestModel {
    static table = "users";
    static primaryKey = "id";
    attrs: Record<string, unknown>;
    constructor(attrs: Record<string, unknown> = {}) {
        this.attrs = attrs;
    }
    toObject() {
        return this.attrs;
    }
}

describe("QueryBuilder.when()", () => {
    it("applies ifTrue callback when condition is truthy", () => {
        const qb = new QueryBuilder(TestModel);
        qb.when("active", (q, val) => q.whereEq("status", val));
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toContain("WHERE status = ?");
        expect(bindings).toEqual(["active"]);
    });

    it("does not apply ifTrue callback when condition is falsy", () => {
        const qb = new QueryBuilder(TestModel);
        qb.when("", (q, val) => q.whereEq("status", val));
        const { sql } = qb.toSelectSql();
        expect(sql).not.toContain("WHERE");
    });

    it("applies ifFalse callback when condition is falsy and ifFalse is provided", () => {
        const qb = new QueryBuilder(TestModel);
        qb.when(
            null,
            (q) => q.whereEq("status", "active"),
            (q) => q.whereEq("status", "inactive"),
        );
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toContain("WHERE status = ?");
        expect(bindings).toEqual(["inactive"]);
    });

    it("passes truthy value to ifTrue callback", () => {
        const qb = new QueryBuilder(TestModel);
        const search = "alice";
        qb.when(search, (q, val) => q.whereLike("name", `%${val}%`));
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toContain("WHERE name LIKE ?");
        expect(bindings).toEqual(["%alice%"]);
    });

    it("handles undefined condition as falsy", () => {
        const qb = new QueryBuilder(TestModel);
        qb.when(undefined, (q) => q.whereEq("status", "active"));
        const { sql } = qb.toSelectSql();
        expect(sql).not.toContain("WHERE");
    });

    it("handles 0 condition as falsy", () => {
        const qb = new QueryBuilder(TestModel);
        qb.when(0, (q) => q.whereEq("status", "active"));
        const { sql } = qb.toSelectSql();
        expect(sql).not.toContain("WHERE");
    });

    it("handles false condition as falsy", () => {
        const qb = new QueryBuilder(TestModel);
        qb.when(false, (q) => q.whereEq("status", "active"));
        const { sql } = qb.toSelectSql();
        expect(sql).not.toContain("WHERE");
    });

    it("returns this for chaining", () => {
        const qb = new QueryBuilder(TestModel);
        const result = qb.when("yes", (q) => q.whereEq("a", 1));
        expect(result).toBe(qb);
    });

    it("chains multiple when() calls", () => {
        const qb = new QueryBuilder(TestModel);
        qb.when("active", (q, val) => q.whereEq("status", val))
          .when("admin", (q, val) => q.whereEq("role", val));
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toContain("WHERE status = ? AND role = ?");
        expect(bindings).toEqual(["active", "admin"]);
    });
});

describe("QueryBuilder.whereNotIn() / orWhereNotIn()", () => {
    it("compiles whereNotIn correctly", () => {
        const qb = new QueryBuilder(TestModel);
        qb.whereNotIn("status", ["banned", "suspended"]);
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toContain("WHERE status NOT IN (?, ?)");
        expect(bindings).toEqual(["banned", "suspended"]);
    });

    it("compiles orWhereNotIn correctly", () => {
        const qb = new QueryBuilder(TestModel);
        qb.whereEq("active", true).orWhereNotIn("role", ["guest"]);
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toContain("active = ? OR role NOT IN (?)");
        expect(bindings).toEqual([true, "guest"]);
    });
});

describe("QueryBuilder.whereNull() / whereNotNull()", () => {
    it("compiles whereNull correctly", () => {
        const qb = new QueryBuilder(TestModel);
        qb.whereNull("deleted_at");
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toContain("WHERE deleted_at IS NULL");
        expect(bindings).toEqual([]);
    });

    it("compiles whereNotNull correctly", () => {
        const qb = new QueryBuilder(TestModel);
        qb.whereNotNull("email");
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toContain("WHERE email IS NOT NULL");
        expect(bindings).toEqual([]);
    });

    it("compiles orWhereNull correctly", () => {
        const qb = new QueryBuilder(TestModel);
        qb.whereEq("status", "active").orWhereNull("deleted_at");
        const { sql } = qb.toSelectSql();
        expect(sql).toContain("status = ? OR deleted_at IS NULL");
    });

    it("compiles orWhereNotNull correctly", () => {
        const qb = new QueryBuilder(TestModel);
        qb.whereEq("status", "active").orWhereNotNull("verified_at");
        const { sql } = qb.toSelectSql();
        expect(sql).toContain("status = ? OR verified_at IS NOT NULL");
    });
});

describe("QueryBuilder.whereBetween() / whereNotBetween()", () => {
    it("compiles whereBetween correctly", () => {
        const qb = new QueryBuilder(TestModel);
        qb.whereBetween("age", [18, 65]);
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toContain("WHERE age BETWEEN ? AND ?");
        expect(bindings).toEqual([18, 65]);
    });

    it("compiles whereNotBetween correctly", () => {
        const qb = new QueryBuilder(TestModel);
        qb.whereNotBetween("score", [0, 10]);
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toContain("WHERE score NOT BETWEEN ? AND ?");
        expect(bindings).toEqual([0, 10]);
    });

    it("compiles orWhereBetween correctly", () => {
        const qb = new QueryBuilder(TestModel);
        qb.whereEq("status", "active").orWhereBetween("age", [18, 25]);
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toContain("status = ? OR age BETWEEN ? AND ?");
        expect(bindings).toEqual(["active", 18, 25]);
    });

    it("compiles orWhereNotBetween correctly", () => {
        const qb = new QueryBuilder(TestModel);
        qb.whereEq("status", "active").orWhereNotBetween("age", [0, 17]);
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toContain("status = ? OR age NOT BETWEEN ? AND ?");
        expect(bindings).toEqual(["active", 0, 17]);
    });
});

describe("NOT LIKE operator", () => {
    it("works via where() with NOT LIKE operator", () => {
        const qb = new QueryBuilder(TestModel);
        qb.where("email", "NOT LIKE", "%@spam.com");
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toContain("WHERE email NOT LIKE ?");
        expect(bindings).toEqual(["%@spam.com"]);
    });

    it("combines with other filters", () => {
        const qb = new QueryBuilder(TestModel);
        qb.whereLike("email", "%@orphnet.co.uk")
          .where("email", "NOT LIKE", "admin@%")
          .where("email", "NOT LIKE", "orphbot@%");
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toContain("email LIKE ? AND email NOT LIKE ? AND email NOT LIKE ?");
        expect(bindings).toEqual(["%@orphnet.co.uk", "admin@%", "orphbot@%"]);
    });
});
