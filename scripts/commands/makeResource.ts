import { register } from "../registry";
import { toSnakePlural } from "../utils";
import { formatModelName, makeModelRun } from "./makeModel";
import { makeMigrationRun } from "./makeMigration";
import { makeFactoryRun } from "./makeFactory";
import { makeSeederRun } from "./makeSeeder";
import type { TCommand } from "../types";

/** Core logic — generates model + migration + factory + seeder. */
export const makeResourceRun = async (rawName: string, softDeletes = false): Promise<void> => {
  const name = formatModelName(rawName);
  const tableName = toSnakePlural(name);
  const migrationName = `create_${tableName}`;

  console.log(`Generating resource: ${name}`);

  // Order: model -> migration -> factory -> seeder
  // Pass rawName to each — each applies its own formatting.
  await makeModelRun(rawName, softDeletes);
  await makeMigrationRun(migrationName);
  await makeFactoryRun(rawName);
  await makeSeederRun(rawName);

  console.log(`Resource ${name} created (model + migration + factory + seeder)`);
};

const command: TCommand = {
  meta: {
    name: "make:resource",
    description: "Create model + migration + factory + seeder",
    usage: "make:resource <name> [--soft-deletes]",
    category: "generate",
  },
  async run(ctx) {
    const name = ctx.args[0];
    if (!name) {
      console.error("Usage: make:resource <name> [--soft-deletes]");
      process.exit(1);
    }
    await makeResourceRun(name, ctx.flags.bool("soft-deletes"));
  },
};

register(command);
export { command as makeResource };
