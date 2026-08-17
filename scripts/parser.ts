/**
 * Static source file parser for model and migration files.
 *
 * Extracts metadata via regex — no runtime imports needed.
 * Used by inspect, validate, make:dto, and make:types commands.
 */

import { readFile } from "node:fs/promises";

// ─── Types ───────────────────────────────────────────────────────────────────

export type TColumnDef = {
  name: string;
  /**
   * SQLite storage class as reported by the migration parser.
   * `JSON` columns are stored as TEXT but tagged for tooling; `BLOB` is binary.
   */
  type: "TEXT" | "INTEGER" | "REAL" | "BLOB" | "JSON";
  nullable: boolean;
  primary: boolean;
  hasDefault: boolean;
};

export type TRelationDef = {
  name: string;
  type: "belongsTo" | "hasMany" | "hasOne" | "belongsToMany";
  foreignKey?: string;
  pivot?: string;
};

export type TModelMeta = {
  className: string;
  attrsType: string | null;
  table: string | null;
  primaryKey: string;
  timestamps: boolean;
  softDeletes: boolean;
  relations: TRelationDef[];
  casts: Record<string, string>;
  scopes: string[];
  hooks: string[];
  fields: TFieldDef[];
};

export type TFieldDef = {
  name: string;
  tsType: string;
  optional: boolean;
};

export type TMigrationMeta = {
  name: string;
  table: string | null;
  columns: TColumnDef[];
  hasTimestamps: boolean;
  hasSoftDeletes: boolean;
  foreignKeys: { column: string; references: string }[];
  /** Columns removed by an alter-mode `t.dropColumn(...)` in this migration's up(). */
  droppedColumns: string[];
};

// ─── Model parser ────────────────────────────────────────────────────────────

export const parseModelFile = async (filePath: string): Promise<TModelMeta | null> => {
  const src = await readFile(filePath, "utf-8");
  return parseModelSource(src);
};

export const parseModelSource = (src: string): TModelMeta | null => {
  // Match: class ClassName extends BaseModel<TTypeAttrs[, Virtuals[, Relations]]>
  // Capture the FIRST type arg (the attributes type); ignore any further params.
  const classMatch = src.match(/class\s+(\w+)\s+extends\s+BaseModel<\s*(\w+)/);
  if (!classMatch) return null;

  const className = classMatch[1];
  const attrsType = classMatch[2];

  return {
    className,
    attrsType,
    table: extractStringProp(src, "table"),
    primaryKey: extractStringProp(src, "primaryKey") ?? "id",
    timestamps: extractBoolProp(src, "timestamps") ?? true,
    softDeletes: extractBoolProp(src, "softDeletes") ?? false,
    relations: extractRelations(src),
    casts: extractCasts(src),
    scopes: extractObjectKeys(src, "scopes"),
    hooks: extractHookKeys(src),
    fields: extractTypeFields(src, attrsType),
  };
};

// ─── Migration parser ────────────────────────────────────────────────────────

export const parseMigrationFile = async (filePath: string): Promise<TMigrationMeta | null> => {
  const src = await readFile(filePath, "utf-8");
  return parseMigrationSource(src);
};

export const parseMigrationSource = (src: string): TMigrationMeta | null => {
  // Match: name: "20260329_create_users"
  const nameMatch = src.match(/name:\s*["']([^"']+)["']/);
  if (!nameMatch) return null;

  const name = nameMatch[1];

  // Match: schema.createTable("table_name", ...
  const tableMatch = src.match(/(?:schema|s)\.createTable\(\s*["'](\w+)["']/);
  const table = tableMatch ? tableMatch[1] : null;

  const columns = extractMigrationColumns(src);
  const hasTimestamps = /\.timestamps\(\)/.test(src);
  const hasSoftDeletes = /\.softDeletes\(\)/.test(src) || columns.some((c) => c.name === "deleted_at");
  const foreignKeys = extractForeignKeys(src);
  const droppedColumns = extractDroppedColumns(src);

  return { name, table, columns, hasTimestamps, hasSoftDeletes, foreignKeys, droppedColumns };
};

/**
 * Isolate the `createTable` / `alterTable` / `table` blocks for ONE table, so a
 * migration file that defines several tables doesn't attribute every table's
 * columns to whichever one is being diffed. Each block runs from its table
 * declaration to the next table declaration (blocks never nest in practice).
 */
const tableBlocksOf = (src: string, table: string): string => {
  const re = /\.(?:createTable|alterTable|table)\(\s*["'](\w+)["']/g;
  const marks: { table: string; start: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) marks.push({ table: m[1], start: m.index });
  let out = "";
  for (let i = 0; i < marks.length; i++) {
    if (marks[i].table !== table) continue;
    const end = i + 1 < marks.length ? marks[i + 1].start : src.length;
    out += `${src.slice(marks[i].start, end)}\n`;
  }
  return out;
};

/**
 * Like {@link parseMigrationSource} but scoped to a single `table`: only that
 * table's own column/drop/FK declarations are returned. Used by `generate` when
 * reconstructing one model's declared schema across many migration files.
 */
export const parseMigrationSourceForTable = (src: string, table: string): TMigrationMeta | null => {
  const nameMatch = src.match(/name:\s*["']([^"']+)["']/);
  if (!nameMatch) return null;
  // Scope to up() (ignore down()'s reverse ops) then to this table's blocks.
  const scoped = tableBlocksOf(upBlockOf(src), table);
  const columns = extractMigrationColumns(scoped);
  const hasTimestamps = /\.timestamps\(\)/.test(scoped);
  const hasSoftDeletes = /\.softDeletes\(\)/.test(scoped) || columns.some((c) => c.name === "deleted_at");
  const foreignKeys = extractForeignKeys(scoped);
  const droppedColumns = [...scoped.matchAll(/t\.dropColumn\(\s*["'](\w+)["']\s*\)/g)].map((mm) => mm[1]);
  return { name: nameMatch[1], table, columns, hasTimestamps, hasSoftDeletes, foreignKeys, droppedColumns };
};

/**
 * Isolate a migration's `up()` body so alter-mode parsing ignores the reverse
 * operations in `down()` (a `dropColumn` for every `addText`, and vice-versa).
 * Falls back to the whole source if no `down` boundary is found.
 */
const upBlockOf = (src: string): string => {
  const m = src.match(/\bup\s*[:(][\s\S]*?(?=\n\s*(?:async\s+)?down\s*[:(])/);
  return m ? m[0] : src;
};

/** Column names removed by an alter-mode `t.dropColumn("name")` in up(). */
const extractDroppedColumns = (src: string): string[] => {
  const up = upBlockOf(src);
  return [...up.matchAll(/t\.dropColumn\(\s*["'](\w+)["']\s*\)/g)].map((m) => m[1]);
};

// ─── Extraction helpers ──────────────────────────────────────────────────────

const extractStringProp = (src: string, prop: string): string | null => {
  const re = new RegExp(`static\\s+${prop}\\s*=\\s*["']([^"']+)["']`);
  const m = src.match(re);
  return m ? m[1] : null;
};

const extractBoolProp = (src: string, prop: string): boolean | null => {
  const re = new RegExp(`static\\s+${prop}\\s*=\\s*(true|false)`);
  const m = src.match(re);
  return m ? m[1] === "true" : null;
};

const extractRelations = (src: string): TRelationDef[] => {
  const relations: TRelationDef[] = [];

  // Match each relation entry: name: { type: "...", ... }
  const blockMatch = src.match(/static\s+relations[\s\S]*?=\s*\{([\s\S]*?)\n\s*\};/);
  if (!blockMatch) return relations;

  const block = blockMatch[1];

  // Match individual relation entries
  const entryRegex = /(\w+)\s*:\s*\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = entryRegex.exec(block)) !== null) {
    const name = m[1];
    const body = m[2];

    const typeMatch = body.match(/type:\s*["'](\w+)["']/);
    const fkMatch = body.match(/foreignKey:\s*["'](\w+)["']/);
    const pivotMatch = body.match(/pivot:\s*["'](\w+)["']/);

    if (typeMatch) {
      relations.push({
        name,
        type: typeMatch[1] as TRelationDef["type"],
        foreignKey: fkMatch?.[1],
        pivot: pivotMatch?.[1],
      });
    }
  }

  return relations;
};

const extractCasts = (src: string): Record<string, string> => {
  const casts: Record<string, string> = {};

  const blockMatch = src.match(/static\s+casts\s*=\s*\{([^}]+)\}/);
  if (!blockMatch) return casts;

  const entries = blockMatch[1].matchAll(/(\w+)\s*:\s*["'](\w+)["']/g);
  for (const m of entries) {
    casts[m[1]] = m[2];
  }

  return casts;
};

const extractObjectKeys = (src: string, prop: string): string[] => {
  const re = new RegExp(`static\\s+${prop}\\s*=\\s*\\{([\\s\\S]*?)\\n\\s*\\};`);
  const m = src.match(re);
  if (!m) return [];

  const keys: string[] = [];
  const keyRegex = /(\w+)\s*[:(]/g;
  let km: RegExpExecArray | null;
  while ((km = keyRegex.exec(m[1])) !== null) {
    keys.push(km[1]);
  }
  return keys;
};

const extractHookKeys = (src: string): string[] => {
  const hooks: string[] = [];
  const hookNames = [
    "beforeCreate", "afterCreate",
    "beforeUpdate", "afterUpdate",
    "beforeSave", "afterSave",
    "beforeDelete", "afterDelete",
  ];

  for (const hook of hookNames) {
    if (new RegExp(`${hook}\\s*[:(]`).test(src)) {
      hooks.push(hook);
    }
  }

  return hooks;
};

const extractTypeFields = (src: string, typeName: string | null): TFieldDef[] => {
  if (!typeName) return [];

  // Match either a type alias — `type X = { ... };` — or an interface
  // declaration — `interface X { ... }` (with/without `export`).
  const typeRe = new RegExp(`(?:export\\s+)?type\\s+${typeName}\\s*=\\s*\\{([\\s\\S]*?)\\};`);
  const ifaceRe = new RegExp(`(?:export\\s+)?interface\\s+${typeName}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`);
  const m = src.match(typeRe) ?? src.match(ifaceRe);
  if (!m) return [];

  const fields: TFieldDef[] = [];
  const body = m[1];

  // Match: fieldName: type  or  fieldName?: type
  const fieldRegex = /(\w+)(\?)?:\s*([^;]+)/g;
  let fm: RegExpExecArray | null;
  while ((fm = fieldRegex.exec(body)) !== null) {
    const name = fm[1];
    if (name === "type" || name === "export") continue; // skip keywords if captured
    fields.push({
      name,
      tsType: fm[3].trim().replace(/[,;]\s*$/, ""),
      optional: fm[2] === "?",
    });
  }

  return fields;
};

const extractMigrationColumns = (src: string): TColumnDef[] => {
  const columns: TColumnDef[] = [];

  // Match t.id(), t.text("name"), t.integer("age"), t.real("score"), t.boolean("active")
  // Also match t.timestamps() and t.softDeletes() → expand to individual columns

  // t.id("name") or t.id()
  const idMatches = src.matchAll(/t\.id\(\s*(?:["'](\w+)["'])?\s*\)/g);
  for (const m of idMatches) {
    columns.push({ name: m[1] ?? "id", type: "TEXT", nullable: false, primary: true, hasDefault: false });
  }

  // t.text("name", { ... })
  const textMatches = src.matchAll(/t\.text\(\s*["'](\w+)["'](?:\s*,\s*\{([^}]*)\})?\s*\)/g);
  for (const m of textMatches) {
    columns.push(parseColumnOpts(m[1], "TEXT", m[2]));
  }

  // t.integer("name", { ... })
  const intMatches = src.matchAll(/t\.integer\(\s*["'](\w+)["'](?:\s*,\s*\{([^}]*)\})?\s*\)/g);
  for (const m of intMatches) {
    columns.push(parseColumnOpts(m[1], "INTEGER", m[2]));
  }

  // t.real("name", { ... })
  const realMatches = src.matchAll(/t\.real\(\s*["'](\w+)["'](?:\s*,\s*\{([^}]*)\})?\s*\)/g);
  for (const m of realMatches) {
    columns.push(parseColumnOpts(m[1], "REAL", m[2]));
  }

  // t.boolean("name", { ... })
  const boolMatches = src.matchAll(/t\.boolean\(\s*["'](\w+)["'](?:\s*,\s*\{([^}]*)\})?\s*\)/g);
  for (const m of boolMatches) {
    columns.push(parseColumnOpts(m[1], "INTEGER", m[2]));
  }

  // t.blob("name", { ... })
  const blobMatches = src.matchAll(/t\.blob\(\s*["'](\w+)["'](?:\s*,\s*\{([^}]*)\})?\s*\)/g);
  for (const m of blobMatches) {
    columns.push(parseColumnOpts(m[1], "BLOB", m[2]));
  }

  // t.json("name", { ... })
  const jsonMatches = src.matchAll(/t\.json\(\s*["'](\w+)["'](?:\s*,\s*\{([^}]*)\})?\s*\)/g);
  for (const m of jsonMatches) {
    columns.push(parseColumnOpts(m[1], "JSON", m[2]));
  }

  // t.timestamps() → created_at + updated_at
  if (/t\.timestamps\(\)/.test(src)) {
    columns.push({ name: "created_at", type: "TEXT", nullable: false, primary: false, hasDefault: false });
    columns.push({ name: "updated_at", type: "TEXT", nullable: false, primary: false, hasDefault: false });
  }

  // t.softDeletes() → deleted_at (if exists as a helper, otherwise check for deleted_at column)
  if (/t\.softDeletes\(\)/.test(src)) {
    columns.push({ name: "deleted_at", type: "TEXT", nullable: true, primary: false, hasDefault: false });
  }

  // Alter-mode add* methods (t.addText/addInteger/…) — the exact syntax `generate`
  // emits for column adds. Scoped to up() so the reverse ops in down() (which drop
  // what up() adds) don't cancel them out. Without this, declared-column read-back
  // is blind to any column introduced by an alter migration and re-proposes it.
  const addSpecs: [string, TColumnDef["type"]][] = [
    ["addText", "TEXT"],
    ["addInteger", "INTEGER"],
    ["addReal", "REAL"],
    ["addBoolean", "INTEGER"],
    ["addBlob", "BLOB"],
    ["addJson", "JSON"],
  ];
  const up = upBlockOf(src);
  for (const [method, type] of addSpecs) {
    const re = new RegExp(`t\\.${method}\\(\\s*["'](\\w+)["'](?:\\s*,\\s*\\{([^}]*)\\})?\\s*\\)`, "g");
    for (const m of up.matchAll(re)) columns.push(parseColumnOpts(m[1], type, m[2]));
  }

  return columns;
};

const parseColumnOpts = (name: string, type: TColumnDef["type"], optsStr?: string): TColumnDef => {
  const nullable = optsStr ? !/nullable\s*:\s*false/.test(optsStr) : true;
  const hasDefault = optsStr ? /default\s*:/.test(optsStr) : false;
  return { name, type, nullable, primary: false, hasDefault };
};

const extractForeignKeys = (src: string): { column: string; references: string }[] => {
  const fks: { column: string; references: string }[] = [];

  // Match: .references("table", "col") or .constrained("table")
  // We need the column name too — look for t.text("col").references(...) chains
  const refRegex = /t\.text\(\s*["'](\w+)["'][^)]*\)[^;]*\.(?:references\(\s*["'](\w+)["']|constrained\(\s*["'](\w+)["'])/g;
  let m: RegExpExecArray | null;
  while ((m = refRegex.exec(src)) !== null) {
    const col = m[1];
    const refTable = m[2] ?? m[3];
    fks.push({ column: col, references: refTable });
  }

  return fks;
};

// ─── Utilities ───────────────────────────────────────────────────────────────

/** Map SQLite column type to TypeScript type for DTO generation. */
export const sqliteTypeToTs = (col: TColumnDef): string => {
  switch (col.type) {
    case "TEXT": return "string";
    case "INTEGER": return "number";
    case "REAL": return "number";
    case "BLOB": return "ArrayBuffer";
    case "JSON": return "unknown";
    default: return "unknown";
  }
};
