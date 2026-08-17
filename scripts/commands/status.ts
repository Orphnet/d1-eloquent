import { d1Execute } from "../d1Execute";
import { register } from "../registry";
import { collectMigrationFiles, toImportUrl } from "../utils";
import type { TCommand, TMigration } from "../types";

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

const command: TCommand = {
  meta: {
    name: "status",
    description: "Show migration status",
    usage: "status",
    category: "database",
  },
  async run(ctx) {
    const local = !ctx.isRemote;
    const dbName = ctx.db;
    const remote = ctx.isRemote;

    await ensureMigrationsTable(dbName, local, remote);

    const ranRes = await d1Execute({
      dbName,
      local,
      remote,
      command: `SELECT name, batch, applied_at FROM _migrations ORDER BY id ASC;`
    });

    const ran = new Map<string, { batch: string; applied_at: string }>();
    for (const r of ranRes.results ?? []) {
      ran.set(String(r.name), { batch: String(r.batch), applied_at: String(r.applied_at) });
    }

    const files = await collectMigrationFiles();

    const rows: Array<{ name: string; description: string; status: string; batch: string; applied_at: string }> = [];

    for (const file of files) {
      const mod = (await import(toImportUrl(process.cwd() + "/" + file))) as { default: TMigration };
      const m = mod.default;

      const info = ran.get(m.name);
      rows.push({
        name: m.name,
        description: m.description ?? "-",
        status: info ? "ran" : "pending",
        batch: info?.batch ?? "-",
        applied_at: info?.applied_at ?? "-",
      });
    }

    const hasDescriptions = rows.some((r) => r.description !== "-");

    const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
    const wName = Math.max(10, ...rows.map((r) => r.name.length));
    const wDesc = hasDescriptions ? Math.max(12, ...rows.map((r) => r.description.length)) : 0;
    const wStatus = 8;
    const wBatch = 6;

    const descHeader = hasDescriptions ? `  ${pad("Description", wDesc)}` : "";
    const descSep = hasDescriptions ? `  ${"-".repeat(wDesc)}` : "";

    console.log(
      `${pad("Migration", wName)}${descHeader}  ${pad("Status", wStatus)}  ${pad("Batch", wBatch)}  Applied At`,
    );

    console.log(`${"-".repeat(wName)}${descSep}  ${"-".repeat(wStatus)}  ${"-".repeat(wBatch)}  ${"-".repeat(20)}`);

    for (const r of rows) {
      const descCol = hasDescriptions ? `  ${pad(r.description, wDesc)}` : "";
      console.log(`${pad(r.name, wName)}${descCol}  ${pad(r.status, wStatus)}  ${pad(r.batch, wBatch)}  ${r.applied_at}`);
    }
  },
};

register(command);
export { command as status };
