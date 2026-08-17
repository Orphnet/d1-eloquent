import { register } from "../registry";
import { parseModelFile, parseMigrationFile, type TModelMeta, type TMigrationMeta } from "../parser";
import { collectModelFiles, collectMigrationFiles } from "../utils";
import type { TCommand } from "../types";

type TInspectResult = {
  model: string;
  table: string | null;
  primaryKey: string;
  timestamps: boolean;
  softDeletes: boolean;
  fields: Array<{ name: string; type: string; optional: boolean }>;
  columns: Array<{ name: string; type: string; nullable: boolean; primary: boolean }>;
  relations: Array<{ name: string; type: string; foreignKey?: string; pivot?: string }>;
  casts: Record<string, string>;
  scopes: string[];
  hooks: string[];
};

const findModelFile = async (name: string): Promise<string | null> => {
  const files = await collectModelFiles();
  // Match by filename (e.g. "User" matches "User.ts" or "user.ts")
  const lower = name.toLowerCase();
  return files.find((f) => {
    const filename = f.split("/").pop()?.replace(/\.ts$/, "").toLowerCase();
    return filename === lower;
  }) ?? null;
};

const findMigrationForTable = async (table: string): Promise<TMigrationMeta | null> => {
  const files = await collectMigrationFiles();
  for (const file of files) {
    const meta = await parseMigrationFile(file);
    if (meta?.table === table) return meta;
  }
  return null;
};

const buildResult = (model: TModelMeta, migration: TMigrationMeta | null): TInspectResult => {
  return {
    model: model.className,
    table: model.table,
    primaryKey: model.primaryKey,
    timestamps: model.timestamps,
    softDeletes: model.softDeletes,
    fields: model.fields.map((f) => ({ name: f.name, type: f.tsType, optional: f.optional })),
    columns: (migration?.columns ?? []).map((c) => ({ name: c.name, type: c.type, nullable: c.nullable, primary: c.primary })),
    relations: model.relations.map((r) => ({ name: r.name, type: r.type, foreignKey: r.foreignKey, pivot: r.pivot })),
    casts: model.casts,
    scopes: model.scopes,
    hooks: model.hooks,
  };
};

const printResult = (result: TInspectResult): void => {
  console.log(`\nModel: ${result.model}`);
  console.log(`Table: ${result.table ?? "(not set)"}`);
  console.log(`Primary Key: ${result.primaryKey}`);
  console.log(`Timestamps: ${result.timestamps}`);
  console.log(`Soft Deletes: ${result.softDeletes}`);

  if (result.fields.length > 0) {
    console.log(`\nType Fields:`);
    for (const f of result.fields) {
      console.log(`  ${f.name}${f.optional ? "?" : ""}: ${f.type}`);
    }
  }

  if (result.columns.length > 0) {
    console.log(`\nMigration Columns:`);
    for (const c of result.columns) {
      const flags = [c.primary && "PK", c.nullable && "nullable"].filter(Boolean).join(", ");
      console.log(`  ${c.name}: ${c.type}${flags ? ` (${flags})` : ""}`);
    }
  }

  if (result.relations.length > 0) {
    console.log(`\nRelations:`);
    for (const r of result.relations) {
      const extra = [r.foreignKey && `fk=${r.foreignKey}`, r.pivot && `pivot=${r.pivot}`].filter(Boolean).join(", ");
      console.log(`  ${r.name}: ${r.type}${extra ? ` (${extra})` : ""}`);
    }
  }

  if (Object.keys(result.casts).length > 0) {
    console.log(`\nCasts:`);
    for (const [k, v] of Object.entries(result.casts)) {
      console.log(`  ${k}: ${v}`);
    }
  }

  if (result.scopes.length > 0) {
    console.log(`\nScopes: ${result.scopes.join(", ")}`);
  }

  if (result.hooks.length > 0) {
    console.log(`\nHooks: ${result.hooks.join(", ")}`);
  }

  console.log("");
};

const command: TCommand = {
  meta: {
    name: "inspect",
    description: "Print resolved schema for a model",
    usage: "inspect <model> [--json]",
    category: "inspect",
  },
  async run(ctx) {
    const name = ctx.args[0];
    if (!name) {
      console.error("Usage: inspect <model>  (e.g. inspect User)");
      process.exit(1);
    }

    const file = await findModelFile(name);
    if (!file) {
      console.error(`Model file not found: ${name}`);
      process.exit(1);
    }

    const model = await parseModelFile(file);
    if (!model) {
      console.error(`Could not parse model from: ${file}`);
      process.exit(1);
    }

    const migration = model.table ? await findMigrationForTable(model.table) : null;
    const result = buildResult(model, migration);

    if (ctx.flags.bool("json")) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printResult(result);
    }
  },
};

register(command);
export { command as inspect };
