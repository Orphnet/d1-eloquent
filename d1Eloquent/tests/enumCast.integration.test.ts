// enumCast.integration.test.ts
// Live D1 tests for the enumCast() runtime-validated cast.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BaseModel } from "../baseModel";
import { enumCast } from "../castManager";

type Status = "draft" | "published" | "archived";
interface PostAttrs {
    id?: string;
    status?: Status;
    priority?: 1 | 2 | 3 | null;
}

class EnPost extends BaseModel<PostAttrs> {
    static table = "en_posts";
    static timestamps = false;
    static casts = {
        status: enumCast(["draft", "published", "archived"]),
        priority: enumCast([1, 2, 3]),
    } as const;
}

// A second model over the SAME `en_posts` table whose numeric enum *includes* 0,
// so we can pin that a falsy `0` member is a valid value (not treated as null).
interface LevelAttrs {
    id?: string;
    priority?: 0 | 1 | 2 | null;
}

class EnLevelPost extends BaseModel<LevelAttrs> {
    static table = "en_posts";
    static timestamps = false;
    static casts = {
        priority: enumCast([0, 1, 2]),
    } as const;
}

beforeAll(async () => {
    await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS en_posts (id TEXT PRIMARY KEY, status TEXT, priority INTEGER)`,
    ).run();
});

beforeEach(async () => {
    await env.DB.prepare("DELETE FROM en_posts").run();
});

describe("enumCast()", () => {
    it("persists and reads a valid enum value (string + numeric)", async () => {
        await EnPost.create(env.DB, { id: "p1", status: "published", priority: 2 });
        const row = await EnPost.find(env.DB, "p1");
        expect(row!.get("status")).toBe("published");
        expect(row!.get("priority")).toBe(2);
    });

    it("throws when creating with a value outside the set", async () => {
        await expect(
            // @ts-expect-error deliberately invalid enum value
            EnPost.create(env.DB, { id: "bad", status: "spam" }),
        ).rejects.toThrow(/Invalid enum value/i);
    });

    it("throws on save() when the value is out of set", async () => {
        const p = await EnPost.create(env.DB, { id: "p2", status: "draft" });
        // @ts-expect-error deliberately invalid
        p.set("status", "nope");
        await expect(p.save(env.DB)).rejects.toThrow(/Invalid enum value/i);
    });

    it("lets null / undefined pass through", async () => {
        await EnPost.create(env.DB, { id: "p3", status: "draft", priority: null });
        const row = await EnPost.find(env.DB, "p3");
        expect(row!.get("priority")).toBeNull();
    });

    it("validates + filters by an enum value in a where clause", async () => {
        await EnPost.create(env.DB, { id: "a", status: "published" });
        await EnPost.create(env.DB, { id: "b", status: "draft" });
        const rows = await EnPost.query().whereEq("status", "published").get(env.DB);
        expect(rows.map((r) => r.get("id"))).toEqual(["a"]);
    });

    it("throws on an invalid enum value used to filter (dehydrated at compile)", async () => {
        await expect(
            // @ts-expect-error deliberately invalid
            EnPost.query().whereEq("status", "bogus").get(env.DB),
        ).rejects.toThrow(/Invalid enum value/i);
    });
});

// #47 — Pin enumCast's documented contract: it validates on BOTH read and write.
// Read-side strictness is a known design tension flagged for review; these tests
// document (not endorse) the current behavior so any change to it is deliberate.
describe("enumCast() read/write validation contract (#47)", () => {
    it("(a) throws when writing an out-of-set numeric value via set()/save()", async () => {
        const p = await EnPost.create(env.DB, { id: "w1", status: "draft", priority: 1 });
        // @ts-expect-error 9 is not a member of [1, 2, 3]
        p.set("priority", 9);
        await expect(p.save(env.DB)).rejects.toThrow(/Invalid enum value/i);

        // The failed write left the persisted row untouched (still priority 1).
        const stored = await env.DB
            .prepare("SELECT priority FROM en_posts WHERE id = ?")
            .bind("w1")
            .first<{ priority: number | null }>();
        expect(stored!.priority).toBe(1);
    });

    it("(b) throws on read/hydration when a stored row already holds an out-of-set value", async () => {
        // Write a corrupt value directly, bypassing the cast's write-side check.
        await env.DB
            .prepare("INSERT INTO en_posts (id, status, priority) VALUES (?, ?, ?)")
            .bind("rogue", "corrupted", 2)
            .run();

        // find() hydrates the row through the constructor → cast.get() rejects it.
        await expect(EnPost.find(env.DB, "rogue")).rejects.toThrow(/Invalid enum value/i);

        // query().get() takes the exact same hydration path and also rejects.
        await expect(
            EnPost.query().whereEq("id", "rogue").get(env.DB),
        ).rejects.toThrow(/Invalid enum value/i);
    });

    it("(c) passes null through on both write and read", async () => {
        // write-side: a null enum value persists as SQL NULL (no throw).
        await EnPost.create(env.DB, { id: "n1", status: "draft", priority: null });
        const written = await env.DB
            .prepare("SELECT priority FROM en_posts WHERE id = ?")
            .bind("n1")
            .first<{ priority: number | null }>();
        expect(written!.priority).toBeNull();

        // read-side: a directly-inserted NULL hydrates back to null (no throw).
        await env.DB
            .prepare("INSERT INTO en_posts (id, status, priority) VALUES (?, NULL, NULL)")
            .bind("n2")
            .run();
        const row = await EnPost.find(env.DB, "n2");
        expect(row!.get("status")).toBeNull();
        expect(row!.get("priority")).toBeNull();
    });

    it("(d) accepts a falsy 0 enum member on both write and read (== null, not falsy)", async () => {
        // 0 is a real member of [0, 1, 2]; the cast's `value == null` guard must NOT
        // swallow it as absent. Write 0, then read it back as 0 (not null, no throw).
        await EnLevelPost.create(env.DB, { id: "z1", priority: 0 });

        const stored = await env.DB
            .prepare("SELECT priority FROM en_posts WHERE id = ?")
            .bind("z1")
            .first<{ priority: number | null }>();
        expect(stored!.priority).toBe(0);

        const row = await EnLevelPost.find(env.DB, "z1");
        expect(row!.get("priority")).toBe(0);
        expect(row!.get("priority")).not.toBeNull();
    });
});

// Opt-in lenient read: a single legacy/out-of-set row should not 500 a whole
// list query. Default stays strict-throw (contract above); writes stay strict.
class EnLenientNull extends BaseModel<PostAttrs> {
    static table = "en_posts";
    static timestamps = false;
    static casts = {
        status: enumCast(["draft", "published", "archived"], { onInvalidRead: "null" }),
    } as const;
}
class EnLenientKeep extends BaseModel<PostAttrs> {
    static table = "en_posts";
    static timestamps = false;
    static casts = {
        status: enumCast(["draft", "published", "archived"], { onInvalidRead: "keep" }),
    } as const;
}

describe("enumCast() opt-in lenient read (onInvalidRead)", () => {
    beforeEach(async () => {
        await env.DB.prepare("INSERT INTO en_posts (id, status, priority) VALUES ('ok', 'draft', 1)").run();
        await env.DB.prepare("INSERT INTO en_posts (id, status, priority) VALUES ('bad', 'legacy_status', 1)").run();
    });

    it("'null' degrades an out-of-set value to null instead of failing the query", async () => {
        const rows = await EnLenientNull.query().orderBy("id", "asc").get(env.DB);
        expect(rows.map((r) => r.get("id"))).toEqual(["bad", "ok"]);
        expect(rows.find((r) => r.get("id") === "bad")!.get("status")).toBeNull();
        expect(rows.find((r) => r.get("id") === "ok")!.get("status")).toBe("draft");
    });

    it("'keep' returns the raw stored value as-is", async () => {
        const bad = await EnLenientKeep.find(env.DB, "bad");
        expect(bad!.get("status")).toBe("legacy_status");
    });

    it("writes stay strict even with a lenient read policy", async () => {
        const p = new EnLenientNull();
        p.fill({ id: "w2", status: "nope" as Status, priority: 1 });
        await expect(p.save(env.DB)).rejects.toThrow(/Invalid enum value/i);
    });
});
