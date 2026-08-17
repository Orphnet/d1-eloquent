import { describe, it, expect } from "vitest";
import { SoftDeleteManager } from "../managers/softDeleteManager";
import type { TSoftDeleteModel } from "../managers/softDeleteManager";

function createModel(softDeletes: boolean, deletedAt?: unknown): TSoftDeleteModel {
    const model = {
        attrs: { id: "1", name: "Alice", deleted_at: deletedAt ?? null },
    };
    Object.defineProperty(model, "constructor", {
        value: { softDeletes },
        enumerable: false,
    });
    return model;
}

describe("SoftDeleteManager", () => {
    describe("isSoftDeletable", () => {
        it("returns true when softDeletes is enabled", () => {
            expect(SoftDeleteManager.isSoftDeletable(createModel(true))).toBe(true);
        });

        it("returns false when softDeletes is disabled", () => {
            expect(SoftDeleteManager.isSoftDeletable(createModel(false))).toBe(false);
        });
    });

    describe("trashed", () => {
        it("returns true when deleted_at is set", () => {
            expect(SoftDeleteManager.trashed(createModel(true, "2024-01-01"))).toBe(true);
        });

        it("returns false when deleted_at is null", () => {
            expect(SoftDeleteManager.trashed(createModel(true, null))).toBe(false);
        });

        it("returns false when model does not support soft deletes", () => {
            expect(SoftDeleteManager.trashed(createModel(false, "2024-01-01"))).toBe(false);
        });

        it("returns false when deleted_at key is missing from attrs", () => {
            const model: TSoftDeleteModel = {
                attrs: { id: "1", name: "Alice" }, // no deleted_at
                constructor: { softDeletes: true },
            };
            Object.defineProperty(model, "constructor", {
                value: { softDeletes: true },
                enumerable: false,
            });
            expect(SoftDeleteManager.trashed(model)).toBe(false);
        });
    });
});
