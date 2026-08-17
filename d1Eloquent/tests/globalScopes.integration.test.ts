// globalScopes.integration.test.ts
// Live D1 tests for user-defined static globalScopes + withoutGlobalScope(s).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BaseModel } from "../baseModel";
import type { QueryBuilder } from "../queryBuilder";

interface DocAttrs { id?: string; tenant?: string; title?: string }

let currentTenant = "t1";

class GsDoc extends BaseModel<DocAttrs> {
    static table = "gs_docs";
    static timestamps = false;
    static globalScopes = {
        tenant: (q: QueryBuilder<GsDoc>) => q.whereEq("tenant", currentTenant),
    };
}

beforeAll(async () => {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS gs_docs (id TEXT PRIMARY KEY, tenant TEXT, title TEXT)`).run();
});

beforeEach(async () => {
    currentTenant = "t1";
    await env.DB.prepare("DELETE FROM gs_docs").run();
    await GsDoc.create(env.DB, { id: "d1", tenant: "t1", title: "A" });
    await GsDoc.create(env.DB, { id: "d2", tenant: "t1", title: "B" });
    await GsDoc.create(env.DB, { id: "d3", tenant: "t2", title: "A" });
});

const ids = (rows: GsDoc[]) => rows.map((r) => r.get("id")).sort();

describe("global scopes", () => {
    it("auto-applies to every query", async () => {
        const rows = await GsDoc.query().get(env.DB);
        expect(ids(rows)).toEqual(["d1", "d2"]); // t1 only
    });

    it("tracks external context (tenant switch)", async () => {
        currentTenant = "t2";
        const rows = await GsDoc.query().get(env.DB);
        expect(ids(rows)).toEqual(["d3"]);
    });

    it("withoutGlobalScope(name) skips it", async () => {
        const rows = await GsDoc.query().withoutGlobalScope("tenant").get(env.DB);
        expect(ids(rows)).toEqual(["d1", "d2", "d3"]);
    });

    it("withoutGlobalScopes() skips all", async () => {
        const rows = await GsDoc.query().withoutGlobalScopes().get(env.DB);
        expect(ids(rows)).toEqual(["d1", "d2", "d3"]);
    });

    it("composes (AND) with user where clauses", async () => {
        const rows = await GsDoc.query().whereEq("title", "A").get(env.DB);
        expect(ids(rows)).toEqual(["d1"]); // t1 AND title A (not d3 which is t2)
    });

    it("stays scoped when the user query has a top-level OR (no cross-tenant leak)", async () => {
        const rows = await GsDoc.query().whereEq("title", "A").orWhere("title", "=", "B").get(env.DB);
        // (title A OR B) AND tenant=t1 → d1, d2 — must NOT leak d3 (t2, title A)
        expect(ids(rows)).toEqual(["d1", "d2"]);
    });

    it("is applied to count() as well", async () => {
        expect(await GsDoc.query().count(env.DB)).toBe(2);
        expect(await GsDoc.query().withoutGlobalScopes().count(env.DB)).toBe(3);
    });
});

describe("global scopes — bulk writes are tenant-isolated", () => {
    it("update() only touches the current tenant's rows", async () => {
        const n = await GsDoc.query().update(env.DB, { title: "Z" });
        expect(n).toBe(2); // d1, d2 (t1) — NOT d3 (t2)
        // d3 (t2) untouched
        const d3 = await GsDoc.query().withoutGlobalScopes().whereEq("id", "d3").first(env.DB);
        expect(d3!.get("title")).toBe("A");
    });

    it("delete() only removes the current tenant's rows (no bare DELETE)", async () => {
        const n = await GsDoc.query().delete(env.DB);
        expect(n).toBe(2); // only t1 docs
        const survivors = await GsDoc.query().withoutGlobalScopes().get(env.DB);
        expect(ids(survivors)).toEqual(["d3"]); // t2 doc survives
    });

    it("a scoped write with a top-level OR does not leak across tenants", async () => {
        const n = await GsDoc.query().whereEq("title", "A").orWhere("title", "=", "B").delete(env.DB);
        expect(n).toBe(2); // (A OR B) AND tenant=t1 → d1, d2 — must NOT delete d3 (t2, title A)
        const survivors = await GsDoc.query().withoutGlobalScopes().get(env.DB);
        expect(ids(survivors)).toEqual(["d3"]);
    });

    it("withoutGlobalScopes() lets a write deliberately reach every row", async () => {
        const n = await GsDoc.query().withoutGlobalScopes().delete(env.DB);
        expect(n).toBe(3); // all tenants
    });

    // Regression (#51): global scopes must NOT bleed into a model's OWN instance
    // save()/delete() by PK. A row loaded outside the current scope would otherwise
    // compile to `WHERE id = ? AND (tenant = ?)`, silently match nothing, and no-op.
    it("instance save() persists a row loaded outside the current scope", async () => {
        const d3 = await GsDoc.query().withoutGlobalScopes().whereEq("id", "d3").first(env.DB); // t2, current=t1
        d3!.set("title", "Z");
        await d3!.save(env.DB);
        const reread = await GsDoc.query().withoutGlobalScopes().whereEq("id", "d3").first(env.DB);
        expect(reread!.get("title")).toBe("Z"); // before fix: still "A" (scoped-out no-op)
    });

    it("instance delete() removes a row loaded outside the current scope", async () => {
        const d3 = await GsDoc.query().withoutGlobalScopes().whereEq("id", "d3").first(env.DB); // t2, current=t1
        const ok = await d3!.delete(env.DB);
        expect(ok).toBe(true); // before fix: false (scoped-out no-op)
        expect(await GsDoc.query().withoutGlobalScopes().whereEq("id", "d3").first(env.DB)).toBeNull();
    });
});
