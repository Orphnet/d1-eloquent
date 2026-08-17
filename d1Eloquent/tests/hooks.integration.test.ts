// hooks.integration.test.ts
// Integration tests for model lifecycle hooks

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BaseModel } from "../baseModel";
import type { THooks } from "../hookTypes";

// ── Tracking helpers ─────────────────────────────────────────────────

const hookLog: string[] = [];

function resetLog() {
    hookLog.length = 0;
}

// ── Models ───────────────────────────────────────────────────────────

interface ItemAttrs {
    id?: string;
    name?: string;
    slug?: string;
    created_at?: string | Date;
    updated_at?: string | Date;
}

class HookedItem extends BaseModel<ItemAttrs> {
    static table = "hook_items";
    static primaryKey = "id";
    static timestamps = true;
    static hooks: THooks<HookedItem> = {
        creating: (model) => {
            hookLog.push("creating");
            // Auto-generate slug from name
            const name = model.get("name") as string;
            if (name && !model.get("slug")) {
                model.set("slug" as any, name.toLowerCase().replace(/\s+/g, "-") as any);
            }
        },
        created: (model) => {
            hookLog.push("created");
        },
        updating: (model) => {
            hookLog.push("updating");
        },
        updated: (model) => {
            hookLog.push("updated");
        },
        saving: (model) => {
            hookLog.push("saving");
        },
        saved: (model) => {
            hookLog.push("saved");
        },
        deleting: (model) => {
            hookLog.push("deleting");
        },
        deleted: (model) => {
            hookLog.push("deleted");
        },
    };
}

interface ProtectedAttrs {
    id?: string;
    name?: string;
    status?: string;
    created_at?: string | Date;
    updated_at?: string | Date;
}

class ProtectedItem extends BaseModel<ProtectedAttrs> {
    static table = "hook_protected";
    static primaryKey = "id";
    static timestamps = true;
    static hooks: THooks<ProtectedItem> = {
        // Cancel delete if status is "locked"
        deleting: (model) => {
            if (model.get("status") === "locked") return false;
        },
        // Cancel update if status would change to "invalid"
        saving: (model) => {
            if (model.isDirty("status" as any) && model.get("status") === "invalid") return false;
        },
    };
}

interface SoftAttrs {
    id?: string;
    name?: string;
    created_at?: string | Date;
    updated_at?: string | Date;
    deleted_at?: string | Date | null;
}

class SoftHookedItem extends BaseModel<SoftAttrs> {
    static table = "hook_soft_items";
    static primaryKey = "id";
    static timestamps = true;
    static softDeletes = true;
    static hooks: THooks<SoftHookedItem> = {
        deleting: () => { hookLog.push("soft-deleting"); },
        deleted: () => { hookLog.push("soft-deleted"); },
    };
}

// ── Schema ───────────────────────────────────────────────────────────

beforeAll(async () => {
    const db = env.DB;
    await db.batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS hook_items (
            id TEXT PRIMARY KEY,
            name TEXT,
            slug TEXT,
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT ''
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS hook_protected (
            id TEXT PRIMARY KEY,
            name TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT ''
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS hook_soft_items (
            id TEXT PRIMARY KEY,
            name TEXT,
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT '',
            deleted_at TEXT
        )`),
    ]);
});

afterAll(async () => {
    const db = env.DB;
    await db.batch([
        db.prepare("DROP TABLE IF EXISTS hook_items"),
        db.prepare("DROP TABLE IF EXISTS hook_protected"),
        db.prepare("DROP TABLE IF EXISTS hook_soft_items"),
    ]);
});

beforeEach(async () => {
    resetLog();
    const db = env.DB;
    await db.batch([
        db.prepare("DELETE FROM hook_items"),
        db.prepare("DELETE FROM hook_protected"),
        db.prepare("DELETE FROM hook_soft_items"),
    ]);
});

// ── Tests ────────────────────────────────────────────────────────────

describe("lifecycle hooks on create", () => {
    it("fires saving → creating → created → saved", async () => {
        await HookedItem.create(env.DB, { id: "h1", name: "Test Item" });
        expect(hookLog).toEqual(["saving", "creating", "created", "saved"]);
    });

    it("creating hook can modify model (auto-slug)", async () => {
        const item = await HookedItem.create(env.DB, { id: "h2", name: "Hello World" });
        expect(item.get("slug")).toBe("hello-world");

        // Verify persisted to DB
        const loaded = await HookedItem.find(env.DB, "h2");
        expect(loaded!.get("slug")).toBe("hello-world");
    });
});

describe("lifecycle hooks on update", () => {
    it("fires saving → updating → updated → saved", async () => {
        const item = await HookedItem.create(env.DB, { id: "h3", name: "Original" });
        resetLog();

        item.set("name" as any, "Updated" as any);
        await item.save(env.DB);

        expect(hookLog).toEqual(["saving", "updating", "updated", "saved"]);
    });
});

describe("lifecycle hooks on delete", () => {
    it("fires deleting → deleted", async () => {
        const item = await HookedItem.create(env.DB, { id: "h4", name: "Doomed" });
        resetLog();

        await item.delete(env.DB);
        expect(hookLog).toEqual(["deleting", "deleted"]);
    });

    it("fires for soft deletes too", async () => {
        const item = await SoftHookedItem.create(env.DB, { id: "s1", name: "Soft" });
        resetLog();

        await item.delete(env.DB);
        expect(hookLog).toEqual(["soft-deleting", "soft-deleted"]);
    });
});

describe("cancellation via return false", () => {
    it("deleting hook returning false prevents deletion", async () => {
        const item = await ProtectedItem.create(env.DB, { id: "p1", name: "Locked", status: "locked" });

        const deleted = await item.delete(env.DB);
        expect(deleted).toBe(false);

        // Verify still exists
        const loaded = await ProtectedItem.find(env.DB, "p1");
        expect(loaded).not.toBeNull();
    });

    it("saving hook returning false prevents update", async () => {
        const item = await ProtectedItem.create(env.DB, { id: "p2", name: "Valid", status: "active" });

        item.set("status" as any, "invalid" as any);
        const result = await item.save(env.DB);

        // save returns this but doesn't persist
        const loaded = await ProtectedItem.find(env.DB, "p2");
        expect(loaded!.get("status")).toBe("active");
    });

    it("allows delete when condition is not met", async () => {
        const item = await ProtectedItem.create(env.DB, { id: "p3", name: "Unlocked", status: "active" });

        const deleted = await item.delete(env.DB);
        expect(deleted).toBe(true);

        const loaded = await ProtectedItem.find(env.DB, "p3");
        expect(loaded).toBeNull();
    });
});

describe("multiple hook handlers (array)", () => {
    it("runs all handlers in order", async () => {
        const log: number[] = [];

        class MultiHookItem extends BaseModel<ItemAttrs> {
            static table = "hook_items";
            static primaryKey = "id";
            static timestamps = true;
            static hooks: THooks<MultiHookItem> = {
                creating: [
                    () => { log.push(1); },
                    () => { log.push(2); },
                    () => { log.push(3); },
                ],
            };
        }

        await MultiHookItem.create(env.DB, { id: "m1", name: "Multi" });
        expect(log).toEqual([1, 2, 3]);
    });

    it("stops at first false return in array", async () => {
        const log: number[] = [];

        class StopHookItem extends BaseModel<ItemAttrs> {
            static table = "hook_items";
            static primaryKey = "id";
            static timestamps = true;
            static hooks: THooks<StopHookItem> = {
                creating: [
                    () => { log.push(1); },
                    () => { log.push(2); return false; },
                    () => { log.push(3); }, // should not run
                ],
            };
        }

        await StopHookItem.create(env.DB, { id: "s1", name: "Stop" });
        expect(log).toEqual([1, 2]);

        // Verify not persisted
        const loaded = await env.DB.prepare("SELECT * FROM hook_items WHERE id = ?").bind("s1").first();
        expect(loaded).toBeNull();
    });
});

describe("async hooks", () => {
    it("awaits async hook before proceeding", async () => {
        const log: string[] = [];

        class AsyncHookItem extends BaseModel<ItemAttrs> {
            static table = "hook_items";
            static primaryKey = "id";
            static timestamps = true;
            static hooks: THooks<AsyncHookItem> = {
                creating: async (model) => {
                    await new Promise((r) => setTimeout(r, 10));
                    log.push("async-creating");
                },
                created: async () => {
                    await new Promise((r) => setTimeout(r, 10));
                    log.push("async-created");
                },
            };
        }

        await AsyncHookItem.create(env.DB, { id: "a1", name: "Async" });
        expect(log).toEqual(["async-creating", "async-created"]);
    });

    it("async hook returning false cancels operation", async () => {
        class AsyncCancelItem extends BaseModel<ItemAttrs> {
            static table = "hook_items";
            static primaryKey = "id";
            static timestamps = true;
            static hooks: THooks<AsyncCancelItem> = {
                creating: async () => {
                    await new Promise((r) => setTimeout(r, 5));
                    return false;
                },
            };
        }

        await AsyncCancelItem.create(env.DB, { id: "a2", name: "Blocked" });
        const loaded = await env.DB.prepare("SELECT * FROM hook_items WHERE id = ?").bind("a2").first();
        expect(loaded).toBeNull();
    });
});

describe("hook error propagation", () => {
    it("propagates error thrown in hook", async () => {
        class ErrorHookItem extends BaseModel<ItemAttrs> {
            static table = "hook_items";
            static primaryKey = "id";
            static timestamps = true;
            static hooks: THooks<ErrorHookItem> = {
                creating: () => { throw new Error("hook-error"); },
            };
        }

        await expect(
            ErrorHookItem.create(env.DB, { id: "e1", name: "Err" }),
        ).rejects.toThrow("hook-error");

        // Verify not persisted
        const loaded = await env.DB.prepare("SELECT * FROM hook_items WHERE id = ?").bind("e1").first();
        expect(loaded).toBeNull();
    });

    it("propagates error from async hook", async () => {
        class AsyncErrorItem extends BaseModel<ItemAttrs> {
            static table = "hook_items";
            static primaryKey = "id";
            static timestamps = true;
            static hooks: THooks<AsyncErrorItem> = {
                creating: async () => {
                    await new Promise((r) => setTimeout(r, 5));
                    throw new Error("async-hook-error");
                },
            };
        }

        await expect(
            AsyncErrorItem.create(env.DB, { id: "e2", name: "Err" }),
        ).rejects.toThrow("async-hook-error");
    });

    it("error in array handler stops subsequent handlers", async () => {
        const log: number[] = [];

        class ArrayErrorItem extends BaseModel<ItemAttrs> {
            static table = "hook_items";
            static primaryKey = "id";
            static timestamps = true;
            static hooks: THooks<ArrayErrorItem> = {
                creating: [
                    () => { log.push(1); },
                    () => { throw new Error("mid-array-error"); },
                    () => { log.push(3); },
                ],
            };
        }

        await expect(
            ArrayErrorItem.create(env.DB, { id: "e3", name: "Err" }),
        ).rejects.toThrow("mid-array-error");
        expect(log).toEqual([1]);
    });
});

describe("typed hooks compile correctly (THooks<ConcreteModel>)", () => {
    it("static methods work on models with typed hooks", async () => {
        // This test validates the TModelCtor fix — THooks<TypedModel> in a concrete
        // class must not break the `this` context on static methods like find/create/query.
        class TypedModel extends BaseModel<ItemAttrs> {
            static table = "hook_items";
            static primaryKey = "id";
            static timestamps = true;
            static hooks: THooks<TypedModel> = {
                creating: (model) => {
                    // model should be TypedModel — these calls verify the type inference
                    model.getKey();
                    model.get("name");
                    model.isDirty("name" as keyof ItemAttrs);
                },
            };
        }

        // All these static calls must compile and run without TS2684/TS2769
        const created = await TypedModel.create(env.DB, { id: "t1", name: "Typed" });
        expect(created.get("name")).toBe("Typed");

        const found = await TypedModel.find(env.DB, "t1");
        expect(found).not.toBeNull();

        const all = await TypedModel.all(env.DB);
        expect(all.length).toBe(1);

        const queried = await TypedModel.query().whereEq("id", "t1").get(env.DB);
        expect(queried.length).toBe(1);
    });
});
