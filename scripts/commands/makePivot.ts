import { writeFile } from "node:fs/promises";
import { register } from "../registry";
import { ensureDir, formatMigrationName, timestampId } from "../utils";
import type { TCommand } from "../types";

const derivePivotColumns = (tableName: string): [string, string] => {
  const parts = tableName.split("_").filter(Boolean);
  if (parts.length < 2) {
    throw new Error(
      `make:pivot requires underscore-separated table name (e.g. user_roles), got: "${tableName}"`
    );
  }
  // "user_roles" → ["user", "roles"] → first=user, second=role (strip trailing s)
  const second = parts[parts.length - 1].replace(/s$/, "");
  const first = parts.slice(0, -1).join("_").replace(/s$/, "");
  return [`${first}_id`, `${second}_id`];
};

/** Core logic — callable by other commands if needed. */
export const makePivotRun = async (rawName: string): Promise<void> => {
  const tableName = formatMigrationName(rawName); // normalize to snake_case
  const [col1, col2] = derivePivotColumns(tableName);
  const ts = timestampId();
  const migrationName = `${ts}_create_${tableName}`;
  const dir = "src/database/migrations";

  await ensureDir(dir);

  const path = `${dir}/${migrationName}.ts`;

  const contents = `import type { TMigration } from "@orphnet/d1-eloquent/cli";
import { Schema } from "@orphnet/d1-eloquent/cli";

const migration: TMigration = {
  name: "${migrationName}",

  up: (schema: Schema) => {
    schema.createTable("${tableName}", (t) => {
      t.text("${col1}", { nullable: false });
      t.text("${col2}", { nullable: false });
      t.primary("${col1}, ${col2}");
      t.index("${col1}");
      t.index("${col2}");
    });
  },

  down: (schema: Schema) => {
    schema.dropTable("${tableName}");
  },
};

export default migration;
`;

  await writeFile(path, contents, "utf-8");
  console.log(`Created pivot migration: ${path} (columns: ${col1}, ${col2})`);
};

const command: TCommand = {
  meta: {
    name: "make:pivot",
    description: "Create a pivot table migration",
    usage: "make:pivot <table_name>",
    category: "generate",
  },
  async run(ctx) {
    const name = ctx.args[0];
    if (!name) {
      console.error("Usage: make:pivot <table_name>  (e.g. make:pivot user_roles)");
      process.exit(1);
    }
    await makePivotRun(name);
  },
};

register(command);
export { command as makePivot };
