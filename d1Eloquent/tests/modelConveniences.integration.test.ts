// modelConveniences.integration.test.ts
// Live D1 tests for wasRecentlyCreated + replicate().

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BaseModel } from "../baseModel";

interface WidgetAttrs {
    id?: string;
    name?: string;
    slug?: string;
    created_at?: string | Date;
    updated_at?: string | Date;
    deleted_at?: string | Date | null;
}

class Widget extends BaseModel<WidgetAttrs> {
    static table = "mc_widgets";
    static softDeletes = true;
}

beforeAll(async () => {
    await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS mc_widgets (
            id TEXT PRIMARY KEY, name TEXT, slug TEXT,
            created_at TEXT, updated_at TEXT, deleted_at TEXT
        )`,
    ).run();
});

beforeEach(async () => {
    await env.DB.prepare("DELETE FROM mc_widgets").run();
});

describe("wasRecentlyCreated", () => {
    it("is true right after create(), false after loading", async () => {
        const w = await Widget.create(env.DB, { name: "A" });
        expect(w.wasRecentlyCreated).toBe(true);

        const loaded = await Widget.find(env.DB, w.getKey<string>()!);
        expect(loaded!.wasRecentlyCreated).toBe(false);
    });

    it("is false after an update (save that UPDATEs)", async () => {
        const w = await Widget.find(env.DB, (await Widget.create(env.DB, { name: "B" })).getKey<string>()!);
        w!.set("name", "B2");
        await w!.save(env.DB);
        expect(w!.wasRecentlyCreated).toBe(false);
    });

    it("is true for every row from createMany()", async () => {
        const rows = await Widget.createMany(env.DB, [{ name: "x" }, { name: "y" }]);
        rows.forEach((r) => expect(r.wasRecentlyCreated).toBe(true));
    });

    it("distinguishes create vs find in firstOrCreate", async () => {
        const first = await Widget.firstOrCreate(env.DB, { name: "unique" });
        expect(first.wasRecentlyCreated).toBe(true);
        const second = await Widget.firstOrCreate(env.DB, { name: "unique" });
        expect(second.wasRecentlyCreated).toBe(false); // found existing
    });
});

describe("replicate()", () => {
    it("clones attributes but strips pk, timestamps, deleted_at", async () => {
        const original = await Widget.create(env.DB, { name: "Orig", slug: "orig-slug" });
        const clone = original.replicate();

        expect(clone.get("name")).toBe("Orig");
        expect(clone.get("slug")).toBe("orig-slug");
        expect(clone.getKey()).toBeNull(); // pk stripped
        expect(clone._persisted).toBe(false); // unsaved
    });

    it("persists as a new row with a fresh key on save()", async () => {
        const original = await Widget.create(env.DB, { name: "Orig" });
        const clone = await original.replicate().save(env.DB);

        expect(clone.getKey<string>()).toBeTruthy();
        expect(clone.getKey()).not.toBe(original.getKey()); // new key
        const count = await Widget.query().whereEq("name", "Orig").count(env.DB);
        expect(count).toBe(2); // original + clone
    });

    it("strips additional keys passed in `except`", async () => {
        const original = await Widget.create(env.DB, { name: "Orig", slug: "keep-unique" });
        const clone = original.replicate(["slug"]);
        expect(clone.get("name")).toBe("Orig");
        expect(clone.get("slug")).toBeUndefined(); // excluded
    });

    // Regression (#45): the clone's copied attributes must be dirty, so isDirty()
    // reports true and save() actually persists them (before the fix the clone was
    // built via the constructor and had an empty dirty set).
    it("marks the clone's attributes dirty (isDirty() is true before save)", async () => {
        const original = await Widget.create(env.DB, { name: "Orig", slug: "s" });
        const clone = original.replicate();
        expect(clone.isDirty()).toBe(true);
        expect(clone.isDirty("name")).toBe(true);
    });

    // Regression (#45): replicating a *trashed* model must yield a FRESH, un-trashed
    // clone. This is the non-vacuous version of "strips deleted_at" — the original is
    // genuinely soft-deleted (deleted_at set) before replicate(), so the clone can only
    // be un-trashed if replicate() actively strips deleted_at.
    it("strips deleted_at from a soft-deleted original, yielding a fresh clone", async () => {
        const original = await Widget.create(env.DB, { name: "Trashy", slug: "trash-slug" });
        await original.delete(env.DB); // soft delete -> sets deleted_at on the instance
        expect(original.trashed()).toBe(true); // guard: the source really is trashed
        expect(original.get("deleted_at")).toBeTruthy();

        const clone = original.replicate();

        // deleted_at not carried over: attribute stripped, so trashed()/exists() are fresh.
        expect(clone.get("deleted_at")).toBeUndefined();
        expect(clone.trashed()).toBe(false);
        expect(clone.exists()).toBe(false); // no pk -> brand-new record
        expect(clone._persisted).toBe(false); // unsaved
        // Copied columns still carried over and dirty (fix already landed).
        expect(clone.get("name")).toBe("Trashy");
        expect(clone.isDirty()).toBe(true);
        expect(clone.isDirty("name")).toBe(true);
    });
});

describe("replicate() — create revision diff (regression #45)", () => {
    class McAudited extends BaseModel<{ id?: string; name?: string; qty?: number }> {
        static table = "mc_aud";
        static timestamps = false;
        static revisions = { enabled: true, mode: "diff" } as const;
    }
    beforeAll(async () => {
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS mc_aud (id TEXT PRIMARY KEY, name TEXT, qty INTEGER)`).run();
        await env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS model_revisions (
              id TEXT PRIMARY KEY, model_table TEXT NOT NULL, model_pk TEXT NOT NULL,
              model_id TEXT NOT NULL, action TEXT NOT NULL, diff_json TEXT,
              before_json TEXT, after_json TEXT, actor_id TEXT, request_id TEXT,
              reason TEXT, created_at TEXT NOT NULL
            )`).run();
    });
    beforeEach(async () => {
        await env.DB.prepare("DELETE FROM mc_aud").run();
        await env.DB.prepare("DELETE FROM model_revisions").run();
    });

    it("a replicated clone's save() records a full (non-empty) create revision", async () => {
        const orig = await McAudited.create(env.DB, { name: "A", qty: 5 });
        const clone = await orig.replicate().save(env.DB);
        const rev = await env.DB.prepare("SELECT diff_json, action FROM model_revisions WHERE model_id = ?")
            .bind(clone.getKey()).first<{ diff_json: string; action: string }>();
        expect(rev).not.toBeNull();
        expect(rev!.action).toBe("create");
        expect(JSON.parse(rev!.diff_json)).toMatchObject({ name: "A", qty: 5 }); // before fix: {}
    });
});
