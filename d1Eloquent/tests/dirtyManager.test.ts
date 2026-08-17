import { describe, it, expect } from "vitest";
import { DirtyManager } from "../managers/dirtyManager";
import type { TDirtyModel } from "../managers/dirtyManager";

function createState(overrides?: Partial<TDirtyModel>): TDirtyModel {
    return {
        attrs: { id: "1", name: "Alice" },
        original: { id: "1", name: "Alice" },
        dirty: new Set<string>(),
        lastChanges: {},
        ...overrides,
    };
}

describe("DirtyManager", () => {
    describe("isDirty", () => {
        it("returns false when nothing is dirty", () => {
            expect(DirtyManager.isDirty(createState())).toBe(false);
        });

        it("returns true when any field is dirty", () => {
            const state = createState({ dirty: new Set(["name"]) });
            expect(DirtyManager.isDirty(state)).toBe(true);
        });

        it("checks specific key", () => {
            const state = createState({ dirty: new Set(["name"]) });
            expect(DirtyManager.isDirty(state, "name")).toBe(true);
            expect(DirtyManager.isDirty(state, "id")).toBe(false);
        });
    });

    describe("getDirty", () => {
        it("returns dirty attribute values", () => {
            const state = createState({
                attrs: { id: "1", name: "Bob" },
                dirty: new Set(["name"]),
            });
            expect(DirtyManager.getDirty(state)).toEqual({ name: "Bob" });
        });

        it("returns empty object when clean", () => {
            expect(DirtyManager.getDirty(createState())).toEqual({});
        });
    });

    describe("getChanges", () => {
        it("returns a copy of lastChanges", () => {
            const state = createState({ lastChanges: { name: "Bob" } });
            const changes = DirtyManager.getChanges(state);
            expect(changes).toEqual({ name: "Bob" });
            // should be a copy, not the same reference
            expect(changes).not.toBe(state.lastChanges);
        });
    });

    describe("wasChanged", () => {
        it("returns true when any change exists", () => {
            const state = createState({ lastChanges: { name: "Bob" } });
            expect(DirtyManager.wasChanged(state)).toBe(true);
        });

        it("returns false when no changes", () => {
            expect(DirtyManager.wasChanged(createState())).toBe(false);
        });

        it("checks specific key", () => {
            const state = createState({ lastChanges: { name: "Bob" } });
            expect(DirtyManager.wasChanged(state, "name")).toBe(true);
            expect(DirtyManager.wasChanged(state, "id")).toBe(false);
        });
    });

    describe("syncOriginal", () => {
        it("copies attrs to original and clears dirty state", () => {
            const state = createState({
                attrs: { id: "1", name: "Bob" },
                original: { id: "1", name: "Alice" },
                dirty: new Set(["name"]),
                lastChanges: { name: "Bob" },
            });

            DirtyManager.syncOriginal(state);

            expect(state.original).toEqual({ id: "1", name: "Bob" });
            expect(state.dirty.size).toBe(0);
            expect(state.lastChanges).toEqual({});
        });

        it("isDirty returns false immediately after syncOriginal", () => {
            const state = createState({
                attrs: { id: "1", name: "Bob" },
                dirty: new Set(["name"]),
                lastChanges: { name: "Bob" },
            });
            DirtyManager.syncOriginal(state);
            expect(DirtyManager.isDirty(state)).toBe(false);
            expect(DirtyManager.isDirty(state, "name")).toBe(false);
        });
    });
});
