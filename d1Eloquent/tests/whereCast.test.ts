// whereCast.test.ts
// "where-value cast dehydration": filter values are run through the model's
// casts at compile time, the same way writes are dehydrated. So
// `whereEq('done', false)` binds 0 (not the JS boolean false), a `Date` in
// `whereBetween` binds its stored ISO string, json objects bind their JSON
// string, etc. Pattern ops (LIKE/GLOB), qualified columns, uncast columns and
// null values are intentionally left untouched.

import { describe, it, expect } from "vitest";
import { QueryBuilder } from "../queryBuilder";
import type { CastDefinition } from "../castManager";

// ── Test models ──────────────────────────────────────────────────────

/** Model with a boolean + datetime + json cast. timestamps off to keep the
 *  cast map limited to what we declare. */
class Task {
    static table = "tasks";
    static primaryKey = "id";
    static timestamps = false;
    static softDeletes = false;
    static casts: Record<string, CastDefinition> = {
        done: "boolean",
        due_at: "datetime",
        metadata: "json",
    };
    attrs: Record<string, unknown>;
    constructor(attrs: Record<string, unknown> = {}) { this.attrs = attrs; }
    toObject() { return this.attrs; }
}

/** Model with NO casts at all (and timestamps off so the merged map is empty). */
class Plain {
    static table = "plain";
    static primaryKey = "id";
    static timestamps = false;
    static softDeletes = false;
    attrs: Record<string, unknown>;
    constructor(attrs: Record<string, unknown> = {}) { this.attrs = attrs; }
    toObject() { return this.attrs; }
}

// A table-only / dummy ctor — the shape used internally for morph-empty
// builders. No casts, no timestamps flag → no user-column dehydration.
const tableOnlyCtor = { table: "__anon__", primaryKey: "id" } as never;

// ── boolean dehydration ──────────────────────────────────────────────

describe("where-value dehydration — boolean", () => {
    it("whereEq('done', false) binds 0", () => {
        const { sql, bindings } = new QueryBuilder(Task).whereEq("done", false).toSelectSql();
        expect(sql).toContain("done = ?");
        expect(bindings).toEqual([0]);
    });

    it("whereEq('done', true) binds 1", () => {
        const { bindings } = new QueryBuilder(Task).whereEq("done", true).toSelectSql();
        expect(bindings).toEqual([1]);
    });

    it("where('done', '!=', true) (comparison op) dehydrates to 1", () => {
        const { sql, bindings } = new QueryBuilder(Task).where("done", "!=", true).toSelectSql();
        expect(sql).toContain("done != ?");
        expect(bindings).toEqual([1]);
    });

    it("whereIn('done', [true, false]) binds [1, 0]", () => {
        const { sql, bindings } = new QueryBuilder(Task).whereIn("done", [true, false]).toSelectSql();
        expect(sql).toContain("done IN (?, ?)");
        expect(bindings).toEqual([1, 0]);
    });

    it("whereNotIn('done', [true]) binds [1]", () => {
        const { sql, bindings } = new QueryBuilder(Task).whereNotIn("done", [true]).toSelectSql();
        expect(sql).toContain("done NOT IN (?)");
        expect(bindings).toEqual([1]);
    });
});

// ── datetime dehydration ─────────────────────────────────────────────

describe("where-value dehydration — datetime", () => {
    it("whereBetween('due_at', [Date, Date]) binds the ISO strings", () => {
        const lo = new Date("2026-01-01T00:00:00.000Z");
        const hi = new Date("2026-12-31T23:59:59.000Z");
        const { sql, bindings } = new QueryBuilder(Task).whereBetween("due_at", [lo, hi]).toSelectSql();
        expect(sql).toContain("due_at BETWEEN ? AND ?");
        expect(bindings).toEqual([lo.toISOString(), hi.toISOString()]);
    });

    it("whereEq('due_at', Date) binds the ISO string", () => {
        const d = new Date("2026-05-30T12:00:00.000Z");
        const { bindings } = new QueryBuilder(Task).whereEq("due_at", d).toSelectSql();
        expect(bindings).toEqual([d.toISOString()]);
    });
});

// ── json dehydration (object-in → JSON string) ───────────────────────

describe("where-value dehydration — json", () => {
    it("whereEq('metadata', { a: 1 }) binds the JSON string", () => {
        const { bindings } = new QueryBuilder(Task).whereEq("metadata", { a: 1 }).toSelectSql();
        // The documented behaviour: pass the OBJECT, it dehydrates to the stored
        // JSON string. (Passing an already-stringified string would double-encode.)
        expect(bindings).toEqual([JSON.stringify({ a: 1 })]);
    });
});

// ── passthrough cases ────────────────────────────────────────────────

describe("where-value dehydration — passthrough", () => {
    it("uncast column passes through unchanged", () => {
        // `priority` has no cast on Task → raw value preserved.
        const { bindings } = new QueryBuilder(Task).whereEq("priority", true).toSelectSql();
        expect(bindings).toEqual([true]);
    });

    it("model with no casts is a no-op (boolean stays raw)", () => {
        const { bindings } = new QueryBuilder(Plain).whereEq("done", false).toSelectSql();
        expect(bindings).toEqual([false]);
    });

    it("table-only / no-model builder is a no-op", () => {
        const { bindings } = new QueryBuilder(tableOnlyCtor).whereEq("done", true).toSelectSql();
        expect(bindings).toEqual([true]);
    });

    it("qualified column (tasks.done) is NOT dehydrated", () => {
        const { sql, bindings } = new QueryBuilder(Task).whereEq("tasks.done", true).toSelectSql();
        expect(sql).toContain("tasks.done = ?");
        expect(bindings).toEqual([true]);
    });

    it("LIKE on a cast column is NOT dehydrated (pattern op preserved)", () => {
        // `due_at` is a datetime cast, but LIKE compares a text pattern — the
        // pattern string must survive verbatim.
        const { sql, bindings } = new QueryBuilder(Task).where("due_at", "LIKE", "2026-%").toSelectSql();
        expect(sql).toContain("due_at LIKE ?");
        expect(bindings).toEqual(["2026-%"]);
    });

    it("NOT LIKE on a cast column is NOT dehydrated", () => {
        const { bindings } = new QueryBuilder(Task).where("done", "NOT LIKE", "%x%").toSelectSql();
        expect(bindings).toEqual(["%x%"]);
    });

    it("null value passes through untouched (castSet no-ops on null)", () => {
        // whereEq with null on a cast column — castSet returns null unchanged.
        const { bindings } = new QueryBuilder(Task).whereEq("done", null).toSelectSql();
        expect(bindings).toEqual([null]);
    });

    it("whereBetween with a null bound leaves the null untouched", () => {
        const hi = new Date("2026-12-31T00:00:00.000Z");
        const { bindings } = new QueryBuilder(Task).whereBetween("due_at", [null, hi]).toSelectSql();
        expect(bindings).toEqual([null, hi.toISOString()]);
    });
});
