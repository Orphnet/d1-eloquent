import { describe, it, expect } from "vitest";
import { parseModelSource, parseMigrationSource, sqliteTypeToTs } from "../parser";

// ─── Model parsing ───────────────────────────────────────────────────────────

const BASIC_MODEL = `
import { BaseModel } from "@orphnet/d1-eloquent";

export type TUserAttrs = {
  id: string;
  name: string;
  email: string;
  created_at: string;
  updated_at: string;
};

export class User extends BaseModel<TUserAttrs> {
  public static table = "users";
  public static primaryKey = "id";
  public static softDeletes = false;
}
`;

const FULL_MODEL = `
import { BaseModel, type TRelationDefinition } from "@orphnet/d1-eloquent";

export type TPostAttrs = {
  id: string;
  title: string;
  body: string;
  user_id: string;
  status?: string | null;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
};

export class Post extends BaseModel<TPostAttrs> {
  public static table = "posts";
  public static primaryKey = "id";
  public static timestamps = true;
  public static softDeletes = true;

  public static relations: Record<string, TRelationDefinition> = {
    author: { type: "belongsTo", model: () => User, foreignKey: "user_id" },
    comments: { type: "hasMany", model: () => Comment, foreignKey: "post_id" },
  };

  public static casts = { status: "string" };

  public static scopes = {
    published: (q: any) => q.where("status", "=", "published"),
    recent: (q: any) => q.orderBy("created_at", "desc"),
  };

  public static hooks = {
    beforeCreate: async (model: any) => { model.set("status", "draft"); },
    afterDelete: async (model: any) => { console.log("deleted"); },
  };
}
`;

describe("parseModelSource", () => {
  it("extracts basic model metadata", () => {
    const meta = parseModelSource(BASIC_MODEL)!;
    expect(meta).not.toBeNull();
    expect(meta.className).toBe("User");
    expect(meta.attrsType).toBe("TUserAttrs");
    expect(meta.table).toBe("users");
    expect(meta.primaryKey).toBe("id");
    expect(meta.softDeletes).toBe(false);
  });

  it("extracts type fields", () => {
    const meta = parseModelSource(BASIC_MODEL)!;
    expect(meta.fields).toHaveLength(5);
    expect(meta.fields[0]).toEqual({ name: "id", tsType: "string", optional: false });
    expect(meta.fields[1]).toEqual({ name: "name", tsType: "string", optional: false });
  });

  it("extracts relations", () => {
    const meta = parseModelSource(FULL_MODEL)!;
    expect(meta.relations).toHaveLength(2);
    expect(meta.relations[0]).toEqual({
      name: "author",
      type: "belongsTo",
      foreignKey: "user_id",
      pivot: undefined,
    });
    expect(meta.relations[1]).toEqual({
      name: "comments",
      type: "hasMany",
      foreignKey: "post_id",
      pivot: undefined,
    });
  });

  it("extracts casts", () => {
    const meta = parseModelSource(FULL_MODEL)!;
    expect(meta.casts).toEqual({ status: "string" });
  });

  it("extracts scopes", () => {
    const meta = parseModelSource(FULL_MODEL)!;
    expect(meta.scopes).toContain("published");
    expect(meta.scopes).toContain("recent");
  });

  it("extracts hooks", () => {
    const meta = parseModelSource(FULL_MODEL)!;
    expect(meta.hooks).toContain("beforeCreate");
    expect(meta.hooks).toContain("afterDelete");
  });

  it("extracts optional fields", () => {
    const meta = parseModelSource(FULL_MODEL)!;
    const status = meta.fields.find((f) => f.name === "status");
    expect(status?.optional).toBe(true);
    expect(status?.tsType).toBe("string | null");
  });

  it("defaults timestamps to true when not specified", () => {
    const meta = parseModelSource(BASIC_MODEL)!;
    expect(meta.timestamps).toBe(true);
  });

  it("reads explicit timestamps=true", () => {
    const meta = parseModelSource(FULL_MODEL)!;
    expect(meta.timestamps).toBe(true);
  });

  it("returns null for non-model files", () => {
    expect(parseModelSource("const x = 1;")).toBeNull();
  });
});

// ─── Migration parsing ──────────────────────────────────────────────────────

const BASIC_MIGRATION = `
import type { TMigration } from "@orphnet/d1-eloquent/cli";
import { Schema } from "@orphnet/d1-eloquent/cli";

const migration: TMigration = {
  name: "20260329_create_users",

  up: (schema: Schema) => {
    schema.createTable("users", (t) => {
      t.id();
      t.text("name", { nullable: false });
      t.text("email", { nullable: false });
      t.integer("age");
      t.boolean("active", { default: true });
      t.timestamps();
    });
  },

  down: (schema: Schema) => {
    schema.dropTable("users");
  },
};

export default migration;
`;

const FK_MIGRATION = `
import type { TMigration } from "@orphnet/d1-eloquent/cli";
import { Schema } from "@orphnet/d1-eloquent/cli";

const migration: TMigration = {
  name: "20260329_create_posts",

  up: (schema: Schema) => {
    schema.createTable("posts", (t) => {
      t.id();
      t.text("title", { nullable: false });
      t.text("user_id", { nullable: false }).constrained("users");
      t.text("category_id").references("categories", "id");
      t.timestamps();
      t.softDeletes();
    });
  },

  down: (schema: Schema) => {
    schema.dropTable("posts");
  },
};

export default migration;
`;

describe("parseMigrationSource", () => {
  it("extracts migration name and table", () => {
    const meta = parseMigrationSource(BASIC_MIGRATION)!;
    expect(meta).not.toBeNull();
    expect(meta.name).toBe("20260329_create_users");
    expect(meta.table).toBe("users");
  });

  it("extracts columns with types", () => {
    const meta = parseMigrationSource(BASIC_MIGRATION)!;
    const names = meta.columns.map((c) => c.name);
    expect(names).toContain("id");
    expect(names).toContain("name");
    expect(names).toContain("email");
    expect(names).toContain("age");
    expect(names).toContain("active");
    expect(names).toContain("created_at");
    expect(names).toContain("updated_at");
  });

  it("parses column types correctly", () => {
    const meta = parseMigrationSource(BASIC_MIGRATION)!;
    const id = meta.columns.find((c) => c.name === "id")!;
    expect(id.type).toBe("TEXT");
    expect(id.primary).toBe(true);

    const age = meta.columns.find((c) => c.name === "age")!;
    expect(age.type).toBe("INTEGER");

    // boolean maps to INTEGER in SQLite
    const active = meta.columns.find((c) => c.name === "active")!;
    expect(active.type).toBe("INTEGER");
  });

  it("detects timestamps", () => {
    const meta = parseMigrationSource(BASIC_MIGRATION)!;
    expect(meta.hasTimestamps).toBe(true);
  });

  it("detects soft deletes", () => {
    const meta = parseMigrationSource(FK_MIGRATION)!;
    expect(meta.hasSoftDeletes).toBe(true);
  });

  it("extracts foreign keys", () => {
    const meta = parseMigrationSource(FK_MIGRATION)!;
    expect(meta.foreignKeys).toContainEqual({ column: "user_id", references: "users" });
    expect(meta.foreignKeys).toContainEqual({ column: "category_id", references: "categories" });
  });

  it("returns null for non-migration files", () => {
    expect(parseMigrationSource("const x = 1;")).toBeNull();
  });

  it("recognises t.json() columns", () => {
    const src = `
      const migration = {
        name: "20260417_create_docs",
        up: (schema) => {
          schema.createTable("docs", (t) => {
            t.id();
            t.json("payload");
          });
        },
      };
    `;
    const meta = parseMigrationSource(src)!;
    const payload = meta.columns.find((c) => c.name === "payload");
    expect(payload).toBeDefined();
    expect(payload!.type).toBe("JSON");
  });

  it("recognises t.blob() columns", () => {
    const src = `
      const migration = {
        name: "20260417_create_files",
        up: (schema) => {
          schema.createTable("files", (t) => {
            t.id();
            t.blob("data");
          });
        },
      };
    `;
    const meta = parseMigrationSource(src)!;
    const data = meta.columns.find((c) => c.name === "data");
    expect(data).toBeDefined();
    expect(data!.type).toBe("BLOB");
  });
});

// ─── Type mapping ───────────────────────────────────────────────────────────

describe("sqliteTypeToTs", () => {
  it("maps TEXT to string", () => {
    expect(sqliteTypeToTs({ name: "x", type: "TEXT", nullable: false, primary: false, hasDefault: false })).toBe("string");
  });

  it("maps INTEGER to number", () => {
    expect(sqliteTypeToTs({ name: "x", type: "INTEGER", nullable: false, primary: false, hasDefault: false })).toBe("number");
  });

  it("maps REAL to number", () => {
    expect(sqliteTypeToTs({ name: "x", type: "REAL", nullable: false, primary: false, hasDefault: false })).toBe("number");
  });

  it("maps BLOB to ArrayBuffer", () => {
    expect(sqliteTypeToTs({ name: "x", type: "BLOB", nullable: false, primary: false, hasDefault: false })).toBe("ArrayBuffer");
  });

  it("maps JSON to unknown", () => {
    expect(sqliteTypeToTs({ name: "x", type: "JSON", nullable: false, primary: false, hasDefault: false })).toBe("unknown");
  });
});
