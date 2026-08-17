import { d1Execute } from "../d1Execute";
import { register } from "../registry";
import { migrateRun } from "./migrate";
import { seedRun } from "./seed";
import type { TCommand } from "../types";

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

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/**
 * Topologically sort tables so that child tables (those with FK references)
 * are dropped before the parent tables they reference.
 *
 * D1 remote uses triggers for FK enforcement, so `PRAGMA foreign_keys = OFF`
 * does not actually disable constraint checks. Tables must be dropped in
 * dependency order: children first, parents last.
 */
const topoSortForDrop = (
    tables: string[],
    fkMap: Map<string, string[]>,
): string[] => {
  const tableSet = new Set(tables);

  // blockers[parent] = number of children not yet dropped
  const blockers = new Map<string, number>();
  for (const t of tables) blockers.set(t, 0);

  for (const [child, parents] of fkMap) {
    if (!tableSet.has(child)) continue;
    for (const parent of parents) {
      if (!tableSet.has(parent) || parent === child) continue;
      blockers.set(parent, (blockers.get(parent) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const t of tables) {
    if (blockers.get(t) === 0) queue.push(t);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const t = queue.shift()!;
    sorted.push(t);

    // t is a child of some parents — now those parents have one fewer blocker
    const parents = fkMap.get(t) ?? [];
    for (const parent of parents) {
      if (!tableSet.has(parent) || parent === t) continue;
      const newCount = (blockers.get(parent) ?? 1) - 1;
      blockers.set(parent, newCount);
      if (newCount === 0) queue.push(parent);
    }
  }

  // Append any remaining tables (circular refs) — drop them anyway
  for (const t of tables) {
    if (!sorted.includes(t)) sorted.push(t);
  }

  return sorted;
};

const command: TCommand = {
  meta: {
    name: "fresh",
    description: "Drop all tables and re-migrate",
    usage: "fresh [--force] [--seed] [--atomic]",
    category: "database",
  },
  async run(ctx) {
    const local = !ctx.isRemote;
    const dbName = ctx.db;
    const remote = ctx.isRemote;

    const force = ctx.flags.bool("force");
    if (remote && !force) {
      throw new Error("Refusing to run fresh against --remote without --force");
    }

    await ensureMigrationsTable(dbName, local, remote);

    const res = await d1Execute({
      dbName,
      local,
      remote,
      command: `PRAGMA table_list;`,
    });

    // PRAGMA table_list columns: schema, name, type, ncol, wr, strict
    const rows = res.results ?? [];

    const isDroppable = (name: string): boolean => {
      const n = name.trim();
      if (!n) return false;
      if (n.startsWith("sqlite_")) return false;
      if (n.startsWith("_cf_")) return false;
      if (n.startsWith("_d1_")) return false;
      if (n === "_migrations") return false;
      return true;
    };

    const tables = rows
        .filter((r) => String(r.schema) === "main")
        .filter((r) => String(r.type) === "table")
        .map((r) => String(r.name))
        .filter(isDroppable);

    // Query FK dependencies for each table so we can drop in safe order.
    const fkMap = new Map<string, string[]>();
    if (tables.length > 0) {
      const fkSqliteRes = await d1Execute({
        dbName,
        local,
        remote,
        command: `SELECT name, sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL;`,
      });

      const sqlRows = fkSqliteRes.results ?? [];
      for (const row of sqlRows) {
        const tableName = String(row.name);
        if (!tables.includes(tableName)) continue;

        const sql = String(row.sql ?? "");
        // Extract REFERENCES "table" or REFERENCES table patterns
        const refs: string[] = [];
        const refRegex = /REFERENCES\s+["`]?(\w+)["`]?/gi;
        let match: RegExpExecArray | null;
        while ((match = refRegex.exec(sql)) !== null) {
          const refTable = match[1];
          if (refTable !== tableName) refs.push(refTable);
        }
        if (refs.length > 0) fkMap.set(tableName, [...new Set(refs)]);
      }
    }

    const sortedTables = topoSortForDrop(tables, fkMap);
    const atomic = ctx.flags.bool("atomic");

    // Bundle all drops into a single command.
    const dropSql = [
      "PRAGMA foreign_keys = OFF;",
      ...(atomic && !local ? ["BEGIN;"] : []),
      ...sortedTables.map((t) => `DROP TABLE IF EXISTS ${quoteIdent(t)};`),
      "DELETE FROM _migrations;",
      ...(atomic && !local ? ["COMMIT;"] : []),
      "PRAGMA foreign_keys = ON;",
    ].join("\n");

    await d1Execute({ dbName, local, remote, command: dropSql });

    console.log(`dropped ${sortedTables.length} table(s) and cleared _migrations`);
    await migrateRun(dbName, local, remote, { atomic });

    if (ctx.flags.bool("seed")) {
      await seedRun(dbName, local, remote, {});
    }
  },
};

register(command);
export { command as fresh };
