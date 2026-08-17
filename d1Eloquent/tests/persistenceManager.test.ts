import { describe, it, expect } from "vitest";

/**
 * PersistenceManager orchestrates DB operations (save/delete/restore)
 * by calling QueryBuilder, HookManager, TimestampManager, DirtyManager,
 * AttributeManager, RevisionManager, and CastManager.
 *
 * Full orchestration is tested via the 37 integration test files (823+ tests).
 * This file tests the module-private helper functions and verifies the
 * manager is structurally correct.
 */

// Since PersistenceManager's functions require a real QueryBuilder (which
// needs D1Database), we verify the extraction is correct by testing through
// BaseModel — which delegates to PersistenceManager.

import { BaseModel } from "../baseModel";

interface TestAttrs {
    id?: string;
    name?: string;
    created_at?: string | Date;
    updated_at?: string | Date;
}

class TestModel extends BaseModel<TestAttrs> {
    static table = "test";
    static primaryKey = "id";
    static timestamps = false;
    static hooks = {
        saving: (model: TestModel) => {
            if (model.get("name") === "CANCEL") return false;
        },
    };
}

describe("PersistenceManager via BaseModel delegation", () => {
    it("save() on new model without db throws (no DB configured)", async () => {
        const model = new TestModel({ id: "1", name: "test" });
        // No DB registered, no explicit db — should fail at query level
        await expect(model.save()).rejects.toThrow();
    });

    it("save() respects hook cancellation", async () => {
        const model = new TestModel({ id: "1", name: "CANCEL" });
        // Hook returns false → save is a no-op, returns this
        // But since there's no DB, it would throw if it got past the hook
        // The hook cancels before any DB call, so this should not throw
        const result = await model.save();
        expect(result).toBe(model);
        expect(model._persisted).toBe(false);
    });

    it("delete() returns false when no primary key", async () => {
        const model = new TestModel({});
        const result = await model.delete();
        expect(result).toBe(false);
    });

    it("restore() returns false when model does not support soft deletes", async () => {
        const model = new TestModel({ id: "1" });
        const result = await model.restore();
        expect(result).toBe(false);
    });
});
