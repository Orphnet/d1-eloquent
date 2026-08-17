import { writeFile } from "node:fs/promises";
import { register } from "../registry";
import { ensureDir, formatMigrationName, timestampId, toPascalCase } from "../utils";
import { makeFactoryRun } from "./makeFactory";
import { makeSeederRun } from "./makeSeeder";
import type { TCommand } from "../types";

/** Core logic — callable by other commands (e.g. makeResource). */
export const makeMigrationRun = async (rawName: string, withFactory = false, withSeeder = false): Promise<void> => {
  const name = formatMigrationName(rawName);
  const ts = timestampId();
  const migrationName = `${ts}_${name}`;
  const dir = "src/database/migrations";

  await ensureDir(dir);

  const path = `${dir}/${migrationName}.ts`;

  const guessedTable = name
    .replace(/^create_/, "")
    .replace(/^alter_/, "")
    .replace(/^update_/, "")
    .replace(/^drop_/, "");

  const contents = `import type { TMigration } from "@orphnet/d1-eloquent/cli";
import { Schema } from "@orphnet/d1-eloquent/cli";

const migration: TMigration = {
  name: "${migrationName}",
  // description: "Purpose of this migration",

  up: (schema: Schema) => {
    // schema.createTable("${guessedTable}", (t) => {
    //   t.id();
    //   t.timestamps();
    // });
  },

  down: (schema: Schema) => {
    // schema.dropTable("${guessedTable}");
  },
};

export default migration;
`;

  await writeFile(path, contents, "utf-8");
  console.log(`Created migration: ${path}`);

  const guessedModel = toPascalCase(guessedTable);
  if (withFactory) await makeFactoryRun(guessedModel + "Factory");
  if (withSeeder) await makeSeederRun(guessedModel + "Seeder");
};

const command: TCommand = {
  meta: {
    name: "make:migration",
    description: "Create a new migration file",
    usage: "make:migration <name> [--factory] [--seeder] [--all]",
    category: "generate",
  },
  async run(ctx) {
    const name = ctx.args[0];
    if (!name) {
      console.error("Usage: make:migration <name>");
      process.exit(1);
    }

    const withFactory = ctx.flags.bool("factory") || ctx.flags.bool("all");
    const withSeeder = ctx.flags.bool("seeder") || ctx.flags.bool("all");

    await makeMigrationRun(name, withFactory, withSeeder);
  },
};

register(command);
export { command as makeMigration };
