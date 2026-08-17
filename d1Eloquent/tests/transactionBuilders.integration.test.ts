import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BaseModel } from "../baseModel";

interface DocAttrs { id?: string; meta?: string }
class TbDoc extends BaseModel<DocAttrs> { static table = "tb_docs"; static timestamps = false; }

beforeAll(async () => {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS tb_docs (id TEXT PRIMARY KEY, meta TEXT)`).run();
});
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM tb_docs").run();
  await TbDoc.create(env.DB, { id: "d1", meta: JSON.stringify({ a: 1 }) });
});

describe("toUpdateJson*Prepared builders", () => {
  it("toUpdateJsonSetPrepared produces a runnable stmt equivalent to updateJsonSet", async () => {
    const stmt = TbDoc.query().whereEq("id", "d1").toUpdateJsonSetPrepared(env.DB, "meta", "$.a", 9);
    const res = await stmt.run();
    expect(res.meta?.changes).toBe(1);
    const row = await TbDoc.find(env.DB, "d1");
    expect(JSON.parse(row!.get("meta") as string).a).toBe(9);
  });
});
