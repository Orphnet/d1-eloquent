import { describe, it, expect } from "vitest";
import { parseModelSource, parseMigrationSource, parseMigrationSourceForTable, type TColumnDef } from "../parser";
import {
  resolveSqliteType,
  deriveModelColumns,
  accumulateDeclaredColumns,
  diffColumns,
  renderMigration,
  isEmptyDiff,
} from "../schemaDiff";

const MODEL = `
import { BaseModel } from "@orphnet/d1-eloquent";

export type TPostAttrs = {
  id: string;
  title: string;
  views: number;
  is_published?: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export class Post extends BaseModel<TPostAttrs> {
  public static table = "posts";
  public static primaryKey = "id";
  public static timestamps = true;
  public static softDeletes = true;
  public static casts = { is_published: "boolean", metadata: "json", views: "integer" } as const;
}
`;

const col = (name: string, type: TColumnDef["type"], extra: Partial<TColumnDef> = {}): TColumnDef => ({
  name, type, nullable: false, primary: false, hasDefault: false, ...extra,
});

describe("resolveSqliteType", () => {
  it("prefers cast intent over the raw TS type", () => {
    expect(resolveSqliteType("boolean", "boolean")).toBe("INTEGER");
    expect(resolveSqliteType("string", "json")).toBe("JSON");
    expect(resolveSqliteType("string", "date")).toBe("TEXT");
    expect(resolveSqliteType("number", "real")).toBe("REAL");
    // blob cast wins even when the raw TS type (unknown) would resolve to JSON.
    expect(resolveSqliteType("unknown", "blob")).toBe("BLOB");
  });

  it("falls back to the TS type when uncast", () => {
    expect(resolveSqliteType("string")).toBe("TEXT");
    expect(resolveSqliteType("number")).toBe("INTEGER");
    expect(resolveSqliteType("boolean")).toBe("INTEGER");
    expect(resolveSqliteType("ArrayBuffer")).toBe("BLOB");
    expect(resolveSqliteType("string[]")).toBe("JSON");
    expect(resolveSqliteType("Record<string, unknown>")).toBe("JSON");
    expect(resolveSqliteType("string | null")).toBe("TEXT");
  });
});

describe("deriveModelColumns", () => {
  it("derives fields + timestamps + softDeletes with cast-refined types", () => {
    const model = parseModelSource(MODEL)!;
    const cols = deriveModelColumns(model);
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));

    expect(byName.id).toMatchObject({ type: "TEXT", primary: true });
    expect(byName.title.type).toBe("TEXT");
    expect(byName.views.type).toBe("INTEGER"); // integer cast
    expect(byName.is_published).toMatchObject({ type: "INTEGER", nullable: true }); // optional + boolean cast
    expect(byName.metadata.type).toBe("JSON"); // json cast
    expect(byName.created_at.type).toBe("TEXT");
    expect(byName.updated_at.type).toBe("TEXT");
    expect(byName.deleted_at).toMatchObject({ type: "TEXT", nullable: true }); // softDeletes
  });
});

describe("diffColumns", () => {
  const desired = [col("id", "TEXT", { primary: true }), col("title", "TEXT"), col("views", "INTEGER")];

  it("flags a brand-new table", () => {
    const diff = diffColumns("posts", desired, [], false);
    expect(diff.isNewTable).toBe(true);
    expect(diff.added).toHaveLength(3);
    expect(isEmptyDiff(diff)).toBe(false);
  });

  it("detects added columns against an existing table", () => {
    const declared = [col("id", "TEXT", { primary: true }), col("title", "TEXT")];
    const diff = diffColumns("posts", desired, declared, true);
    expect(diff.isNewTable).toBe(false);
    expect(diff.added.map((c) => c.name)).toEqual(["views"]);
    expect(diff.dropped).toHaveLength(0);
  });

  it("detects dropped columns (destructive)", () => {
    const declared = [col("id", "TEXT", { primary: true }), col("title", "TEXT"), col("views", "INTEGER"), col("legacy", "TEXT")];
    const diff = diffColumns("posts", desired, declared, true);
    expect(diff.dropped.map((c) => c.name)).toEqual(["legacy"]);
  });

  it("flags a storage-class change", () => {
    const declared = [col("id", "TEXT", { primary: true }), col("title", "TEXT"), col("views", "TEXT")];
    const diff = diffColumns("posts", desired, declared, true);
    expect(diff.typeChanged).toEqual([{ name: "views", from: "TEXT", to: "INTEGER" }]);
  });

  it("is empty when model and migrations agree", () => {
    const diff = diffColumns("posts", desired, desired, true);
    expect(isEmptyDiff(diff)).toBe(true);
  });

  it("does NOT flag a phantom TEXT→JSON change for the t.text + json-cast pattern", () => {
    // A migration declares t.text("meta") (TEXT); the model json-casts it (JSON tag).
    // JSON and TEXT are the same SQLite storage class, so this is in-sync, not a change.
    const desiredJson = [col("id", "TEXT", { primary: true }), col("meta", "JSON")];
    const declaredText = [col("id", "TEXT", { primary: true }), col("meta", "TEXT")];
    const diff = diffColumns("posts", desiredJson, declaredText, true);
    expect(diff.typeChanged).toEqual([]);
    expect(isEmptyDiff(diff)).toBe(true);
  });

  it("still flags a real storage-class change against a JSON-tagged column", () => {
    const desiredJson = [col("id", "TEXT", { primary: true }), col("n", "JSON")];
    const declaredInt = [col("id", "TEXT", { primary: true }), col("n", "INTEGER")];
    expect(diffColumns("posts", desiredJson, declaredInt, true).typeChanged)
      .toEqual([{ name: "n", from: "INTEGER", to: "JSON" }]);
  });
});

describe("accumulateDeclaredColumns", () => {
  it("unions columns across migrations, last-write-wins", () => {
    const cols = accumulateDeclaredColumns([
      { name: "m1", table: "posts", columns: [col("id", "TEXT"), col("title", "TEXT")], hasTimestamps: false, hasSoftDeletes: false, foreignKeys: [] },
      { name: "m2", table: "posts", columns: [col("views", "TEXT"), col("title", "TEXT", { nullable: true })], hasTimestamps: false, hasSoftDeletes: false, foreignKeys: [] },
    ]);
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(Object.keys(byName).sort()).toEqual(["id", "title", "views"]);
    expect(byName.title.nullable).toBe(true); // m2 overrode m1
  });
});

describe("renderMigration", () => {
  it("renders createTable for a new table, collapsing timestamps + softDeletes", () => {
    const model = parseModelSource(MODEL)!;
    const diff = diffColumns("posts", deriveModelColumns(model), [], false);
    const out = renderMigration("20260707_create_posts", diff, "id");

    expect(out).toContain('schema.createTable("posts"');
    expect(out).toContain("t.id();");
    // Required columns emit an explicit NOT NULL (nullable: false); optional ones nullable: true.
    expect(out).toContain('t.integer("views", { nullable: false });');
    expect(out).toContain('t.json("metadata", { nullable: false });');
    expect(out).toContain('t.integer("is_published", { nullable: true });');
    expect(out).toContain("t.timestamps();");
    expect(out).toContain("t.softDeletes();");
    expect(out).toContain('schema.dropTable("posts");');
    // timestamps collapsed — no explicit created_at/updated_at column calls
    expect(out).not.toContain('t.text("created_at")');
  });

  it("renders add/drop alters and reverses them in down()", () => {
    const desired = [col("id", "TEXT", { primary: true }), col("title", "TEXT"), col("slug", "TEXT", { nullable: true })];
    const declared = [col("id", "TEXT", { primary: true }), col("title", "TEXT"), col("legacy", "TEXT")];
    const diff = diffColumns("posts", desired, declared, true);
    const out = renderMigration("20260707_update_posts", diff, "id");

    expect(out).toContain('schema.table("posts"');
    // Alter mode uses add* methods, not create-only t.text()
    expect(out).toContain('t.addText("slug", { nullable: true });');
    expect(out).toContain('t.dropColumn("legacy");');
    expect(out).toContain("destructive");
    // down reverses: drop the added slug, re-add legacy
    const downIdx = out.indexOf("down:");
    expect(out.slice(downIdx)).toContain('t.dropColumn("slug");');
    expect(out.slice(downIdx)).toContain('t.addText("legacy");');
  });
});

describe("nullability derivation", () => {
  it("treats a `| null` union field as nullable (not just `?`)", () => {
    const model = parseModelSource(`
      export type TDocAttrs = { id: string; subtitle: string | null };
      export class Doc extends BaseModel<TDocAttrs> {
        public static table = "docs";
        public static primaryKey = "id";
      }
    `)!;
    const byName = Object.fromEntries(deriveModelColumns(model).map((c) => [c.name, c]));
    expect(byName.subtitle.nullable).toBe(true);
  });
});

describe("declared-column read-back round-trips alter migrations", () => {
  const CREATE = `
    const migration = {
      name: "0001_create_posts",
      up: (schema) => { schema.createTable("posts", (t) => { t.id(); t.text("title", { nullable: false }); }); },
      down: (schema) => { schema.dropTable("posts"); },
    };`;
  const ADD_SLUG = `
    const migration = {
      name: "0002_update_posts",
      up: (schema) => { schema.table("posts", (t) => { t.addText("slug", { nullable: true }); }); },
      down: (schema) => { schema.table("posts", (t) => { t.dropColumn("slug"); }); },
    };`;
  const DROP_SLUG = `
    const migration = {
      name: "0003_update_posts",
      up: (schema) => { schema.table("posts", (t) => { t.dropColumn("slug"); }); },
      down: (schema) => { schema.table("posts", (t) => { t.addText("slug", { nullable: true }); }); },
    };`;

  it("sees a column added by a prior alter migration (no duplicate re-add)", () => {
    const metas = [parseMigrationSource(CREATE)!, parseMigrationSource(ADD_SLUG)!];
    const declared = accumulateDeclaredColumns(metas);
    const names = declared.map((c) => c.name).sort();
    expect(names).toContain("slug"); // was invisible before — would be re-proposed → duplicate column
    // And a re-diff of the same model reports no change (round-trips).
    const desired = [col("id", "TEXT", { primary: true }), col("title", "TEXT"), col("slug", "TEXT", { nullable: true })];
    expect(isEmptyDiff(diffColumns("posts", desired, declared, true))).toBe(true);
  });

  it("does not double-count the reverse ops in down()", () => {
    // ADD_SLUG's down() drops slug; that must NOT cancel the up() add.
    const declared = accumulateDeclaredColumns([parseMigrationSource(CREATE)!, parseMigrationSource(ADD_SLUG)!]);
    expect(declared.map((c) => c.name)).toContain("slug");
  });

  it("removes a column dropped by a later alter migration", () => {
    const metas = [parseMigrationSource(CREATE)!, parseMigrationSource(ADD_SLUG)!, parseMigrationSource(DROP_SLUG)!];
    const declared = accumulateDeclaredColumns(metas);
    expect(declared.map((c) => c.name)).not.toContain("slug");
  });
});

// ── Regressions for #54's headline fixes (were shipped untested) ──────────────

describe("model parsing — generics & interface attrs (#54)", () => {
  it("extracts attrs from a multi-generic BaseModel<Attrs, Virtuals, Relations>", () => {
    const model = parseModelSource(`
      import { BaseModel } from "@orphnet/d1-eloquent";
      export type TWidgetAttrs = { id: string; label: string; qty: number };
      export type TWidgetVirtuals = { display: string };
      export type TWidgetRelations = { parts: unknown[] };
      export class Widget extends BaseModel<TWidgetAttrs, TWidgetVirtuals, TWidgetRelations> {
        public static table = "widgets";
        public static primaryKey = "id";
      }
    `);
    expect(model).not.toBeNull();
    expect(model!.fields.map((f) => f.name).sort()).toEqual(["id", "label", "qty"]);
  });

  it("extracts attrs declared via `interface` (not just `type`)", () => {
    const model = parseModelSource(`
      import { BaseModel } from "@orphnet/d1-eloquent";
      export interface TDocAttrs {
        id: string;
        title: string;
        body?: string;
      }
      export class Doc extends BaseModel<TDocAttrs> {
        public static table = "docs";
        public static primaryKey = "id";
      }
    `);
    expect(model).not.toBeNull();
    expect(model!.fields.map((f) => f.name).sort()).toEqual(["body", "id", "title"]);
  });
});

describe("generate — table scoping & PK safety (#54)", () => {
  const MULTI = `
    export default {
      name: "20260101_init",
      async up(schema) {
        await schema.createTable("posts", (t) => { t.id(); t.text("title"); t.timestamps(); });
        await schema.createTable("comments", (t) => { t.id(); t.text("body"); t.text("post_id"); });
      },
      async down(schema) { await schema.dropTable("comments"); await schema.dropTable("posts"); },
    };
  `;

  it("scopes columns to the target table in a multi-table migration file", () => {
    expect(parseMigrationSourceForTable(MULTI, "posts")!.columns.map((c) => c.name).sort())
      .toEqual(["created_at", "id", "title", "updated_at"]);
    expect(parseMigrationSourceForTable(MULTI, "comments")!.columns.map((c) => c.name).sort())
      .toEqual(["body", "id", "post_id"]);
  });

  it("does not propose dropping a sibling table's columns (regression: cross-table bleed)", () => {
    const declared = parseMigrationSourceForTable(MULTI, "posts")!.columns;
    const desired = [col("id", "TEXT", { primary: true }), col("title", "TEXT"), col("created_at", "TEXT"), col("updated_at", "TEXT")];
    expect(diffColumns("posts", desired, declared, true).dropped.map((c) => c.name)).toEqual([]);
  });

  it("keeps the primary key in the desired set even when attrs omit it (regression: PK-drop)", () => {
    const model = parseModelSource(`
      import { BaseModel } from "@orphnet/d1-eloquent";
      export type TThingAttrs = { name: string; qty: number };
      export class Thing extends BaseModel<TThingAttrs> {
        public static table = "things";
        public static primaryKey = "id";
      }
    `)!;
    const desired = deriveModelColumns(model);
    expect(desired.some((c) => c.name === "id" && c.primary)).toBe(true);
    const declared = [col("id", "TEXT", { primary: true }), col("name", "TEXT"), col("qty", "INTEGER")];
    expect(diffColumns("things", desired, declared, true).dropped.map((c) => c.name)).not.toContain("id");
  });
});
