import { d1Execute } from "../d1Execute";
import { register } from "../registry";
import { Schema } from "../schema";
import type { TCommand, TMigration } from "../types";
import { asNumber, collectMigrationFiles, toImportUrl } from "../utils";

/** Escape single quotes for safe SQL string literal interpolation. */
const escapeSql = (s: string): string => s.replace(/'/g, "''");

const getLatestBatch = async (dbName: string, local: boolean, remote: boolean): Promise<number | null> => {
  const res = await d1Execute({
    dbName,
    local,
    remote,
    command: `SELECT COALESCE(MAX(batch), 0) as b FROM _migrations;`,
  });

  const n = asNumber(res.results?.[0]?.b, 0);
  return n > 0 ? n : null;
};

const getLatestMigrations = async (
  dbName: string,
  local: boolean,
  remote: boolean,
  opts: { step?: number; batch?: number | null },
): Promise<string[]> => {
  if (opts.step && opts.step > 0) {
    const res = await d1Execute({
      dbName,
      local,
      remote,
      command: `SELECT name FROM _migrations ORDER BY id DESC LIMIT ${opts.step};`,
    });
    return (res.results ?? []).map((r) => String(r.name));
  }

  const batch = opts.batch ?? (await getLatestBatch(dbName, local, remote));
  if (!batch) return [];

  const res = await d1Execute({
    dbName,
    local,
    remote,
    command: `SELECT name FROM _migrations WHERE batch = ${batch} ORDER BY id DESC;`,
  });

  return (res.results ?? []).map((r) => String(r.name));
};

const command: TCommand = {
  meta: {
    name: "rollback",
    description: "Rollback last migration batch",
    usage: "rollback [--step=N] [--batch=N] [--pretend] [--atomic]",
    category: "database",
  },
  async run(ctx) {
    const local = !ctx.isRemote;
    const dbName = ctx.db;
    const remote = ctx.isRemote;

    const step = ctx.flags.get("step") ? asNumber(ctx.flags.get("step"), 0) : 0;
    const batchFlag = ctx.flags.get("batch") ? asNumber(ctx.flags.get("batch"), 0) : null;

    const names = await getLatestMigrations(dbName, local, remote, { step: step > 0 ? step : undefined, batch: batchFlag });

    if (names.length === 0) {
      console.log("No migrations to rollback.");
      return;
    }

    // Build name->file map
    const files = await collectMigrationFiles();
    const map = new Map<string, string>();

    for (const file of files) {
      const mod = (await import(toImportUrl(process.cwd() + "/" + file))) as { default: TMigration };
      map.set(mod.default.name, file);
    }

    const pretend = ctx.flags.bool("pretend");
    const atomic = ctx.flags.bool("atomic");

    let rolled = 0;

    for (const name of names) {
      const file = map.get(name);
      if (!file) throw new Error(`Migration file not found for: ${name}`);

      const mod = (await import(toImportUrl(process.cwd() + "/" + file))) as { default: TMigration };
      const migration = mod.default;

      const schema = new Schema();
      await migration.down(schema);

      const sql = schema.toSql();

      if (pretend) {
        console.log(`-- [pretend rollback] ${migration.name}\n${sql}\n`);
        rolled += 1;
        continue;
      }

      // Wrap each rollback with PRAGMA foreign_keys=OFF in the same batch,
      // since each d1Execute is a separate wrangler process.
      if (atomic && !local) {
        const wrapped = [
          "PRAGMA foreign_keys = OFF;",
          "BEGIN;",
          sql,
          `DELETE FROM _migrations WHERE name = '${escapeSql(migration.name)}';`,
          "COMMIT;",
          "PRAGMA foreign_keys = ON;",
        ].join("\n");
        await d1Execute({ dbName, local, remote, command: wrapped });
      } else {
        const wrapped = [
          "PRAGMA foreign_keys = OFF;",
          ...schema.toStatements(),
          `DELETE FROM _migrations WHERE name = '${escapeSql(migration.name)}';`,
          "PRAGMA foreign_keys = ON;",
        ].join("\n");
        await d1Execute({ dbName, local, remote, command: wrapped });
      }

      console.log(`rolled back: ${migration.name}`);
      rolled += 1;
    }

    console.log(`Done. Rolled back ${rolled} migration(s).`);
  },
};

register(command);
export { command as rollback };
