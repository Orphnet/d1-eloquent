import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { RevisionManager } from "../revisionManager";

beforeAll(async () => {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS model_revisions (
    id TEXT PRIMARY KEY, model_table TEXT, model_pk TEXT, model_id TEXT, action TEXT,
    diff_json TEXT, before_json TEXT, after_json TEXT, actor_id TEXT, request_id TEXT,
    reason TEXT, created_at TEXT)`).run();
});

describe("RevisionManager.buildRevisionStatement", () => {
    it("returns a runnable INSERT that writes a revision row", async () => {
        const stmt = RevisionManager.buildRevisionStatement({
            db: env.DB, modelTable: "posts", modelPk: "id", modelId: "p1", action: "create",
            config: { enabled: true, mode: "snapshot" } as never, after: { id: "p1", title: "x" },
        });
        expect(stmt).not.toBeNull();
        await stmt!.run();
        const row = await env.DB.prepare("SELECT * FROM model_revisions WHERE model_id = 'p1'").first();
        expect(row).not.toBeNull();
        expect((row as { action: string }).action).toBe("create");
    });

    it("returns null when revisions are disabled", () => {
        const stmt = RevisionManager.buildRevisionStatement({
            db: env.DB, modelTable: "posts", modelPk: "id", modelId: "p1", action: "create",
            config: { enabled: false, mode: "snapshot" } as never,
        });
        expect(stmt).toBeNull();
    });
});
