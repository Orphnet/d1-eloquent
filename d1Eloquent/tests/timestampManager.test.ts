import { describe, it, expect, vi } from "vitest";
import { TimestampManager } from "../managers/timestampManager";
import type { TTimestampModel } from "../managers/timestampManager";

function createModel(timestamps = true): TTimestampModel {
    return {
        attrs: { id: "1", name: "Alice", created_at: null, updated_at: null },
        dirty: new Set<string>(),
        lastChanges: {},
        _accessorCache: new Map(),
        constructor: { timestamps },
    };
}

describe("TimestampManager", () => {
    it("sets created_at and updated_at on create", () => {
        const model = createModel();
        TimestampManager.applyTimestamps(model, true);

        expect(model.attrs["created_at"]).toBeDefined();
        expect(model.attrs["updated_at"]).toBeDefined();
        expect(model.dirty.has("created_at")).toBe(true);
        expect(model.dirty.has("updated_at")).toBe(true);
    });

    it("does not overwrite existing created_at on create", () => {
        const model = createModel();
        model.attrs["created_at"] = "2024-01-01T00:00:00.000Z";
        TimestampManager.applyTimestamps(model, true);

        // created_at should remain unchanged
        expect(model.attrs["created_at"]).toBe("2024-01-01T00:00:00.000Z");
        // updated_at should be set
        expect(model.attrs["updated_at"]).toBeDefined();
    });

    it("only touches updated_at on update", () => {
        const model = createModel();
        model.attrs["created_at"] = "2024-01-01T00:00:00.000Z";
        TimestampManager.applyTimestamps(model, false);

        expect(model.attrs["created_at"]).toBe("2024-01-01T00:00:00.000Z");
        expect(model.dirty.has("created_at")).toBe(false);
        expect(model.dirty.has("updated_at")).toBe(true);
    });

    it("does nothing when timestamps are disabled", () => {
        const model = createModel(false);
        TimestampManager.applyTimestamps(model, true);

        expect(model.attrs["created_at"]).toBeNull();
        expect(model.attrs["updated_at"]).toBeNull();
        expect(model.dirty.size).toBe(0);
    });

    it("freshTimestamp returns ISO string", () => {
        const ts = TimestampManager.freshTimestamp();
        expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("hydrates through datetime cast when casts defined", () => {
        const model: TTimestampModel = {
            attrs: { id: "1", created_at: null, updated_at: null },
            dirty: new Set<string>(),
            lastChanges: {},
            _accessorCache: new Map(),
            constructor: {
                timestamps: true,
                casts: { created_at: "datetime", updated_at: "datetime" },
            },
        };
        TimestampManager.applyTimestamps(model, true);
        // With datetime cast, values should be hydrated to Date instances
        expect(model.attrs["created_at"]).toBeInstanceOf(Date);
        expect(model.attrs["updated_at"]).toBeInstanceOf(Date);
    });
});
