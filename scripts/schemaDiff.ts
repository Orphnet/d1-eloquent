/**
 * Schema-diff engine for `d1-eloquent generate`.
 *
 * d1-eloquent is code-first: migration files ARE the schema source of truth.
 * `generate` closes the gap between what a MODEL declares (its attribute
 * interface + casts + timestamps/softDeletes) and what the accumulated
 * migrations have already DECLARED for that table — then emits a reviewable
 * migration file (add/drop columns, or a full createTable for a brand-new
 * model). Pure static analysis: it never opens a database. The generated file
 * is the human review gate before `migrate` applies anything.
 */

import type { TModelMeta, TMigrationMeta, TColumnDef, TFieldDef } from "./parser";

export type TTypeChange = { name: string; from: string; to: string };

export type TColumnDiff = {
  table: string;
  isNewTable: boolean;
  /** Desired-but-not-yet-declared → ADD COLUMN. */
  added: TColumnDef[];
  /** Declared-but-no-longer-in-model → DROP COLUMN (destructive). */
  dropped: TColumnDef[];
  /**
   * Column whose SQLite storage class changed. SQLite cannot ALTER a column
   * type in place, so these are surfaced as warnings, never auto-emitted.
   */
  typeChanged: TTypeChange[];
  /** Full desired column set (used to render a createTable for new tables). */
  desired: TColumnDef[];
};

/** True when the diff implies no schema change. */
export const isEmptyDiff = (d: TColumnDiff): boolean =>
  !d.isNewTable && d.added.length === 0 && d.dropped.length === 0;

/**
 * Map a model TS field (refined by its cast, if any) to a SQLite column.
 * Casts win over the raw TS type because they encode storage intent
 * (`boolean` → INTEGER, `json`/`array` → JSON-tagged TEXT, `date` → TEXT).
 */
export const resolveSqliteType = (tsType: string, cast?: string): TColumnDef["type"] => {
  if (cast) {
    switch (cast) {
      case "json":
      case "array":
      case "object":
      case "collection":
        return "JSON";
      case "boolean":
      case "integer":
      case "number":
      case "timestamp":
        return "INTEGER";
      case "real":
      case "float":
      case "double":
      case "decimal":
        return "REAL";
      case "date":
      case "datetime":
      case "encrypted":
      case "string":
        return "TEXT";
      case "blob":
        return "BLOB";
    }
  }

  const t = tsType
    .toLowerCase()
    .replace(/\s*\|\s*(null|undefined)\b/g, "")
    .trim();

  if (t === "number" || t === "bigint") return "INTEGER";
  if (t === "boolean") return "INTEGER";
  if (t === "arraybuffer" || t === "uint8array" || t === "blob") return "BLOB";
  if (/\[\]$/.test(t) || /^record</.test(t) || t.startsWith("{") || t === "object" || t === "unknown") return "JSON";
  return "TEXT";
};

/** Convert one parsed model field into its implied column definition. */
export const fieldToColumn = (field: TFieldDef, cast: string | undefined, primaryKey: string): TColumnDef => ({
  name: field.name,
  type: resolveSqliteType(field.tsType, cast),
  // Nullable if optional (`?`) OR the TS type is a `| null` union — the `?` marker
  // alone misses `subtitle: string | null`.
  nullable: field.optional || /\|\s*null\b/i.test(field.tsType),
  primary: field.name === primaryKey,
  hasDefault: false,
});

/**
 * Derive the complete column set a model implies: its attribute-interface
 * fields, plus the conventional `created_at`/`updated_at` (when
 * `timestamps`) and `deleted_at` (when `softDeletes`).
 */
export const deriveModelColumns = (model: TModelMeta): TColumnDef[] => {
  const cols: TColumnDef[] = [];
  const seen = new Set<string>();

  // Always include the primary-key column. BaseModel manages the PK, so the attrs
  // interface often omits it — but leaving it out of the desired set would make
  // diffColumns propose a destructive `t.dropColumn("id")` (dropping the PK).
  if (model.primaryKey && !model.fields.some((f) => f.name === model.primaryKey)) {
    cols.push({ name: model.primaryKey, type: "TEXT", nullable: false, primary: true, hasDefault: false });
    seen.add(model.primaryKey);
  }

  for (const f of model.fields) {
    if (seen.has(f.name)) continue;
    seen.add(f.name);
    cols.push(fieldToColumn(f, model.casts[f.name], model.primaryKey));
  }

  if (model.timestamps) {
    for (const n of ["created_at", "updated_at"]) {
      if (!seen.has(n)) {
        cols.push({ name: n, type: "TEXT", nullable: false, primary: false, hasDefault: false });
        seen.add(n);
      }
    }
  }

  if (model.softDeletes && !seen.has("deleted_at")) {
    cols.push({ name: "deleted_at", type: "TEXT", nullable: true, primary: false, hasDefault: false });
    seen.add("deleted_at");
  }

  return cols;
};

/**
 * Reconstruct the columns already declared for a table by unioning the
 * columns extracted from every migration that touches it. Later migrations
 * override earlier column definitions of the same name (last-write-wins),
 * matching apply order.
 *
 * Alter-mode `t.addText(...)` adds and `t.dropColumn(...)` removals in a
 * migration's up() are honoured (add then drop, in apply order), so the
 * declared set round-trips the tool's own emitted alters.
 */
export const accumulateDeclaredColumns = (migrations: TMigrationMeta[]): TColumnDef[] => {
  const byName = new Map<string, TColumnDef>();
  for (const m of migrations) {
    for (const c of m.columns) byName.set(c.name, c);
    // Apply drops after this migration's adds so a column added then dropped in
    // the same migration nets out, and the accumulated set round-trips the tool's
    // own alter output.
    for (const name of m.droppedColumns ?? []) byName.delete(name);
  }
  return [...byName.values()];
};

/** Diff the model's desired columns against the accumulated declared columns. */
export const diffColumns = (
  table: string,
  desired: TColumnDef[],
  declared: TColumnDef[],
  tableExists: boolean,
): TColumnDiff => {
  const declaredByName = new Map(declared.map((c) => [c.name, c]));
  const desiredByName = new Map(desired.map((c) => [c.name, c]));

  const added = desired.filter((c) => !declaredByName.has(c.name));
  const dropped = declared.filter((c) => !desiredByName.has(c.name));

  // JSON is a tooling-only tag for a TEXT-affinity column (SQLite has no JSON
  // storage class - see schema.ts sqlType()). Normalize before comparing so the
  // ubiquitous `t.text("x")` + `casts: { x: "json" }` pattern isn't reported as a
  // phantom, un-ALTERable TEXT→JSON type change that never resolves to in-sync.
  const storageClass = (t: TColumnDef["type"]): TColumnDef["type"] => (t === "JSON" ? "TEXT" : t);
  const typeChanged: TTypeChange[] = [];
  for (const c of desired) {
    const prev = declaredByName.get(c.name);
    if (prev && storageClass(prev.type) !== storageClass(c.type)) {
      typeChanged.push({ name: c.name, from: prev.type, to: c.type });
    }
  }

  return { table, isNewTable: !tableExists, added, dropped, typeChanged, desired };
};

// ─── Migration rendering ─────────────────────────────────────────────────────

// Alter-mode adds stay conservative: only emit `{ nullable: true }`. Adding a
// NOT NULL column with no default to a populated table fails in SQLite, so a
// bare add is left nullable (the aggressive NOT-NULL-in-alter policy is a
// deliberate call left to the author).
const optsSuffix = (col: TColumnDef): string => (col.nullable ? ", { nullable: true }" : "");

// Create-mode is explicit about nullability in both directions so a required
// model field (`email: string`) generates a genuine NOT NULL column rather than
// silently landing nullable.
const createOptsSuffix = (col: TColumnDef): string => (col.nullable ? ", { nullable: true }" : ", { nullable: false }");

const CREATE_METHOD: Record<TColumnDef["type"], string> = {
  TEXT: "text",
  INTEGER: "integer",
  REAL: "real",
  BLOB: "blob",
  JSON: "json",
};

// Alter mode uses distinct add* methods (t.text() etc. are create-only and are
// silently ignored inside schema.table()).
const ADD_METHOD: Record<TColumnDef["type"], string> = {
  TEXT: "addText",
  INTEGER: "addInteger",
  REAL: "addReal",
  BLOB: "addBlob",
  JSON: "addJson",
};

/** Render a column for a createTable() block (e.g. `t.text("email")`). */
export const renderColumnBuilder = (col: TColumnDef, primaryKey: string): string => {
  if (col.primary && col.name === primaryKey && col.type === "TEXT") {
    return col.name === "id" ? `      t.id();` : `      t.id(${JSON.stringify(col.name)});`;
  }
  return `      t.${CREATE_METHOD[col.type]}(${JSON.stringify(col.name)}${createOptsSuffix(col)});`;
};

/** Render an ADD COLUMN for a schema.table() alter block (e.g. `t.addText("slug")`). */
export const renderAddColumn = (col: TColumnDef): string =>
  `      t.${ADD_METHOD[col.type]}(${JSON.stringify(col.name)}${optsSuffix(col)});`;

/**
 * Render the create-block body for a new table, collapsing the conventional
 * `created_at`/`updated_at` pair to `t.timestamps()` and `deleted_at` to
 * `t.softDeletes()`.
 */
const renderCreateBody = (cols: TColumnDef[], primaryKey: string): string => {
  const names = new Set(cols.map((c) => c.name));
  const hasTimestamps = names.has("created_at") && names.has("updated_at");
  const hasSoftDeletes = names.has("deleted_at");
  const skip = new Set<string>();
  if (hasTimestamps) { skip.add("created_at"); skip.add("updated_at"); }
  if (hasSoftDeletes) skip.add("deleted_at");

  const lines = cols.filter((c) => !skip.has(c.name)).map((c) => renderColumnBuilder(c, primaryKey));
  if (hasTimestamps) lines.push("      t.timestamps();");
  if (hasSoftDeletes) lines.push("      t.softDeletes();");
  return lines.join("\n");
};

/**
 * Render a complete migration file for a diff. `up` creates the table (new) or
 * applies add/drop column alters; `down` reverses them. Destructive drops are
 * annotated so a reviewer can't miss them.
 */
export const renderMigration = (migrationName: string, diff: TColumnDiff, primaryKey: string): string => {
  let up: string;
  let down: string;

  if (diff.isNewTable) {
    up =
      `    schema.createTable(${JSON.stringify(diff.table)}, (t) => {\n` +
      `${renderCreateBody(diff.desired, primaryKey)}\n` +
      `    });`;
    down = `    schema.dropTable(${JSON.stringify(diff.table)});`;
  } else {
    const upLines: string[] = [];
    for (const c of diff.added) upLines.push(renderAddColumn(c));
    for (const c of diff.dropped) upLines.push(`      t.dropColumn(${JSON.stringify(c.name)}); // destructive — drops data`);

    const downLines: string[] = [];
    // reverse: drop what we added, re-add what we dropped
    for (const c of diff.added) downLines.push(`      t.dropColumn(${JSON.stringify(c.name)});`);
    for (const c of diff.dropped) downLines.push(renderAddColumn(c));

    up = `    schema.table(${JSON.stringify(diff.table)}, (t) => {\n${upLines.join("\n")}\n    });`;
    down = `    schema.table(${JSON.stringify(diff.table)}, (t) => {\n${downLines.join("\n")}\n    });`;
  }

  const warnings: string[] = [];
  if (diff.dropped.length > 0) {
    warnings.push(`  // ⚠️ This migration DROPS ${diff.dropped.length} column(s): ${diff.dropped.map((c) => c.name).join(", ")}`);
  }
  for (const tc of diff.typeChanged) {
    warnings.push(`  // ⚠️ Column "${tc.name}" changed type ${tc.from} → ${tc.to}; SQLite can't ALTER type in place — recreate the table manually if needed.`);
  }
  const warningBlock = warnings.length ? `\n${warnings.join("\n")}\n` : "";

  return `import type { TMigration } from "@orphnet/d1-eloquent/cli";
import { Schema } from "@orphnet/d1-eloquent/cli";

// Auto-generated by \`d1-eloquent generate\`. Review before running \`migrate\`.
${warningBlock}const migration: TMigration = {
  name: ${JSON.stringify(migrationName)},

  up: (schema: Schema) => {
${up}
  },

  down: (schema: Schema) => {
${down}
  },
};

export default migration;
`;
};
