// setOperators.integration.test.ts
// Live D1 tests for intersect() / except() set operators.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BaseModel } from "../baseModel";

interface UserAttrs { id?: string; name?: string; active?: number; premium?: number }

class SoUser extends BaseModel<UserAttrs> {
    static table = "so_users";
    static timestamps = false;
}

interface SoftUserAttrs {
    id?: string;
    name?: string;
    active?: number;
    premium?: number;
    created_at?: string;
    updated_at?: string;
    deleted_at?: string;
}

class SoSoftUser extends BaseModel<SoftUserAttrs> {
    static table = "so_soft_users";
    static primaryKey = "id";
    static softDeletes = true;
    static timestamps = true;
    static timestampMode = "iso" as const;
}

beforeAll(async () => {
    await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS so_users (id TEXT PRIMARY KEY, name TEXT, active INTEGER, premium INTEGER)`,
    ).run();
    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS so_soft_users (
            id TEXT PRIMARY KEY,
            name TEXT,
            active INTEGER,
            premium INTEGER,
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT '',
            deleted_at TEXT
        )
    `).run();
});

beforeEach(async () => {
    await env.DB.prepare("DELETE FROM so_users").run();
    await env.DB.prepare("DELETE FROM so_soft_users").run();
    await SoUser.create(env.DB, { id: "u1", name: "both", active: 1, premium: 1 });
    await SoUser.create(env.DB, { id: "u2", name: "active-only", active: 1, premium: 0 });
    await SoUser.create(env.DB, { id: "u3", name: "premium-only", active: 0, premium: 1 });
});

describe("intersect()", () => {
    it("keeps rows present in both queries", async () => {
        const rows = await SoUser.query()
            .whereEq("active", 1)
            .intersect(SoUser.query().whereEq("premium", 1))
            .get(env.DB);
        expect(rows.map((r) => r.get("id"))).toEqual(["u1"]);
    });
});

describe("except()", () => {
    it("keeps rows in the first query that are absent from the second", async () => {
        const rows = await SoUser.query()
            .whereEq("active", 1)
            .except(SoUser.query().whereEq("premium", 1))
            .get(env.DB);
        expect(rows.map((r) => r.get("id"))).toEqual(["u2"]);
    });
});

describe("union still works (regression)", () => {
    it("combines and deduplicates", async () => {
        const rows = await SoUser.query()
            .whereEq("active", 1)
            .union(SoUser.query().whereEq("premium", 1))
            .get(env.DB);
        expect(rows.map((r) => r.get("id")).sort()).toEqual(["u1", "u2", "u3"]);
    });
});

describe("#49 intersect()/except() SQL compilation", () => {
    it("emits INTERSECT/EXCEPT keywords with bindings in primary-then-operand order", () => {
        const { sql, bindings } = SoUser.query()
            .whereEq("active", 7)
            .intersect(SoUser.query().whereEq("premium", 8))
            .except(SoUser.query().whereEq("name", "banned"))
            .toSelectSql();

        expect(sql).toContain("INTERSECT");
        expect(sql).toContain("EXCEPT");
        // Compound operators compile after the primary SELECT, in call order.
        expect(sql.indexOf("INTERSECT")).toBeGreaterThan(sql.indexOf("FROM so_users"));
        expect(sql.indexOf("INTERSECT")).toBeLessThan(sql.indexOf("EXCEPT"));
        // Primary WHERE binding first, then each operand's binding in chain order.
        expect(bindings).toEqual([7, 8, "banned"]);
    });
});

describe("#49 set operators respect soft-delete scoping", () => {
    beforeEach(async () => {
        // s1 matches both predicates; s2 matches both but is trashed;
        // s3 active-only; s4 premium-only. All non-trashed except s2.
        await SoSoftUser.create(env.DB, { id: "s1", name: "both", active: 1, premium: 1 });
        const s2 = await SoSoftUser.create(env.DB, { id: "s2", name: "trashed-both", active: 1, premium: 1 });
        await SoSoftUser.create(env.DB, { id: "s3", name: "active-only", active: 1, premium: 0 });
        await SoSoftUser.create(env.DB, { id: "s4", name: "premium-only", active: 0, premium: 1 });
        await s2.delete(env.DB);
    });

    it("intersect() injects the soft-delete scope into BOTH the primary query and the operand", () => {
        const { sql } = SoSoftUser.query()
            .whereEq("active", 1)
            .intersect(SoSoftUser.query().whereEq("premium", 1))
            .toSelectSql();
        // One `deleted_at IS NULL` for the primary query, one for the intersect operand.
        expect(sql.match(/deleted_at IS NULL/g)?.length).toBe(2);
    });

    it("intersect() excludes a trashed row that would otherwise match both operands", async () => {
        const rows = await SoSoftUser.query()
            .whereEq("active", 1)
            .intersect(SoSoftUser.query().whereEq("premium", 1))
            .get(env.DB);
        const ids = rows.map((r) => r.get("id"));
        expect(ids).toEqual(["s1"]);
        expect(ids).not.toContain("s2");
    });

    it("except() injects the soft-delete scope into BOTH the primary query and the operand", () => {
        const { sql } = SoSoftUser.query()
            .whereEq("active", 1)
            .except(SoSoftUser.query().whereEq("premium", 1))
            .toSelectSql();
        expect(sql.match(/deleted_at IS NULL/g)?.length).toBe(2);
    });

    it("except() operand excludes trashed rows, keeping active-only live rows", async () => {
        const rows = await SoSoftUser.query()
            .whereEq("active", 1)
            .except(SoSoftUser.query().whereEq("premium", 1))
            .get(env.DB);
        const ids = rows.map((r) => r.get("id"));
        // active(non-trashed)={s1,s3} EXCEPT premium(non-trashed)={s1,s4} = {s3};
        // s2 is trashed so it never appears via either operand.
        expect(ids).toEqual(["s3"]);
        expect(ids).not.toContain("s2");
    });
});
