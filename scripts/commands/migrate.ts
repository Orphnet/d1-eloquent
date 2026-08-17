import { d1Execute } from "../d1Execute";
import { register } from "../registry";
import { Schema } from "../schema";
import type { TCommand, TMigration } from "../types";
import { asNumber, collectMigrationFiles, nowIso, toImportUrl } from "../utils";

/** Escape single quotes for safe SQL string literal interpolation. */
const escapeSql = (s: string): string => s.replace(/'/g, "''");

const ensureMigrationsTable = async (dbName: string, local: boolean, remote: boolean) => {
  await d1Execute({
    dbName,
    local,
    remote,
    command: `
      CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        batch INTEGER NOT NULL,
        applied_at TEXT NOT NULL
      );
    `,
  });
};

const getRanMigrations = async (dbName: string, local: boolean, remote: boolean): Promise<Set<string>> => {
  const res = await d1Execute({
    dbName,
    local,
    remote,
    command: `SELECT name FROM _migrations ORDER BY id ASC;`,
  });

  const names = (res.results ?? []).map((r) => String(r.name));
  return new Set(names);
};

const getNextBatch = async (dbName: string, local: boolean, remote: boolean): Promise<number> => {
  const res = await d1Execute({
    dbName,
    local,
    remote,
    command: `SELECT COALESCE(MAX(batch), 0) as b FROM _migrations;`,
  });

  const b = res.results?.[0]?.b;
  return asNumber(b, 0) + 1;
};

/** Core logic — callable by other commands (e.g. fresh). */
export const migrateRun = async (dbName: string, local: boolean, remote: boolean, flags: { pretend?: boolean; only?: string; atomic?: boolean }): Promise<void> => {
  await ensureMigrationsTable(dbName, local, remote);

  const ran = await getRanMigrations(dbName, local, remote);
  const batch = await getNextBatch(dbName, local, remote);

  const files = await collectMigrationFiles();

  const only = flags.only?.split(",").map((s) => s.trim()).filter(Boolean);

  let applied = 0;

  for (const file of files) {
    const mod = (await import(toImportUrl(process.cwd() + "/" + file))) as { default: TMigration };
    const migration = mod.default;

    if (only && !only.includes(migration.name)) continue;
    if (ran.has(migration.name)) continue;

    const schema = new Schema();
    await migration.up(schema);

    const sql = schema.toSql();

    if (flags.pretend) {
      console.log(`-- [pretend] ${migration.name}\n${sql}\n`);
      applied += 1;
      continue;
    }

    // NOTE: Local D1 (Miniflare) is backed by Durable Object storage and rejects SQL BEGIN/COMMIT.
    // We therefore run statements sequentially by default, and only use SQL transactions when explicitly requested
    // and NOT running locally.
    if (flags.atomic && local) {
      console.warn(
        `⚠ --atomic ignored locally: Miniflare's D1 backing store rejects BEGIN/COMMIT. ` +
          `Statements for '${migration.name}' will run sequentially. Re-run with --remote for transactional semantics.`,
      );
    }

    if (flags.atomic && !local) {
      const wrapped = `
        BEGIN;
        ${sql}
        INSERT OR IGNORE INTO _migrations (name, batch, applied_at) VALUES ('${escapeSql(migration.name)}', ${batch}, '${nowIso()}');
        COMMIT;
      `;
      await d1Execute({ dbName, local, remote, command: wrapped });
    } else {
      for (const stmt of schema.toStatements()) {
        await d1Execute({ dbName, local, remote, command: stmt });
      }
      await d1Execute({
        dbName,
        local,
        remote,
        command: `INSERT OR IGNORE INTO _migrations (name, batch, applied_at) VALUES ('${escapeSql(migration.name)}', ${batch}, '${nowIso()}');`,
      });
    }

    console.log(`migrated: ${migration.name}`);
    applied += 1;
  }

  if (applied === 0) console.log("No migrations to run.");
  else console.log(`Done. Applied ${applied} migration(s) in batch ${batch}.`);
};

const command: TCommand = {
  meta: {
    name: "migrate",
    description: "Run pending migrations",
    usage: "migrate [--pretend] [--only=name] [--atomic]",
    category: "database",
  },
  async run(ctx) {
    const local = !ctx.isRemote;
    await migrateRun(ctx.db, local, ctx.isRemote, {
      pretend: ctx.flags.bool("pretend"),
      only: ctx.flags.get("only"),
      atomic: ctx.flags.bool("atomic"),
    });
  },
};

register(command);
export { command as migrate };
