// castMutationDirty.integration.test.ts
// Regression tests: in-place mutation of json/array/Date cast values must be
// detected as dirty (so it is written on UPDATE) and must not corrupt the
// `original` baseline used for the revision before-snapshot.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BaseModel } from "../baseModel";
import { snapshotOriginal } from "../managers/dirtyManager";

interface DocAttrs {
    id: string;
    meta: Record<string, unknown>;
    tags: string[];
}

class Doc extends BaseModel<DocAttrs> {
    static table = "cast_mut_docs";
    static primaryKey = "id";
    static timestamps = false;
    static casts = { meta: "json" as const, tags: "array" as const };
}

const MODEL_REVISIONS_DDL = `
    CREATE TABLE IF NOT EXISTS model_revisions (
        id TEXT PRIMARY KEY, model_table TEXT NOT NULL, model_pk TEXT NOT NULL,
        model_id TEXT NOT NULL, action TEXT NOT NULL, diff_json TEXT,
        before_json TEXT, after_json TEXT, actor_id TEXT, request_id TEXT,
        reason TEXT, created_at TEXT NOT NULL
    )`;

interface RevDocAttrs {
    id: string;
    meta?: Record<string, unknown>;
    created_at?: string;
    updated_at?: string;
}

class RevDoc extends BaseModel<RevDocAttrs> {
    static table = "cast_mut_rev_docs";
    static primaryKey = "id";
    static timestamps = true;
    static timestampMode = "iso" as const;
    static casts = { meta: "json" as const };
    static revisions = { enabled: true, mode: "before+after" as const };
}

describe("snapshotOriginal (deep-clone baseline)", () => {
    it("deep-clones objects/arrays so the baseline cannot alias live attrs", () => {
        const attrs = { id: "1", meta: { a: 1 }, tags: ["x"], when: new Date(0) };
        const snap = snapshotOriginal(attrs);
        // structurally equal but not the same references
        expect(snap.meta).toEqual({ a: 1 });
        expect(snap.meta).not.toBe(attrs.meta);
        expect(snap.tags).not.toBe(attrs.tags);
        expect(snap.when).not.toBe(attrs.when);
        // mutating the live attr must not touch the snapshot
        (attrs.meta as Record<string, unknown>).a = 2;
        expect(snap.meta).toEqual({ a: 1 });
        // primitives pass through
        expect(snap.id).toBe("1");
    });
});

describe("in-memory dirty tracking on cast mutation", () => {
    it("marks a json attribute dirty after mutate-then-set", () => {
        const d = new Doc({ id: "1", meta: { a: 1 }, tags: ["x"] });
        const meta = d.get("meta") as Record<string, unknown>;
        meta.a = 2; // in-place mutation of the live reference
        d.set("meta", meta);
        expect(d.isDirty("meta")).toBe(true);
        expect(d.getDirty().meta).toEqual({ a: 2 });
    });

    it("marks an array attribute dirty after mutate-then-set", () => {
        const d = new Doc({ id: "1", meta: {}, tags: ["x"] });
        const tags = d.get("tags") as string[];
        tags.push("y");
        d.set("tags", tags);
        expect(d.isDirty("tags")).toBe(true);
        expect(d.getDirty().tags).toEqual(["x", "y"]);
    });
});

describe("persistence round-trip", () => {
    beforeAll(async () => {
        await env.DB.prepare("DROP TABLE IF EXISTS cast_mut_docs").run();
        await env.DB.prepare(
            "CREATE TABLE cast_mut_docs (id TEXT PRIMARY KEY, meta TEXT, tags TEXT)",
        ).run();
    });

    it("writes an in-place-mutated json field on UPDATE (was silently dropped)", async () => {
        await Doc.create(env.DB, { id: "p1", meta: { v: 1 }, tags: [] });

        const loaded = await Doc.findOrFail(env.DB, "p1");
        const meta = loaded.get("meta") as Record<string, unknown>;
        meta.v = 2;
        loaded.set("meta", meta);
        expect(loaded.isDirty("meta")).toBe(true);
        await loaded.save(env.DB);

        const reloaded = await Doc.findOrFail(env.DB, "p1");
        expect(reloaded.get("meta")).toEqual({ v: 2 });
    });
});

describe("revision before-snapshot integrity", () => {
    beforeAll(async () => {
        await env.DB.prepare(MODEL_REVISIONS_DDL).run();
        await env.DB.prepare("DROP TABLE IF EXISTS cast_mut_rev_docs").run();
        await env.DB.prepare(
            "CREATE TABLE cast_mut_rev_docs (id TEXT PRIMARY KEY, meta TEXT, created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '')",
        ).run();
    });

    beforeEach(async () => {
        await env.DB.prepare("DELETE FROM cast_mut_rev_docs").run();
        await env.DB.prepare("DELETE FROM model_revisions WHERE model_table = 'cast_mut_rev_docs'").run();
    });

    it("records the pre-mutation value in the before-snapshot, not the mutated one", async () => {
        await RevDoc.create(env.DB, { id: "r1", meta: { v: 1 } });

        const loaded = await RevDoc.findOrFail(env.DB, "r1");
        const meta = loaded.get("meta") as Record<string, unknown>;
        meta.v = 2;
        loaded.set("meta", meta);
        await loaded.save(env.DB);

        const rows = await env.DB.prepare(
            "SELECT before_json, after_json FROM model_revisions WHERE model_table = ? AND model_id = ? AND action = 'update' ORDER BY created_at DESC",
        ).bind("cast_mut_rev_docs", "r1").all<{ before_json: string | null; after_json: string | null }>();

        const rev = rows.results?.[0];
        expect(rev).toBeTruthy();
        const before = JSON.parse(rev!.before_json ?? "{}");
        const after = JSON.parse(rev!.after_json ?? "{}");
        const parseMeta = (m: unknown) => (typeof m === "string" ? JSON.parse(m) : m);
        // before must show the OLD value (baseline not corrupted by the in-place mutation)
        expect(parseMeta(before.meta)).toEqual({ v: 1 });
        expect(parseMeta(after.meta)).toEqual({ v: 2 });
    });
});
