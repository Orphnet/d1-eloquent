// jsonField.integration.test.ts
// Live D1 integration tests for the new t.json() column type and the
// JSON query helpers (whereJsonPath, whereJsonContains, whereJsonLength,
// selectJsonExtract).

import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { Schema } from "../../scripts/schema";
import { QueryBuilder } from "../queryBuilder";
import { BaseModel } from "../baseModel";

interface DocAttrs {
    id: string;
    title: string;
    config: { role: string; level: number; flags?: string[] } | null;
    tags: string[];
    created_at?: Date;
    updated_at?: Date;
}

class Doc extends BaseModel<DocAttrs> {
    static table = "json_docs";
    static primaryKey = "id";
    static timestamps = false;
    static casts = {
        config: "json" as const,
        tags: "array" as const,
    };
}

beforeAll(async () => {
    const schema = new Schema();
    schema.dropTable("json_docs");
    schema.createTable("json_docs", (t) => {
        t.id();
        t.text("title");
        t.json("config", { validate: true });
        t.json("tags");
    });

    for (const stmt of schema.toStatements()) {
        await env.DB.prepare(stmt).run();
    }

    const rows = [
        {
            id: "d1",
            title: "Admin doc",
            config: { role: "admin", level: 10, flags: ["alpha", "beta"] },
            tags: ["work", "important"],
        },
        {
            id: "d2",
            title: "User doc",
            config: { role: "user", level: 3, flags: ["beta"] },
            tags: ["work"],
        },
        {
            id: "d3",
            title: "Guest doc",
            config: { role: "guest", level: 1 },
            tags: ["personal", "draft", "todo"],
        },
    ];

    for (const r of rows) {
        await env.DB
            .prepare(`INSERT INTO json_docs (id, title, config, tags) VALUES (?, ?, ?, ?)`)
            .bind(r.id, r.title, JSON.stringify(r.config), JSON.stringify(r.tags))
            .run();
    }
});

describe("t.json() — schema validation via CHECK constraint", () => {
    it("accepts valid JSON values", async () => {
        const res = await env.DB
            .prepare(`INSERT INTO json_docs (id, title, config, tags) VALUES (?, ?, ?, ?)`)
            .bind("dx", "Extra", JSON.stringify({ ok: true }), "[]")
            .run();
        expect(res.success).toBe(true);
    });

    it("rejects malformed JSON via json_valid CHECK", async () => {
        let threw = false;
        try {
            await env.DB
                .prepare(`INSERT INTO json_docs (id, title, config, tags) VALUES (?, ?, ?, ?)`)
                .bind("dxbad", "bad", "{not valid json", "[]")
                .run();
        } catch {
            threw = true;
        }
        expect(threw).toBe(true);
    });
});

describe("whereJsonPath against real D1", () => {
    it("filters by a top-level path equality", async () => {
        const rows = await new QueryBuilder(Doc as any)
            .whereJsonPath("config", "$.role", "=", "admin")
            .get(env.DB);
        expect(rows.length).toBe(1);
        expect((rows[0] as any).toObject().id).toBe("d1");
    });

    it("filters by a numeric comparison", async () => {
        const rows = await new QueryBuilder(Doc as any)
            .whereJsonPath("config", "$.level", ">=", 3)
            .get(env.DB);
        expect(rows.length).toBe(2);
    });
});

describe("whereJsonContains against real D1", () => {
    it("matches array membership directly on a JSON-array column", async () => {
        const rows = await new QueryBuilder(Doc as any)
            .whereJsonContains("tags", "important")
            .get(env.DB);
        expect(rows.length).toBe(1);
        expect((rows[0] as any).toObject().id).toBe("d1");
    });

    it("matches nested array membership via path", async () => {
        const rows = await new QueryBuilder(Doc as any)
            .whereJsonContains("config", "alpha", "$.flags")
            .get(env.DB);
        expect(rows.length).toBe(1);
        expect((rows[0] as any).toObject().id).toBe("d1");
    });
});

describe("whereJsonLength against real D1", () => {
    it("filters by array length", async () => {
        const rows = await new QueryBuilder(Doc as any)
            .whereJsonLength("tags", ">=", 2)
            .get(env.DB);
        // d1 has 2 tags, d3 has 3 tags
        expect(rows.length).toBe(2);
    });
});

describe("selectJsonExtract against real D1", () => {
    it("returns extracted scalar values as a column", async () => {
        const rows = await new QueryBuilder(Doc as any)
            .select(["id"])
            .selectJsonExtract("config", "$.role", "role")
            .get(env.DB);
        const map = Object.fromEntries(
            rows.map((r: any) => [r.toObject().id as string, r.toObject().role as string]),
        );
        expect(map["d1"]).toBe("admin");
        expect(map["d2"]).toBe("user");
        expect(map["d3"]).toBe("guest");
    });
});

describe("json cast — round-trip through model.create/find", () => {
    it("hydrates the JSON column back to a plain object", async () => {
        const fetched = await Doc.find(env.DB, "d1");
        expect(fetched).not.toBeNull();
        const config = (fetched as any).get("config");
        expect(config).toEqual({ role: "admin", level: 10, flags: ["alpha", "beta"] });
        const tags = (fetched as any).get("tags");
        expect(tags).toEqual(["work", "important"]);
    });
});
