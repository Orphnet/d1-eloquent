import { describe, it, expect, beforeEach } from "vitest";
import {
    registerConnection,
    unregisterConnection,
    clearConnections,
    listConnections,
    getConnection,
    resolveDb,
} from "../registry";
import { configure } from "../config";

// In the workerd pool, isTestEnv() returns false, so we can test production paths.

const fakeDb = (tag: string) => ({ prepare: () => {}, _tag: tag }) as unknown as D1Database;

describe("resolveDb", () => {
    it("returns explicit db when provided", () => {
        const db = fakeDb("explicit");
        expect(resolveDb(db, undefined)).toBe(db);
    });

    it("returns model connection when it is a D1Database", () => {
        const modelDb = fakeDb("model-conn");
        expect(resolveDb(undefined, modelDb)).toBe(modelDb);
    });

    it("resolves model connection string key from registry", () => {
        const namedDb = fakeDb("named");
        registerConnection("my-conn", namedDb);
        expect(resolveDb(undefined, "my-conn")).toBe(namedDb);
    });

    it("throws for unknown string connection key", () => {
        expect(() => resolveDb(undefined, "nonexistent-key")).toThrow(
            /Unknown connection: "nonexistent-key"/
        );
    });

    it("returns default db from registry when no explicit or model conn", () => {
        const defaultDb = fakeDb("default");
        registerConnection("default", defaultDb);
        expect(resolveDb(undefined, undefined)).toBe(defaultDb);
    });

    it("explicit db takes priority over everything", () => {
        const explicit = fakeDb("explicit");
        const modelConn = fakeDb("model");
        registerConnection("default", fakeDb("default"));
        expect(resolveDb(explicit, modelConn)).toBe(explicit);
    });
});

describe("configure", () => {
    it("registers DEFAULT_DB as default connection", () => {
        const db = fakeDb("configured-default");
        configure({ DEFAULT_DB: db });
        expect(resolveDb(undefined, undefined)).toBe(db);
    });

    it("registers DB as default when DEFAULT_DB is absent", () => {
        const db = fakeDb("configured-db");
        configure({ DB: db });
        expect(resolveDb(undefined, undefined)).toBe(db);
    });

    it("prefers DEFAULT_DB over DB", () => {
        const primary = fakeDb("primary");
        const fallback = fakeDb("fallback");
        configure({ DEFAULT_DB: primary, DB: fallback });
        expect(resolveDb(undefined, undefined)).toBe(primary);
    });

    it("registers TEST_DB as test connection", () => {
        const testDb = fakeDb("test-db");
        configure({ TEST_DB: testDb });
        // Verify it was registered under "test" key
        expect(resolveDb(undefined, "test")).toBe(testDb);
    });

    it("handles env with no matching keys without throwing", () => {
        expect(() => configure({})).not.toThrow();
    });

    it("registers extra named connections via opts.connections", () => {
        const analytics = fakeDb("analytics");
        const audit = fakeDb("audit");
        configure({}, { connections: { analytics, audit } });
        expect(resolveDb(undefined, "analytics")).toBe(analytics);
        expect(resolveDb(undefined, "audit")).toBe(audit);
    });

    it("supports string aliases for previously-registered connections", () => {
        const primary = fakeDb("primary");
        configure({ DB: primary }, { connections: { read: "default" } });
        expect(resolveDb(undefined, "read")).toBe(primary);
    });

    it("does not auto-detect DB inside opts.connections if shadowed", () => {
        const primary = fakeDb("primary");
        const explicit = fakeDb("primary-explicit");
        configure({ DB: primary }, { connections: { default: explicit } });
        // opts.connections runs after auto-detection, so explicit override wins
        expect(resolveDb(undefined, undefined)).toBe(explicit);
    });
});

describe("registerConnection — aliases", () => {
    beforeEach(() => clearConnections());

    it("aliases an existing connection by name", () => {
        const db = fakeDb("base");
        registerConnection("base", db);
        registerConnection("mirror", "base");
        expect(getConnection("mirror")).toBe(db);
    });

    it("throws when aliasing an unknown connection", () => {
        expect(() => registerConnection("mirror", "missing")).toThrow(
            /alias for "missing": no such connection/,
        );
    });
});

describe("registry helpers", () => {
    beforeEach(() => clearConnections());

    it("unregisterConnection removes a name", () => {
        registerConnection("x", fakeDb("x"));
        expect(getConnection("x")).toBeDefined();
        unregisterConnection("x");
        expect(getConnection("x")).toBeUndefined();
    });

    it("clearConnections empties the registry", () => {
        registerConnection("a", fakeDb("a"));
        registerConnection("b", fakeDb("b"));
        clearConnections();
        expect(listConnections()).toEqual([]);
    });

    it("listConnections returns the registered names in insertion order", () => {
        registerConnection("first", fakeDb("1"));
        registerConnection("second", fakeDb("2"));
        registerConnection("third", fakeDb("3"));
        expect(listConnections()).toEqual(["first", "second", "third"]);
    });

    it("getConnection returns undefined for unknown names", () => {
        expect(getConnection("unknown")).toBeUndefined();
    });
});
