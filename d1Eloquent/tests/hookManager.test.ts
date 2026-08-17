import { describe, it, expect, vi } from "vitest";
import { HookManager } from "../managers/hookManager";

function createModel(hooks?: Record<string, any>) {
    const model = { data: "test" };
    Object.defineProperty(model, "constructor", {
        value: { hooks },
        enumerable: false,
    });
    return model;
}

describe("HookManager", () => {
    it("returns true when no hooks defined", async () => {
        const model = createModel(undefined);
        expect(await HookManager.fireHook(model, "saving")).toBe(true);
    });

    it("returns true when event has no handler", async () => {
        const model = createModel({ creating: vi.fn() });
        expect(await HookManager.fireHook(model, "saving")).toBe(true);
    });

    it("calls single hook handler", async () => {
        const fn = vi.fn();
        const model = createModel({ saving: fn });
        await HookManager.fireHook(model, "saving");
        expect(fn).toHaveBeenCalledWith(model);
    });

    it("calls array of hook handlers in order", async () => {
        const order: number[] = [];
        const fn1 = vi.fn(() => { order.push(1); });
        const fn2 = vi.fn(() => { order.push(2); });
        const model = createModel({ saving: [fn1, fn2] });
        await HookManager.fireHook(model, "saving");
        expect(order).toEqual([1, 2]);
    });

    it("returns false when a before hook returns false", async () => {
        const fn = vi.fn(() => false);
        const model = createModel({ creating: fn });
        expect(await HookManager.fireHook(model, "creating")).toBe(false);
    });

    it("stops executing handlers after false is returned", async () => {
        const fn1 = vi.fn(() => false);
        const fn2 = vi.fn();
        const model = createModel({ saving: [fn1, fn2] });
        await HookManager.fireHook(model, "saving");
        expect(fn1).toHaveBeenCalled();
        expect(fn2).not.toHaveBeenCalled();
    });

    it("handles async hooks", async () => {
        const fn = vi.fn(async () => { /* async work */ });
        const model = createModel({ saved: fn });
        expect(await HookManager.fireHook(model, "saved")).toBe(true);
        expect(fn).toHaveBeenCalled();
    });

    it("propagates errors thrown by hooks (not false)", async () => {
        const fn = vi.fn(() => { throw new Error("hook failed"); });
        const model = createModel({ saving: fn });
        await expect(HookManager.fireHook(model, "saving")).rejects.toThrow("hook failed");
    });

    it("propagates async rejection from hooks", async () => {
        const fn = vi.fn(async () => { throw new Error("async hook failed"); });
        const model = createModel({ creating: fn });
        await expect(HookManager.fireHook(model, "creating")).rejects.toThrow("async hook failed");
    });
});
