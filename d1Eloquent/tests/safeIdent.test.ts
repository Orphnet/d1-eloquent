// safeIdent.test.ts
// Unit tests for the safeIdent / safeIdentList identifier guards.

import { describe, it, expect } from "vitest";
import { safeIdent, safeIdentList } from "../utils";

describe("safeIdent — accepts safe identifiers", () => {
    it("plain identifier", () => {
        expect(safeIdent("users")).toBe("users");
    });
    it("snake_case identifier", () => {
        expect(safeIdent("created_at")).toBe("created_at");
    });
    it("identifier with digits", () => {
        expect(safeIdent("col1")).toBe("col1");
    });
    it("identifier starting with underscore", () => {
        expect(safeIdent("_internal")).toBe("_internal");
    });
    it("qualified identifier (table.col)", () => {
        expect(safeIdent("users.email")).toBe("users.email");
    });
});

describe("safeIdent — rejects unsafe input", () => {
    const REJECTED = [
        "users; DROP TABLE x",
        "users--",
        "users)",
        "users(id)",
        "users id",
        "1users",
        "users-table",
        "users.email; --",
        "",
        "*",
        "users.*",
        '"users"',
        "`users`",
        "users\nwhere",
        "users.id.extra",
    ];
    for (const value of REJECTED) {
        it(`rejects ${JSON.stringify(value)}`, () => {
            expect(() => safeIdent(value)).toThrow(/Unsafe identifier/);
        });
    }

    it("rejects non-string", () => {
        // @ts-expect-error — testing runtime guard
        expect(() => safeIdent(null)).toThrow(/Unsafe identifier/);
    });
});

describe("safeIdentList", () => {
    it("returns the array unchanged when all are safe", () => {
        const out = safeIdentList(["id", "title", "users.email"]);
        expect(out).toEqual(["id", "title", "users.email"]);
    });

    it("throws on the first unsafe entry", () => {
        expect(() => safeIdentList(["id", "users; DROP TABLE x"])).toThrow(/Unsafe identifier/);
    });

    it("handles empty list", () => {
        expect(safeIdentList([])).toEqual([]);
    });
});
