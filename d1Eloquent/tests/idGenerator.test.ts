// idGenerator.test.ts
// Unit tests for the standalone primary-key generators and generateId() dispatch.

import { describe, it, expect } from "vitest";
import { uuid, uuidv7, ulid, generateId } from "../idGenerator";
import { EloquentException } from "../exceptions";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CROCKFORD_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe("uuid()", () => {
    it("returns a canonical v4 UUID", () => {
        const id = uuid();
        expect(id).toMatch(UUID_RE);
        // version nibble === 4, variant bits === 8/9/a/b
        expect(id[14]).toBe("4");
        expect("89ab").toContain(id[19]);
    });

    it("is unique across many calls", () => {
        const set = new Set(Array.from({ length: 2000 }, () => uuid()));
        expect(set.size).toBe(2000);
    });
});

describe("uuidv7()", () => {
    it("returns a canonical UUID with version 7 and correct variant", () => {
        const id = uuidv7();
        expect(id).toMatch(UUID_RE);
        expect(id[14]).toBe("7"); // version nibble
        expect("89ab").toContain(id[19]); // RFC 4122 variant
    });

    it("is unique across many calls", () => {
        const set = new Set(Array.from({ length: 2000 }, () => uuidv7()));
        expect(set.size).toBe(2000);
    });

    it("embeds the current millisecond timestamp in the first 48 bits", () => {
        const before = Date.now();
        const id = uuidv7();
        const after = Date.now();
        // First 12 hex chars (minus the dash) encode the 48-bit ms timestamp.
        const tsHex = id.slice(0, 8) + id.slice(9, 13);
        const ts = parseInt(tsHex, 16);
        expect(ts).toBeGreaterThanOrEqual(before);
        expect(ts).toBeLessThanOrEqual(after);
    });

    it("sorts lexicographically in time order across millisecond boundaries", async () => {
        const a = uuidv7();
        await new Promise((r) => setTimeout(r, 3));
        const b = uuidv7();
        expect(a < b).toBe(true);
    });
});

describe("ulid()", () => {
    it("returns a 26-char Crockford base32 string", () => {
        const id = ulid();
        expect(id).toHaveLength(26);
        expect(id).toMatch(CROCKFORD_RE);
    });

    it("is unique across many calls", () => {
        const set = new Set(Array.from({ length: 2000 }, () => ulid()));
        expect(set.size).toBe(2000);
    });

    it("sorts lexicographically in time order across millisecond boundaries", async () => {
        const a = ulid();
        await new Promise((r) => setTimeout(r, 3));
        const b = ulid();
        expect(a < b).toBe(true);
    });
});

describe("generateId()", () => {
    it("dispatches to the named strategy", () => {
        expect(generateId("uuid", { table: "t", keyName: "id" })).toMatch(UUID_RE);
        expect(generateId("uuidv7", { table: "t", keyName: "id" })[14]).toBe("7");
        expect(generateId("ulid", { table: "t", keyName: "id" })).toMatch(CROCKFORD_RE);
    });

    it("invokes a custom generator function with model context", () => {
        const ctx = { table: "widgets", keyName: "uuid" };
        const spy = generateId((c) => `${c.table}:${c.keyName}:42`, ctx);
        expect(spy).toBe("widgets:uuid:42");
    });

    it("throws EloquentException on an unknown strategy", () => {
        // @ts-expect-error deliberately passing an invalid strategy
        expect(() => generateId("nanoid", { table: "t", keyName: "id" })).toThrow(EloquentException);
    });
});
