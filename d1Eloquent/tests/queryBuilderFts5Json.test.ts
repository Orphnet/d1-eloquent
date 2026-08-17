// queryBuilderFts5Json.test.ts
// Pure SQL-generation unit tests for new QueryBuilder methods:
// FTS5 MATCH, JSON helpers, CTEs, index hints.

import { describe, it, expect } from "vitest";
import { QueryBuilder } from "../queryBuilder";

interface DocAttrs {
    id?: string;
    title?: string;
    body?: string;
    tags?: string;
    config?: string;
}

class Doc {
    static table = "docs";
    static primaryKey = "id";
    static softDeletes = false;
    attrs: DocAttrs;
    constructor(attrs: DocAttrs = {}) { this.attrs = attrs; }
    toObject() { return this.attrs as Record<string, unknown>; }
}

class FtsIdx {
    static table = "docs_idx";
    static primaryKey = "rowid";
    static softDeletes = false;
    attrs: Record<string, unknown> = {};
    constructor(attrs: Record<string, unknown> = {}) { this.attrs = attrs; }
    toObject() { return this.attrs; }
}

describe("QueryBuilder.whereMatch — FTS5 MATCH operator", () => {
    it("emits col MATCH ? with the pattern as a binding", () => {
        const qb = new QueryBuilder(FtsIdx);
        qb.whereMatch("docs_idx", "rust workers");
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toContain("docs_idx MATCH ?");
        expect(bindings).toEqual(["rust workers"]);
    });

    it("combines with normal where clauses (AND)", () => {
        const qb = new QueryBuilder(FtsIdx);
        qb.whereMatch("docs_idx", "rust").where("lang", "=", "en");
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toMatch(/WHERE docs_idx MATCH \? AND lang = \?/);
        expect(bindings).toEqual(["rust", "en"]);
    });

    it("orWhereMatch joins with OR", () => {
        const qb = new QueryBuilder(FtsIdx);
        qb.whereMatch("title", "rust").orWhereMatch("body", "workers");
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toContain("title MATCH ? OR body MATCH ?");
        expect(bindings).toEqual(["rust", "workers"]);
    });

    it("orderByRank appends ORDER BY rank ASC", () => {
        const qb = new QueryBuilder(FtsIdx);
        qb.whereMatch("docs_idx", "rust").orderByRank();
        const { sql } = qb.toSelectSql();
        expect(sql).toContain("ORDER BY rank ASC");
    });

    it("orderByRank('desc') uses descending order", () => {
        const qb = new QueryBuilder(FtsIdx);
        qb.whereMatch("docs_idx", "rust").orderByRank("desc");
        const { sql } = qb.toSelectSql();
        expect(sql).toContain("ORDER BY rank DESC");
    });
});

describe("QueryBuilder.whereJsonPath — json_extract comparisons", () => {
    it("emits json_extract(col, ?) op ? with path and value bindings", () => {
        const qb = new QueryBuilder(Doc);
        qb.whereJsonPath("config", "$.role", "=", "admin");
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toContain("(json_extract(config, ?) = ?)");
        expect(bindings).toEqual(["$.role", "admin"]);
    });

    it("supports nested paths and numeric comparison", () => {
        const qb = new QueryBuilder(Doc);
        qb.whereJsonPath("config", "$.notifications.count", ">", 5);
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toContain("(json_extract(config, ?) > ?)");
        expect(bindings).toEqual(["$.notifications.count", 5]);
    });

    it("orWhereJsonPath joins with OR", () => {
        const qb = new QueryBuilder(Doc);
        qb.where("title", "=", "a").orWhereJsonPath("config", "$.featured", "=", 1);
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toContain(" OR ");
        expect(sql).toContain("json_extract(config, ?) = ?");
        expect(bindings).toEqual(["a", "$.featured", 1]);
    });
});

describe("QueryBuilder.whereJsonContains — array membership", () => {
    it("emits json_each EXISTS subquery against the column", () => {
        const qb = new QueryBuilder(Doc);
        qb.whereJsonContains("tags", "rust");
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toContain(
            "EXISTS (SELECT 1 FROM json_each(tags) WHERE json_each.value = ?)",
        );
        expect(bindings).toEqual(["rust"]);
    });

    it("uses json_extract(col, path) when a path is supplied", () => {
        const qb = new QueryBuilder(Doc);
        qb.whereJsonContains("config", "rust", "$.tags");
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toContain(
            "EXISTS (SELECT 1 FROM json_each(json_extract(config, ?)) WHERE json_each.value = ?)",
        );
        expect(bindings).toEqual(["$.tags", "rust"]);
    });
});

describe("QueryBuilder.whereJsonLength — json_array_length", () => {
    it("emits json_array_length(col) op ?", () => {
        const qb = new QueryBuilder(Doc);
        qb.whereJsonLength("tags", ">=", 3);
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toContain("(json_array_length(tags) >= ?)");
        expect(bindings).toEqual([3]);
    });

    it("supports path traversal", () => {
        const qb = new QueryBuilder(Doc);
        qb.whereJsonLength("config", ">", 0, "$.tags");
        const { sql, bindings } = qb.toSelectSql();
        expect(sql).toContain("(json_array_length(json_extract(config, ?)) > ?)");
        expect(bindings).toEqual(["$.tags", 0]);
    });
});

describe("QueryBuilder.selectJsonExtract", () => {
    it("replaces * with the json_extract expression", () => {
        const qb = new QueryBuilder(Doc);
        qb.selectJsonExtract("config", "$.role", "user_role");
        const { sql } = qb.toSelectSql();
        expect(sql).toContain("SELECT json_extract(config, '$.role') AS user_role FROM docs");
    });

    it("appends to existing select list", () => {
        const qb = new QueryBuilder(Doc);
        qb.select(["id", "title"]).selectJsonExtract("config", "$.role", "role");
        const { sql } = qb.toSelectSql();
        expect(sql).toContain(
            "SELECT id, title, json_extract(config, '$.role') AS role FROM docs",
        );
    });

    it("escapes single quotes in the path", () => {
        const qb = new QueryBuilder(Doc);
        qb.selectJsonExtract("config", "$.it's", "out");
        const { sql } = qb.toSelectSql();
        expect(sql).toContain("'$.it''s'");
    });
});

describe("QueryBuilder.withCte — CTE prefix", () => {
    it("prepends WITH name AS (...) before the SELECT", () => {
        const sub = new QueryBuilder(Doc).select(["id"]).where("title", "=", "a");
        const qb = new QueryBuilder(Doc)
            .withCte("a", sub)
            .whereRaw("id IN (SELECT id FROM a)");
        const { sql, bindings } = qb.toSelectSql();
        expect(sql.startsWith("WITH a AS (SELECT id FROM docs WHERE title = ?)")).toBe(true);
        expect(sql).toContain("SELECT * FROM docs");
        // CTE bindings come first
        expect(bindings).toEqual(["a"]);
    });

    it("supports explicit column list", () => {
        const sub = new QueryBuilder(Doc).select(["id", "title"]);
        const qb = new QueryBuilder(Doc).withCte("a", sub, ["pid", "ptitle"]);
        const { sql } = qb.toSelectSql();
        expect(sql.startsWith("WITH a (pid, ptitle) AS (SELECT id, title FROM docs)")).toBe(true);
    });

    it("multiple CTEs chain with comma", () => {
        const sub1 = new QueryBuilder(Doc).select(["id"]);
        const sub2 = new QueryBuilder(Doc).select(["title"]);
        const qb = new QueryBuilder(Doc).withCte("a", sub1).withCte("b", sub2);
        const { sql } = qb.toSelectSql();
        expect(sql.startsWith("WITH a AS (")).toBe(true);
        expect(sql).toContain("), b AS (");
    });

    it("withRecursive uses WITH RECURSIVE", () => {
        const sub = new QueryBuilder(Doc).select(["id"]);
        const qb = new QueryBuilder(Doc).withRecursive("walker", sub);
        const { sql } = qb.toSelectSql();
        expect(sql.startsWith("WITH RECURSIVE walker AS (")).toBe(true);
    });

    it("mixing recursive and non-recursive promotes WITH RECURSIVE", () => {
        const sub1 = new QueryBuilder(Doc).select(["id"]);
        const sub2 = new QueryBuilder(Doc).select(["title"]);
        const qb = new QueryBuilder(Doc).withCte("a", sub1).withRecursive("b", sub2);
        const { sql } = qb.toSelectSql();
        expect(sql.startsWith("WITH RECURSIVE ")).toBe(true);
    });
});

describe("QueryBuilder index hints", () => {
    it("indexedBy() inserts INDEXED BY <name> after FROM", () => {
        const qb = new QueryBuilder(Doc).indexedBy("idx_docs_title");
        const { sql } = qb.toSelectSql();
        expect(sql).toContain("FROM docs INDEXED BY idx_docs_title");
    });

    it("notIndexed() inserts NOT INDEXED after FROM", () => {
        const qb = new QueryBuilder(Doc).notIndexed();
        const { sql } = qb.toSelectSql();
        expect(sql).toContain("FROM docs NOT INDEXED");
    });
});
