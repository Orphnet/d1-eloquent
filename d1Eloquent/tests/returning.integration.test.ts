// returning.integration.test.ts
// Live D1 (miniflare) tests for the RETURNING-clause builders.

import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { Schema } from "../../scripts/schema";
import { QueryBuilder } from "../queryBuilder";
import { BaseModel } from "../baseModel";

interface ItemAttrs {
    id: string;
    name: string;
    qty: number;
    /** computed at write time from qty * 2 via DEFAULT */
    doubled: number;
    created_at?: Date;
    updated_at?: Date;
}

class Item extends BaseModel<ItemAttrs> {
    static table = "ret_items";
    static primaryKey = "id";
    static timestamps = false;
}

beforeAll(async () => {
    const schema = new Schema();
    schema.dropTable("ret_items");
    schema.createTable("ret_items", (t) => {
        t.id();
        t.text("name").notNull();
        t.integer("qty").default(0);
        // Stored generated column — value computed by SQLite, not the ORM
        t.integer("doubled").generatedAs("qty * 2", "stored");
    });
    for (const stmt of schema.toStatements()) {
        await env.DB.prepare(stmt).run();
    }
});

describe("insertReturning against live D1", () => {
    it("returns the inserted row including server-computed columns", async () => {
        const row = await new QueryBuilder(Item as any).insertReturning(env.DB, {
            id: "r1",
            name: "Widget",
            qty: 5,
        });
        expect(row).not.toBeNull();
        expect(row?.id).toBe("r1");
        expect(row?.name).toBe("Widget");
        expect(row?.qty).toBe(5);
        expect(row?.doubled).toBe(10);
    });

    it("respects RETURNING column subset", async () => {
        const row = await new QueryBuilder(Item as any).insertReturning(
            env.DB,
            { id: "r2", name: "Gear", qty: 3 },
            ["id", "doubled"],
        );
        expect(Object.keys(row ?? {}).sort()).toEqual(["doubled", "id"]);
        expect(row?.doubled).toBe(6);
    });
});

describe("updateReturning against live D1", () => {
    it("returns the rows after update (with computed column refreshed)", async () => {
        await env.DB.prepare(`INSERT INTO ret_items (id, name, qty) VALUES (?, ?, ?)`).bind("r3", "A", 1).run();
        const rows = await new QueryBuilder(Item as any)
            .whereEq("id", "r3")
            .updateReturning(env.DB, { qty: 10 });
        expect(rows.length).toBe(1);
        expect(rows[0].qty).toBe(10);
        expect(rows[0].doubled).toBe(20);
    });

    it("returns multiple rows when the WHERE matches multiple", async () => {
        await env.DB.prepare(`INSERT INTO ret_items (id, name, qty) VALUES (?, ?, ?)`).bind("rm1", "Bulk", 1).run();
        await env.DB.prepare(`INSERT INTO ret_items (id, name, qty) VALUES (?, ?, ?)`).bind("rm2", "Bulk", 2).run();
        const rows = await new QueryBuilder(Item as any)
            .whereEq("name", "Bulk")
            .updateReturning(env.DB, { qty: 99 }, ["id", "qty"]);
        expect(rows.length).toBe(2);
        expect(rows.every((r) => r.qty === 99)).toBe(true);
    });
});

describe("deleteReturning against live D1", () => {
    it("returns the deleted rows", async () => {
        await env.DB.prepare(`INSERT INTO ret_items (id, name, qty) VALUES (?, ?, ?)`).bind("r4", "X", 7).run();
        const rows = await new QueryBuilder(Item as any)
            .whereEq("id", "r4")
            .deleteReturning(env.DB, ["id", "doubled"]);
        expect(rows.length).toBe(1);
        expect(rows[0].id).toBe("r4");
        expect(rows[0].doubled).toBe(14);
    });

    it("returns [] when nothing matches", async () => {
        const rows = await new QueryBuilder(Item as any)
            .whereEq("id", "nope")
            .deleteReturning(env.DB);
        expect(rows).toEqual([]);
    });
});
