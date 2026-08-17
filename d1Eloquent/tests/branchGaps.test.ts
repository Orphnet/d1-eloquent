// branchGaps.test.ts
// Targeted tests to close remaining branch coverage gaps

import { describe, it, expect } from "vitest";
import { ModelRevision } from "../modelRevision";
import { Collection } from "../collection";
import { BaseModel } from "../baseModel";
import { Attribute } from "../attribute";
import { createModelProxy } from "../proxy";

// ── ModelRevision: before/after catch-block branches with missing fields ──

describe("ModelRevision ?? branches in catch blocks", () => {
    it("before getter uses 'unknown' fallback when fields are missing", () => {
        const rev = new ModelRevision({
            before_json: "invalid",
            created_at: "2025-01-01T00:00:00.000Z",
        } as any);
        expect(() => rev.before).toThrow(/unknown.*unknown.*unknown/);
    });

    it("after getter uses 'unknown' fallback when fields are missing", () => {
        const rev = new ModelRevision({
            after_json: "invalid",
            created_at: "2025-01-01T00:00:00.000Z",
        } as any);
        expect(() => rev.after).toThrow(/unknown.*unknown.*unknown/);
    });

    it("before getter with valid fields shows correct identifiers in error", () => {
        const rev = new ModelRevision({
            id: "r1",
            model_table: "t",
            model_id: "m1",
            before_json: "{bad",
            created_at: "2025-01-01T00:00:00.000Z",
        } as any);
        expect(() => rev.before).toThrow(/r1.*t.*m1/);
    });

    it("after getter with valid fields shows correct identifiers in error", () => {
        const rev = new ModelRevision({
            id: "r2",
            model_table: "t2",
            model_id: "m2",
            after_json: "{bad",
            created_at: "2025-01-01T00:00:00.000Z",
        } as any);
        expect(() => rev.after).toThrow(/r2.*t2.*m2/);
    });
});

// ── Collection: sortBy branch gaps (null on one side only) ───────────

describe("Collection.sortBy branch gaps", () => {
    it("va not null, vb null in ascending → null sorts first", () => {
        const col = Collection.from([
            { get: (k: string) => k === "x" ? "A" : null },
            { get: (k: string) => k === "x" ? null : null },
        ]);
        const sorted = col.sortBy("x", "asc");
        // null sorts before non-null in ascending
        expect((sorted[0] as any).get("x")).toBeNull();
        expect((sorted[1] as any).get("x")).toBe("A");
    });

    it("va not null, vb null in descending → non-null sorts first", () => {
        const col = Collection.from([
            { get: (k: string) => k === "x" ? null : null },
            { get: (k: string) => k === "x" ? "A" : null },
        ]);
        const sorted = col.sortBy("x", "desc");
        expect((sorted[0] as any).get("x")).toBe("A");
    });

    it("va > vb in ascending", () => {
        const col = Collection.from([
            { get: (k: string) => k === "x" ? "B" : null },
            { get: (k: string) => k === "x" ? "A" : null },
        ]);
        const sorted = col.sortBy("x", "asc");
        expect((sorted[0] as any).get("x")).toBe("A");
    });

    it("va > vb in descending", () => {
        const col = Collection.from([
            { get: (k: string) => k === "x" ? "A" : null },
            { get: (k: string) => k === "x" ? "B" : null },
        ]);
        const sorted = col.sortBy("x", "desc");
        expect((sorted[0] as any).get("x")).toBe("B");
    });

    it("_extractKey returns undefined for non-object items", () => {
        const col = Collection.from([1, 2, 3] as any[]);
        const sorted = col.sortBy("x");
        expect(sorted.length).toBe(3);
    });
});

// ── Proxy: ownKeys with appends and getOwnPropertyDescriptor gaps ────

describe("Proxy ownKeys/getOwnPropertyDescriptor branch gaps", () => {
    class WithAppends extends BaseModel<{ id?: string; name?: string }> {
        static table = "test";
        static primaryKey = "id";
        static timestamps = false;
        static accessors = {
            fullName: Attribute.get(() => "Full Name"),
        };
        static appends = ["fullName"];
    }

    it("ownKeys includes appended virtual keys", () => {
        const m = new WithAppends({ id: "1", name: "A" });
        const p = m.asProxy();
        const keys = Object.keys(p);
        expect(keys).toContain("fullName");
        expect(keys).toContain("id");
        expect(keys).toContain("name");
    });

    it("has returns true for appended key", () => {
        const m = new WithAppends({ id: "1" });
        const p = m.asProxy();
        expect("fullName" in p).toBe(true);
    });

    it("getOwnPropertyDescriptor returns enumerable for appended key", () => {
        const m = new WithAppends({ id: "1" });
        const p = m.asProxy();
        const desc = Object.getOwnPropertyDescriptor(p, "fullName");
        expect(desc?.enumerable).toBe(true);
        expect(desc?.value).toBe("Full Name");
    });

    it("getOwnPropertyDescriptor for attr key", () => {
        const m = new WithAppends({ id: "1", name: "Test" });
        const p = m.asProxy();
        const desc = Object.getOwnPropertyDescriptor(p, "name");
        expect(desc?.enumerable).toBe(true);
        expect(desc?.value).toBe("Test");
    });

    it("getOwnPropertyDescriptor for symbol returns undefined", () => {
        const m = new WithAppends({ id: "1" });
        const p = m.asProxy();
        const desc = Object.getOwnPropertyDescriptor(p, Symbol("test") as any);
        expect(desc).toBeUndefined();
    });

    it("JSON.stringify of proxy with appends includes virtual keys", () => {
        const m = new WithAppends({ id: "1", name: "A" });
        const p = m.asProxy();
        const json = JSON.parse(JSON.stringify(p));
        expect(json.fullName).toBe("Full Name");
    });

    it("spread operator on proxy includes attr and virtual keys", () => {
        const m = new WithAppends({ id: "1", name: "A" });
        const p = m.asProxy();
        const spread = { ...p };
        expect(spread.id).toBe("1");
    });
});

// ── AccessorManager branch gap (line 49 — no accessors) ─────────────

describe("AccessorManager edge cases", () => {
    class NoAccessors extends BaseModel<{ id?: string }> {
        static table = "test";
        static primaryKey = "id";
        static timestamps = false;
    }

    it("model without accessors can still proxy", () => {
        const m = new NoAccessors({ id: "1" });
        const p = m.asProxy();
        expect((p as any).id).toBe("1");
    });
});

// ── BaseModel: static meta helpers (functions branch coverage) ───────

describe("BaseModel static meta helpers", () => {
    class TestModel extends BaseModel<{ id?: string; name?: string }> {
        static table = "meta_test";
        static primaryKey = "id";
        static timestamps = false;
    }

    it("getTable returns table name", () => {
        expect(TestModel.getTable()).toBe("meta_test");
    });

    it("getKeyName returns primary key name", () => {
        expect(TestModel.getKeyName()).toBe("id");
    });

    it("getPrimaryKeyName returns primary key name", () => {
        expect(TestModel.getPrimaryKeyName()).toBe("id");
    });
});

// ── BaseModel: constructor with null attrs ───────────────────────────

describe("BaseModel constructor branches", () => {
    class TestModel extends BaseModel<{ id?: string }> {
        static table = "test";
        static primaryKey = "id";
        static timestamps = false;
    }

    it("constructs with undefined attrs", () => {
        const m = new TestModel();
        expect(m.get("id")).toBeUndefined();
    });

    it("constructs with empty object", () => {
        const m = new TestModel({});
        expect(m.get("id")).toBeUndefined();
    });

    it("getKey returns null when no key set", () => {
        const m = new TestModel();
        expect(m.getKey()).toBeNull();
    });

    it("exists returns true when key is set", () => {
        const m = new TestModel({ id: "1" });
        expect(m.exists()).toBe(true);
    });

    it("exists returns false when key is not set", () => {
        const m = new TestModel();
        expect(m.exists()).toBe(false);
    });

    it("clearAccessorCache works on fresh model", () => {
        const m = new TestModel({ id: "1" });
        m.clearAccessorCache(); // should not throw
    });
});

// ── QueryBuilder: whereGroup with empty callback ─────────────────────

import { QueryBuilder } from "../queryBuilder";

describe("QueryBuilder empty group", () => {
    class Q {
        static table = "q";
        static primaryKey = "id";
        static softDeletes = false;
        attrs: Record<string, unknown>;
        constructor(attrs: Record<string, unknown> = {}) { this.attrs = attrs; }
        toObject() { return this.attrs; }
    }

    it("whereGroup with empty callback produces (1=1)", () => {
        const qb = new QueryBuilder(Q);
        qb.whereGroup(() => {});
        const { sql } = qb.toSelectSql();
        expect(sql).toContain("(1=1)");
    });

    it("orWhereGroup with empty callback produces (1=1)", () => {
        const qb = new QueryBuilder(Q);
        qb.where("a", "=", 1).orWhereGroup(() => {});
        const { sql } = qb.toSelectSql();
        expect(sql).toContain("OR (1=1)");
    });
});
