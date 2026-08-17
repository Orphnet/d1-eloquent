import { readFile, writeFile } from "node:fs/promises";
import { register } from "../registry";
import { parseModelFile, parseMigrationSourceForTable, type TColumnDef } from "../parser";
import { collectModelFiles, collectMigrationFiles, ensureDir, timestampId } from "../utils";
import {
  deriveModelColumns,
  accumulateDeclaredColumns,
  diffColumns,
  renderMigration,
  isEmptyDiff,
  type TColumnDiff,
} from "../schemaDiff";
import type { TCommand } from "../types";

const DEFAULT_MIGRATIONS_DIR = "src/database/migrations";

/** A model whose desired schema diverges from its migrations. */
type TChange = { diff: TColumnDiff; modelName: string; primaryKey: string; writable: boolean };

/**
 * Write new migrations to wherever the project's migrations already live
 * (e.g. `database/migrations`), falling back to the conventional default for a
 * greenfield project with no migrations yet.
 */
const resolveMigrationsDir = async (): Promise<string> => {
  const existing = await collectMigrationFiles();
  const first = existing[0];
  if (!first) return DEFAULT_MIGRATIONS_DIR;
  const slash = first.lastIndexOf("/");
  return slash === -1 ? DEFAULT_MIGRATIONS_DIR : first.slice(0, slash);
};

const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/**
 * Reconstruct the declared columns for a table by scanning every migration
 * that creates OR alters it, in apply (filename) order.
 */
const collectDeclaredColumns = async (
  table: string,
): Promise<{ columns: TColumnDef[]; tableExists: boolean }> => {
  const files = (await collectMigrationFiles()).sort();
  const metas = [];
  let tableExists = false;

  const createRe = new RegExp(`\\.createTable\\(\\s*["']${table}["']`);
  const alterRe = new RegExp(`\\.(?:table|alterTable)\\(\\s*["']${table}["']`);

  for (const file of files) {
    const src = await readFile(file, "utf-8");
    const creates = createRe.test(src);
    const alters = alterRe.test(src);
    if (!creates && !alters) continue;
    if (creates) tableExists = true;
    // Scope to THIS table's blocks so a multi-table migration file doesn't
    // attribute a sibling table's columns to `table` (false drops/adds).
    const meta = parseMigrationSourceForTable(src, table);
    if (meta) metas.push(meta);
  }

  return { columns: accumulateDeclaredColumns(metas), tableExists };
};

const findModelFile = async (name: string): Promise<string | null> => {
  const files = await collectModelFiles();
  const lower = name.toLowerCase();
  return (
    files.find((f) => f.split("/").pop()?.replace(/\.ts$/, "").toLowerCase() === lower) ?? null
  );
};

/** Print a human-readable summary of one model's diff. */
const printDiff = (model: string, diff: TColumnDiff): void => {
  if (diff.isNewTable) {
    console.log(`\n${GREEN}+ ${model}${RESET} ${DIM}(new table "${diff.table}", ${diff.desired.length} columns)${RESET}`);
    for (const c of diff.desired) console.log(`    ${GREEN}+${RESET} ${c.name} ${DIM}${c.type}${c.nullable ? " nullable" : ""}${RESET}`);
    return;
  }
  console.log(`\n${YELLOW}~ ${model}${RESET} ${DIM}(alter "${diff.table}")${RESET}`);
  for (const c of diff.added) console.log(`    ${GREEN}+${RESET} ${c.name} ${DIM}${c.type}${c.nullable ? " nullable" : ""}${RESET}`);
  for (const c of diff.dropped) console.log(`    ${RED}-${RESET} ${c.name} ${DIM}${c.type}${RESET} ${RED}(destructive)${RESET}`);
  for (const tc of diff.typeChanged) console.log(`    ${YELLOW}!${RESET} ${tc.name} ${DIM}${tc.from} → ${tc.to}${RESET} ${YELLOW}(SQLite can't ALTER type)${RESET}`);
};

const command: TCommand = {
  meta: {
    name: "generate",
    description: "Diff models against migrations and generate a reconciling migration",
    usage: "generate [model] [--write] [--name=<name>]",
    category: "generate",
  },
  async run(ctx) {
    const only = ctx.args[0];
    const write = ctx.flags.bool("write");
    const customName = ctx.flags.get("name");

    // Resolve target model files.
    let modelFiles: string[];
    if (only) {
      const f = await findModelFile(only);
      if (!f) {
        console.error(`Model file not found: ${only}`);
        process.exit(1);
      }
      modelFiles = [f];
    } else {
      modelFiles = await collectModelFiles();
    }

    const changes: TChange[] = [];
    for (const file of modelFiles) {
      const model = await parseModelFile(file);
      if (!model?.table) continue; // skip unparseable / table-less models
      const desired = deriveModelColumns(model);
      // Safety: a model whose attribute type couldn't be parsed derives zero
      // columns. Never let that masquerade as "drop every column" — skip and warn.
      if (desired.length === 0) {
        console.log(`${YELLOW}⚠${RESET} ${model.className} ${DIM}(${model.table})${RESET}: could not derive columns from its attribute type — skipping.`);
        continue;
      }
      const { columns: declared, tableExists } = await collectDeclaredColumns(model.table);
      const diff = diffColumns(model.table, desired, declared, tableExists);
      // A pure in-place type change is not writable (SQLite can't ALTER type), but
      // it must still surface as a warning rather than report "in sync".
      const writable = !isEmptyDiff(diff);
      if (!writable && diff.typeChanged.length === 0) continue;
      changes.push({ diff, modelName: model.className, primaryKey: model.primaryKey, writable });
    }

    if (changes.length === 0) {
      console.log(`${GREEN}✓${RESET} Schema is in sync — no migration needed.`);
      return;
    }

    for (const { diff, modelName } of changes) printDiff(modelName, diff);

    if (!write) {
      console.log(`\n${DIM}Dry run — pass ${RESET}--write${DIM} to emit migration file(s). Review before \`migrate\`.${RESET}`);
      return;
    }

    // Write one migration file per changed table, into the project's real
    // migrations directory.
    const writableChanges = changes.filter((c) => c.writable);
    const typeOnly = changes.filter((c) => !c.writable);
    if (writableChanges.length === 0) {
      // Only in-place type changes — nothing valid to emit (SQLite can't ALTER type).
      console.log(`\n${YELLOW}⚠${RESET} ${DIM}Only in-place type changes — SQLite can't ALTER type. Recreate the affected table(s) manually; nothing written.${RESET}`);
      return;
    }
    const migrationsDir = await resolveMigrationsDir();
    await ensureDir(migrationsDir);
    // Give each file in the batch a distinct, increasing timestamp (base + i sec) so
    // second-granularity collisions don't force an alphabetical apply order — new
    // tables emit in iteration order. (Cross-table FK ordering can still need a
    // manual reorder; the review-before-migrate step is the gate.)
    const baseMs = Date.now();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stampFor = (i: number): string => {
      const d = new Date(baseMs + i * 1000);
      return (
        String(d.getUTCFullYear()) + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) +
        pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds())
      );
    };
    let i = 0;
    for (const { diff, primaryKey } of writableChanges) {
      const verb = diff.isNewTable ? "create" : "update";
      const base = customName && writableChanges.length === 1 ? customName : `${verb}_${diff.table}`;
      const migrationName = `${writableChanges.length === 1 ? timestampId() : stampFor(i++)}_${base}`;
      const path = `${migrationsDir}/${migrationName}.ts`;
      const contents = renderMigration(migrationName, diff, primaryKey);
      await writeFile(path, contents, "utf-8");
      const destructive = diff.dropped.length > 0;
      console.log(`${destructive ? YELLOW : GREEN}✓${RESET} Wrote ${path}${destructive ? ` ${YELLOW}(review the destructive drops!)${RESET}` : ""}`);
    }
    if (typeOnly.length > 0) {
      console.log(`${YELLOW}⚠${RESET} ${DIM}${typeOnly.length} table(s) also have in-place type changes — not auto-emitted (SQLite can't ALTER type); handle manually.${RESET}`);
    }
    console.log(`\n${DIM}Review the generated file(s), then run \`d1-eloquent migrate\`.${RESET}`);
  },
};

register(command);
export { command as generate };
