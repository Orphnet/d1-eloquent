// convenience.integration.test.ts
// Integration tests for firstOrCreate, firstOrNew, updateOrCreate, fillable/guarded

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BaseModel } from "../baseModel";

// ── Models ───────────────────────────────────────────────────────────

interface UserAttrs {
    id?: string;
    email?: string;
    name?: string;
    role?: string;
    created_at?: string | Date;
    updated_at?: string | Date;
}

class User extends BaseModel<UserAttrs> {
    static table = "conv_users";
    static primaryKey = "id";
    static timestamps = true;
}

class GuardedUser extends BaseModel<UserAttrs> {
    static table = "conv_users";
    static primaryKey = "id";
    static timestamps = true;
    static guarded = ["id", "role"];
}

class FillableUser extends BaseModel<UserAttrs> {
    static table = "conv_users";
    static primaryKey = "id";
    static timestamps = true;
    static fillable = ["name", "email"];
}

// ── Schema ───────────────────────────────────────────────────────────

beforeAll(async () => {
    await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS conv_users (
            id TEXT PRIMARY KEY,
            email TEXT,
            name TEXT,
            role TEXT NOT NULL DEFAULT 'user',
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT ''
        )
    `).run();
});

afterAll(async () => {
    await env.DB.prepare("DROP TABLE IF EXISTS conv_users").run();
});

beforeEach(async () => {
    await env.DB.prepare("DELETE FROM conv_users").run();
});

// ── firstOrCreate ───────────────────────────────────────────────────

describe("firstOrCreate()", () => {
    it("creates when no match exists", async () => {
        const user = await User.firstOrCreate(env.DB,
            { email: "alice@example.com" },
            { id: "u1", name: "Alice" },
        );
        expect(user.get("email")).toBe("alice@example.com");
        expect(user.get("name")).toBe("Alice");
        expect(user._persisted).toBe(true);

        // Verify in DB
        const loaded = await User.find(env.DB, "u1");
        expect(loaded).not.toBeNull();
        expect(loaded!.get("email")).toBe("alice@example.com");
    });

    it("returns existing when match found", async () => {
        await User.create(env.DB, { id: "u2", email: "bob@example.com", name: "Bob" });

        const user = await User.firstOrCreate(env.DB,
            { email: "bob@example.com" },
            { id: "u99", name: "New Bob" },
        );
        // Should return existing, not create new
        expect(user.get("id")).toBe("u2");
        expect(user.get("name")).toBe("Bob");

        // Verify no extra rows
        const count = await User.query().count(env.DB);
        expect(count).toBe(1);
    });

    it("searches by multiple keys", async () => {
        await User.create(env.DB, { id: "u3", email: "carol@example.com", name: "Carol", role: "admin" });

        // Search by email + role — should match
        const found = await User.firstOrCreate(env.DB,
            { email: "carol@example.com", role: "admin" },
            { id: "u99", name: "New" },
        );
        expect(found.get("id")).toBe("u3");

        // Search by email + different role — should create
        const created = await User.firstOrCreate(env.DB,
            { email: "carol@example.com", role: "editor" },
            { id: "u4", name: "Carol Editor" },
        );
        expect(created.get("id")).toBe("u4");
    });
});

// ── firstOrNew ──────────────────────────────────────────────────────

describe("firstOrNew()", () => {
    it("creates unpersisted instance when no match", async () => {
        const user = await User.firstOrNew(env.DB,
            { email: "dave@example.com" },
            { id: "u5", name: "Dave" },
        );
        expect(user.get("email")).toBe("dave@example.com");
        expect(user.get("name")).toBe("Dave");
        expect(user._persisted).toBe(false);

        // Not in DB
        const count = await User.query().count(env.DB);
        expect(count).toBe(0);
    });

    it("returns existing when match found", async () => {
        await User.create(env.DB, { id: "u6", email: "eve@example.com", name: "Eve" });

        const user = await User.firstOrNew(env.DB,
            { email: "eve@example.com" },
            { id: "u99", name: "New Eve" },
        );
        expect(user.get("id")).toBe("u6");
        expect(user._persisted).toBe(true);
    });

    it("unpersisted instance can be saved later", async () => {
        const user = await User.firstOrNew(env.DB,
            { email: "frank@example.com" },
            { id: "u7", name: "Frank" },
        );
        expect(user._persisted).toBe(false);

        await user.save(env.DB);
        expect(user._persisted).toBe(true);

        const loaded = await User.find(env.DB, "u7");
        expect(loaded!.get("name")).toBe("Frank");
    });
});

// ── updateOrCreate ──────────────────────────────────────────────────

describe("updateOrCreate()", () => {
    it("creates when no match exists", async () => {
        const user = await User.updateOrCreate(env.DB,
            { email: "grace@example.com" },
            { id: "u8", name: "Grace", role: "admin" },
        );
        expect(user.get("name")).toBe("Grace");
        expect(user.get("role")).toBe("admin");
        expect(user._persisted).toBe(true);
    });

    it("updates existing when match found", async () => {
        await User.create(env.DB, { id: "u9", email: "hank@example.com", name: "Hank", role: "user" });

        const user = await User.updateOrCreate(env.DB,
            { email: "hank@example.com" },
            { name: "Hank Updated", role: "admin" },
        );
        expect(user.get("id")).toBe("u9");
        expect(user.get("name")).toBe("Hank Updated");
        expect(user.get("role")).toBe("admin");

        // Verify persisted
        const loaded = await User.find(env.DB, "u9");
        expect(loaded!.get("name")).toBe("Hank Updated");
        expect(loaded!.get("role")).toBe("admin");
    });

    it("only creates one row on multiple calls", async () => {
        await User.updateOrCreate(env.DB, { email: "iris@example.com" }, { id: "u10", name: "Iris" });
        await User.updateOrCreate(env.DB, { email: "iris@example.com" }, { name: "Iris Updated" });

        const count = await User.query().whereEq("email", "iris@example.com").count(env.DB);
        expect(count).toBe(1);

        const loaded = await User.find(env.DB, "u10");
        expect(loaded!.get("name")).toBe("Iris Updated");
    });
});

// ── fillable / guarded ──────────────────────────────────────────────

describe("fill() with guarded", () => {
    it("skips guarded fields during fill", () => {
        const user = new GuardedUser();
        user.fill({ id: "u20", name: "Test", email: "test@example.com", role: "admin" } as any);

        // id and role are guarded, should not be set
        expect(user.get("id")).toBeUndefined();
        expect(user.get("role")).toBeUndefined();
        expect(user.get("name")).toBe("Test");
        expect(user.get("email")).toBe("test@example.com");
    });

    it("forceFill bypasses guarded", () => {
        const user = new GuardedUser();
        user.forceFill({ id: "u21", name: "Test", role: "admin" } as any);

        expect(user.get("id")).toBe("u21");
        expect(user.get("role")).toBe("admin");
    });
});

describe("fill() with fillable", () => {
    it("only allows fillable fields", () => {
        const user = new FillableUser();
        user.fill({ id: "u30", name: "Test", email: "test@example.com", role: "admin" } as any);

        // Only name and email are fillable
        expect(user.get("name")).toBe("Test");
        expect(user.get("email")).toBe("test@example.com");
        expect(user.get("id")).toBeUndefined();
        expect(user.get("role")).toBeUndefined();
    });

    it("forceFill bypasses fillable", () => {
        const user = new FillableUser();
        user.forceFill({ id: "u31", name: "Test", role: "admin" } as any);

        expect(user.get("id")).toBe("u31");
        expect(user.get("role")).toBe("admin");
    });
});
