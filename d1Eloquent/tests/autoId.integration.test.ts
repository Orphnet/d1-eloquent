// autoId.integration.test.ts
// Live D1 tests for automatic primary-key generation on create / createMany / save.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { BaseModel } from "../baseModel";
import type { TKeyStrategy } from "../idGenerator";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CROCKFORD_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

interface WidgetAttrs {
    id?: string;
    name?: string;
    created_at?: string | Date;
    updated_at?: string | Date;
}

// Default strategy (uuid) — no keyStrategy declared.
class Widget extends BaseModel<WidgetAttrs> {
    static table = "auto_widgets";
    static timestamps = true;
}

// Explicit ULID strategy.
class UlidWidget extends BaseModel<WidgetAttrs> {
    static table = "auto_widgets";
    static timestamps = true;
    static keyStrategy: TKeyStrategy = "ulid";
}

// Explicit UUIDv7 strategy.
class V7Widget extends BaseModel<WidgetAttrs> {
    static table = "auto_widgets";
    static timestamps = true;
    static keyStrategy: TKeyStrategy = "uuidv7";
}

// Custom generator function.
let customCounter = 0;
class CustomWidget extends BaseModel<WidgetAttrs> {
    static table = "auto_widgets";
    static timestamps = true;
    static keyStrategy: TKeyStrategy = (ctx) => `${ctx.table}-${ctx.keyName}-${++customCounter}`;
}

// Auto-id disabled — must still throw when no id is supplied.
class StrictWidget extends BaseModel<WidgetAttrs> {
    static table = "auto_widgets";
    static timestamps = true;
    static keyStrategy: TKeyStrategy = false;
}

// Mass-assignment-guarded id: client-supplied id is dropped by fill(), so the
// server always assigns the key. Demonstrates the security synergy.
class GuardedWidget extends BaseModel<WidgetAttrs> {
    static table = "auto_widgets";
    static timestamps = true;
    static guarded = ["id"];
}

// Non-default primary-key column name.
interface TokenAttrs {
    token_id?: string;
    label?: string;
    created_at?: string | Date;
    updated_at?: string | Date;
}
class Token extends BaseModel<TokenAttrs> {
    static table = "auto_tokens";
    static primaryKey = "token_id";
    static timestamps = true;
}

beforeAll(async () => {
    await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS auto_widgets (
            id TEXT PRIMARY KEY,
            name TEXT,
            created_at TEXT,
            updated_at TEXT
        )`,
    ).run();
    await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS auto_tokens (
            token_id TEXT PRIMARY KEY,
            label TEXT,
            created_at TEXT,
            updated_at TEXT
        )`,
    ).run();
});

beforeEach(async () => {
    await env.DB.prepare("DELETE FROM auto_widgets").run();
    await env.DB.prepare("DELETE FROM auto_tokens").run();
});

describe("create() — auto primary key", () => {
    it("generates a v4 UUID by default when no id is supplied", async () => {
        const w = await Widget.create(env.DB, { name: "Alpha" });
        const id = w.getKey<string>();
        expect(id).toMatch(UUID_RE);

        // Persisted under the generated id.
        const found = await Widget.find(env.DB, id!);
        expect(found?.get("name")).toBe("Alpha");
    });

    it("respects an explicitly supplied id", async () => {
        const w = await Widget.create(env.DB, { id: "explicit-123", name: "Beta" });
        expect(w.getKey()).toBe("explicit-123");
        expect(await Widget.find(env.DB, "explicit-123")).not.toBeNull();
    });

    it("uses the ULID strategy when configured", async () => {
        const w = await UlidWidget.create(env.DB, { name: "Gamma" });
        expect(w.getKey<string>()).toMatch(CROCKFORD_RE);
    });

    it("uses the UUIDv7 strategy when configured", async () => {
        const w = await V7Widget.create(env.DB, { name: "Delta" });
        const id = w.getKey<string>()!;
        expect(id).toMatch(UUID_RE);
        expect(id[14]).toBe("7");
    });

    it("uses a custom generator function with model context", async () => {
        const w = await CustomWidget.create(env.DB, { name: "Epsilon" });
        expect(w.getKey<string>()).toMatch(/^auto_widgets-id-\d+$/);
    });

    it("generates onto a non-default primary-key column", async () => {
        const t = await Token.create(env.DB, { label: "api" });
        expect(t.getKey<string>()).toMatch(UUID_RE);
        expect(t.get("token_id")).toMatch(UUID_RE);
    });

    it("drops a guarded client id and assigns a server-generated one", async () => {
        const w = await GuardedWidget.create(env.DB, { id: "attacker-supplied", name: "Zeta" });
        const id = w.getKey<string>()!;
        expect(id).not.toBe("attacker-supplied");
        expect(id).toMatch(UUID_RE);
    });
});

describe("keyStrategy = false — auto-id disabled", () => {
    it("throws when no id is supplied", async () => {
        await expect(StrictWidget.create(env.DB, { name: "NoId" })).rejects.toThrow(/primary key/i);
    });

    it("still persists when an id is supplied", async () => {
        const w = await StrictWidget.create(env.DB, { id: "manual-1", name: "HasId" });
        expect(w.getKey()).toBe("manual-1");
    });
});

describe("save() on a new instance — auto primary key", () => {
    it("generates an id at save time", async () => {
        const w = new Widget({ name: "Saved" });
        expect(w.getKey()).toBeNull();
        await w.save(env.DB);
        expect(w.getKey<string>()).toMatch(UUID_RE);
    });
});

describe("createMany() — auto primary key", () => {
    it("generates ids for every row when none are supplied", async () => {
        const rows = await Widget.createMany(env.DB, [{ name: "A" }, { name: "B" }, { name: "C" }]);
        const ids = rows.map((r) => r.getKey<string>()!);
        expect(ids).toHaveLength(3);
        ids.forEach((id) => expect(id).toMatch(UUID_RE));
        expect(new Set(ids).size).toBe(3); // all distinct

        const count = await Widget.query().count(env.DB);
        expect(count).toBe(3);
    });

    it("respects supplied ids and fills only the missing ones", async () => {
        const rows = await Widget.createMany(env.DB, [
            { id: "fixed-1", name: "A" },
            { name: "B" },
        ]);
        expect(rows[0].getKey()).toBe("fixed-1");
        expect(rows[1].getKey<string>()).toMatch(UUID_RE);
    });

    it("honours a non-uuid strategy in bulk", async () => {
        const rows = await UlidWidget.createMany(env.DB, [{ name: "A" }, { name: "B" }]);
        rows.forEach((r) => expect(r.getKey<string>()).toMatch(CROCKFORD_RE));
    });
});

describe("firstOrCreate / updateOrCreate — auto primary key", () => {
    it("firstOrCreate generates an id for the created row", async () => {
        const w = await Widget.firstOrCreate(env.DB, { name: "Unique" });
        expect(w.getKey<string>()).toMatch(UUID_RE);
    });

    it("updateOrCreate generates an id for the created row", async () => {
        const w = await Widget.updateOrCreate(env.DB, { name: "UOC" }, { name: "UOC" });
        expect(w.getKey<string>()).toMatch(UUID_RE);
    });
});

describe("BaseModel.dynamic() — auto primary key", () => {
    it("defaults to uuid", async () => {
        const Dyn = BaseModel.dynamic<WidgetAttrs>({ table: "auto_widgets" });
        const w = await Dyn.create(env.DB, { name: "Dyn" });
        expect(w.getKey<string>()).toMatch(UUID_RE);
    });

    it("honours a configured keyStrategy", async () => {
        const Dyn = BaseModel.dynamic<WidgetAttrs>({ table: "auto_widgets", keyStrategy: "ulid" });
        const w = await Dyn.create(env.DB, { name: "DynUlid" });
        expect(w.getKey<string>()).toMatch(CROCKFORD_RE);
    });
});

describe("contract: id stability and falsy-id handling", () => {
    it("does not regenerate the id when re-saving an already-persisted model", async () => {
        const w = await Widget.create(env.DB, { name: "Once" });
        const id1 = w.getKey<string>();
        w.set("name", "Twice");
        await w.save(env.DB);
        expect(w.getKey<string>()).toBe(id1); // key is stable across updates
    });

    it("respects an explicit falsy (empty-string) id and fails loud rather than generating", async () => {
        // KeyManager treats only null/undefined as absent, so an explicit "" is
        // respected — then rejected by the missing-key assert (no silent override).
        await expect(Widget.create(env.DB, { id: "", name: "Empty" })).rejects.toThrow(/primary key/i);
    });
});

describe("keyStrategy via static inheritance (app-wide default pattern)", () => {
    class UlidBaseModel extends BaseModel<WidgetAttrs> {
        static keyStrategy: TKeyStrategy = "ulid";
    }
    class InheritingWidget extends UlidBaseModel {
        static table = "auto_widgets";
        static timestamps = true;
    }

    it("inherits keyStrategy from an intermediate base class", async () => {
        const w = await InheritingWidget.create(env.DB, { name: "Inherited" });
        expect(w.getKey<string>()).toMatch(CROCKFORD_RE);
    });
});

describe("createMany() — strategy coverage", () => {
    it("throws when keyStrategy is false and a row omits its id", async () => {
        await expect(StrictWidget.createMany(env.DB, [{ name: "A" }])).rejects.toThrow(/primary key/i);
    });

    it("invokes a custom generator once per row", async () => {
        const rows = await CustomWidget.createMany(env.DB, [{ name: "A" }, { name: "B" }]);
        rows.forEach((r) => expect(r.getKey<string>()).toMatch(/^auto_widgets-id-\d+$/));
        expect(rows[0].getKey()).not.toBe(rows[1].getKey()); // distinct per-row invocation
    });

    it("generates onto a non-default primary-key column in bulk", async () => {
        const rows = await Token.createMany(env.DB, [{ label: "a" }, { label: "b" }]);
        rows.forEach((r) => expect(r.get("token_id")).toMatch(UUID_RE));
        expect(rows[0].get("token_id")).not.toBe(rows[1].get("token_id"));
    });
});
