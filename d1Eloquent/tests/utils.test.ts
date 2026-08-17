import { describe, it, expect } from "vitest";
import { nowIso, assert, isNonEmptyString, toArray } from "../utils";

describe("nowIso", () => {
    it("returns a valid ISO 8601 string", () => {
        const result = nowIso();
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
        expect(new Date(result).toISOString()).toBe(result);
    });
});

describe("assert", () => {
    it("does not throw for truthy values", () => {
        expect(() => assert(true, "ok")).not.toThrow();
        expect(() => assert(1, "ok")).not.toThrow();
        expect(() => assert("a", "ok")).not.toThrow();
        expect(() => assert({}, "ok")).not.toThrow();
    });

    it("throws Error with message for falsy values", () => {
        expect(() => assert(false, "boom")).toThrow("boom");
        expect(() => assert(0, "zero")).toThrow("zero");
        expect(() => assert("", "empty")).toThrow("empty");
        expect(() => assert(null, "null")).toThrow("null");
        expect(() => assert(undefined, "undef")).toThrow("undef");
    });
});

describe("isNonEmptyString", () => {
    it("returns true for non-empty strings", () => {
        expect(isNonEmptyString("hello")).toBe(true);
        expect(isNonEmptyString(" ")).toBe(true);
    });

    it("returns false for empty string", () => {
        expect(isNonEmptyString("")).toBe(false);
    });

    it("returns false for non-string values", () => {
        expect(isNonEmptyString(0)).toBe(false);
        expect(isNonEmptyString(null)).toBe(false);
        expect(isNonEmptyString(undefined)).toBe(false);
        expect(isNonEmptyString(123)).toBe(false);
        expect(isNonEmptyString({})).toBe(false);
        expect(isNonEmptyString([])).toBe(false);
    });
});

describe("toArray", () => {
    it("wraps a non-array value in an array", () => {
        expect(toArray("a")).toEqual(["a"]);
        expect(toArray(1)).toEqual([1]);
        expect(toArray(null)).toEqual([null]);
    });

    it("returns an array as-is", () => {
        const arr = [1, 2, 3];
        expect(toArray(arr)).toBe(arr);
        expect(toArray([])).toEqual([]);
    });
});
