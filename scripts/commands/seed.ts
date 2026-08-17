import { stat } from "node:fs/promises";
import { resolve as resolvePath, sep } from "node:path";
import { d1Execute } from "../d1Execute";
import { register } from "../registry";
import { resetClearedTables } from "../factory";
import type { TCommand, TSeeder } from "../types";
import { collectSeederDirs, toImportUrl } from "../utils";

/**
 * Seeder names are class identifiers (e.g. `UserSeeder`). Restricting them to
 * `[A-Za-z0-9_]` prevents a crafted name (`../../evil`) from escaping the seeder
 * directories — the name is interpolated into a filesystem path and then dynamic
 * `import()`ed, so an unsanitized name is a path-traversal code-execution vector
 * (reachable via the CLI and the MCP `run_seed` tool).
 */
export const isValidSeederName = (name: string): boolean => /^[A-Za-z0-9_]+$/.test(name);

const findSeederFile = async (seederName: string): Promise<string | null> => {
  if (!isValidSeederName(seederName)) return null;

  const dirs = await collectSeederDirs();
  const cwd = process.cwd();

  for (const dir of dirs) {
    const baseDir = resolvePath(cwd, dir);
    const file = resolvePath(baseDir, `${seederName}.ts`);
    // Defense in depth: never load a resolved path outside its seeder directory.
    if (file !== `${baseDir}${sep}${seederName}.ts`) continue;
    const exists = await stat(file).then((s) => s.isFile()).catch(() => false);
    if (exists) return file;
  }

  return null;
};

/** Core logic — callable by other commands (e.g. fresh --seed). */
export const seedRun = async (
  dbName: string,
  local: boolean,
  remote: boolean,
  flags: { seeder?: string; pretend?: boolean; idempotent?: boolean; fresh?: boolean; verbose?: boolean },
): Promise<void> => {
  const seederName = flags.seeder ?? "DatabaseSeeder";
  const pretend = flags.pretend ?? false;
  const idempotent = flags.idempotent ?? false;
  const fresh = flags.fresh ?? false;
  const verbose = flags.verbose ?? false;

  if (!isValidSeederName(seederName)) {
    console.error(
      `Invalid seeder name: ${JSON.stringify(seederName)}. Seeder names may only contain letters, numbers, and underscores.`,
    );
    process.exit(1);
  }

  const file = await findSeederFile(seederName);
  if (!file) {
    console.error(`Seeder not found: ${seederName}.ts`);
    process.exit(1);
  }

  let mod: { default: TSeeder };
  try {
    mod = (await import(toImportUrl(file))) as { default: TSeeder };
  } catch (err) {
    console.error(`Failed to import seeder: ${file}`);
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // Reset per-table clear tracking before each seed run
  resetClearedTables();

  const flagLabels = [pretend && "pretend", idempotent && "idempotent", fresh && "fresh"].filter(Boolean).join(", ");
  console.log(`${flagLabels ? `[${flagLabels}] ` : ""}Running: ${mod.default.name}`);
  if (verbose && mod.default.description) {
    console.log(`   \x1b[2m${mod.default.description}\x1b[0m`);
  }
  await mod.default.run({ dbName, local, remote, pretend, idempotent, fresh, verbose });
  console.log(`Done: ${mod.default.name}`);
};

const command: TCommand = {
  meta: {
    name: "seed",
    description: "Run database seeders",
    usage: "seed [seeder] [--pretend] [--idempotent] [--fresh]",
    category: "database",
  },
  async run(ctx) {
    const local = !ctx.isRemote;
    // Support positional arg: `seed UserSeeder`
    const seederName = ctx.args[0] ?? ctx.flags.get("seeder") ?? ctx.flags.get("class");

    await seedRun(ctx.db, local, ctx.isRemote, {
      seeder: seederName,
      pretend: ctx.flags.bool("pretend"),
      idempotent: ctx.flags.bool("idempotent"),
      fresh: ctx.flags.bool("fresh") || ctx.flags.bool("clear"),
      verbose: ctx.flags.bool("verbose") || ctx.flags.bool("v"),
    });
  },
};

register(command);
export { command as seed };
