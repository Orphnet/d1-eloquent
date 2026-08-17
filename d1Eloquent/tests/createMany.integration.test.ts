// createMany.integration.test.ts
// Live D1 integration tests for Model.createMany().

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Schema } from "../../scripts/schema";
import { BaseModel } from "../baseModel";
import type { THooks } from "../hookTypes";

interface UserAttrs {
    id: string;
    name: string;
    email: string;
    slug?: string | null;
    role?: string | null;
    is_admin?: boolean;
    metadata?: Record<string, unknown> | null;
    created_at?: string;
    updated_at?: string;
}

class CmUser extends BaseModel<UserAttrs> {
    static table = "cm_users";
    static primaryKey = "id";
    static timestamps = true;
    static casts = { is_admin: "boolean", metadata: "json" } as const;

    static hooks: THooks<CmUser> = {
        creating: (m: any) => {
            // Mutator-like behaviour: auto-derive a slug if missing
            if (m.get("slug") == null) {
                const name = m.get("name") as string | null;
                m.set("slug", name ? name.toLowerCase().replaceAll(" ", "-") : null);
            }
        },
    };
}

class CmFilteredUser extends BaseModel<UserAttrs> {
    static table = "cm_users";
    static primaryKey = "id";
    static timestamps = true;
    static casts = { is_admin: "boolean", metadata: "json" } as const;

    static hooks: THooks<CmFilteredUser> = {
        creating: (m: any) => {
            // Reject rows whose role is 'bad'
            if (m.get("role") === "bad") return false;
        },
    };
}

beforeAll(async () => {
    const schema = new Schema();
    schema.dropTable("cm_users");
    schema.createTable("cm_users", (t) => {
        t.id();
        t.text("name").notNull();
        t.text("email").notNull();
        t.text("slug");
        t.text("role");
        t.boolean("is_admin", { default: false });
        t.json("metadata");
        t.timestamps();
    });
    for (const stmt of schema.toStatements()) await env.DB.prepare(stmt).run();
});

beforeEach(async () => {
    await env.DB.prepare("DELETE FROM cm_users").run();
});

describe("Model.createMany() — happy path", () => {
    it("inserts all rows and returns proxy-wrapped instances", async () => {
        const users = await CmUser.createMany(env.DB, [
            { id: "u1", name: "Alice", email: "a@x.com" },
            { id: "u2", name: "Bob", email: "b@x.com" },
            { id: "u3", name: "Carol", email: "c@x.com" },
        ]);

        expect(users.length).toBe(3);
        // Proxy access works on the returned instances
        expect((users[0] as any).name).toBe("Alice");
        expect((users[2] as any).email).toBe("c@x.com");

        // All rows are actually in the DB
        const count = await CmUser.query().count(env.DB);
        expect(count).toBe(3);
    });

    it("runs the creating hook on every row (slug auto-derived)", async () => {
        const users = await CmUser.createMany(env.DB, [
            { id: "u1", name: "Alice Wonder", email: "a@x.com" },
            { id: "u2", name: "Bob Jones", email: "b@x.com" },
        ]);

        const slugs = users.map((u: any) => u.get("slug")).sort();
        expect(slugs).toEqual(["alice-wonder", "bob-jones"]);
    });

    it("applies timestamps to every row", async () => {
        const users = await CmUser.createMany(env.DB, [
            { id: "u1", name: "Alice", email: "a@x.com" },
            { id: "u2", name: "Bob", email: "b@x.com" },
        ]);
        for (const u of users) {
            expect((u as any).get("created_at")).toBeTruthy();
            expect((u as any).get("updated_at")).toBeTruthy();
        }
    });

    it("applies casts (boolean / json) on insert", async () => {
        await CmUser.createMany(env.DB, [
            {
                id: "u1",
                name: "Alice",
                email: "a@x.com",
                is_admin: true,
                metadata: { plan: "pro", flags: [1, 2] },
            },
        ]);

        const row = await env.DB
            .prepare("SELECT is_admin, metadata FROM cm_users WHERE id = ?")
            .bind("u1")
            .first<{ is_admin: number; metadata: string }>();
        expect(row?.is_admin).toBe(1);
        expect(JSON.parse(row?.metadata ?? "{}")).toEqual({ plan: "pro", flags: [1, 2] });
    });

    it("returns persisted instances with _persisted = true", async () => {
        const users = await CmUser.createMany(env.DB, [
            { id: "u1", name: "Alice", email: "a@x.com" },
        ]);
        expect((users[0] as any).$model?._persisted ?? (users[0] as any)._persisted).toBe(true);
    });
});

describe("Model.createMany() — edge cases", () => {
    it("returns an empty array for an empty input", async () => {
        const users = await CmUser.createMany(env.DB, []);
        expect(users).toEqual([]);
    });

    it("filters out rows whose creating hook returns false", async () => {
        const users = await CmFilteredUser.createMany(env.DB, [
            { id: "u1", name: "Alice", email: "a@x.com", role: "good" },
            { id: "u2", name: "Bob", email: "b@x.com", role: "bad" },
            { id: "u3", name: "Carol", email: "c@x.com", role: "good" },
        ]);
        expect(users.length).toBe(2);
        const ids = users.map((u: any) => u.get("id")).sort();
        expect(ids).toEqual(["u1", "u3"]);

        const dbCount = await CmFilteredUser.query().count(env.DB);
        expect(dbCount).toBe(2);
    });

    it("throws when revisions are enabled without skipRevisions opt-in", async () => {
        class CmRevised extends BaseModel<UserAttrs> {
            static table = "cm_users";
            static primaryKey = "id";
            static revisions = { enabled: true, mode: "diff+after" as const };
        }
        await expect(
            CmRevised.createMany(env.DB, [{ id: "u1", name: "A", email: "a@x.com" }]),
        ).rejects.toThrow(/createMany.*will not write revisions/);
    });

    it("bulk-inserts when skipRevisions is explicitly passed", async () => {
        class CmRevisedOptIn extends BaseModel<UserAttrs> {
            static table = "cm_users";
            static primaryKey = "id";
            static revisions = { enabled: true, mode: "diff+after" as const };
        }
        const users = await CmRevisedOptIn.createMany(
            env.DB,
            [{ id: "u1", name: "A", email: "a@x.com" }],
            { skipRevisions: true },
        );
        expect(users.length).toBe(1);
    });
});
