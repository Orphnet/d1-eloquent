import { writeFile } from "node:fs/promises";
import { register } from "../registry";
import { ensureDir, toClassName, toSnakePlural } from "../utils";
import type { TCommand } from "../types";

export const formatFactoryName = (raw: string): string => {
  const name = toClassName(raw);
  return name.endsWith("Factory") ? name : name + "Factory";
};

/** Core logic — callable by other commands (e.g. makeMigration --factory). */
export const makeFactoryRun = async (rawName: string): Promise<void> => {
  const name = formatFactoryName(rawName);
  const modelName = name.replace(/Factory$/, "");
  const tableName = toSnakePlural(modelName);
  const dir = "src/database/factories";

  await ensureDir(dir);

  const path = `${dir}/${name}.ts`;

  const contents = `import { Factory } from "@orphnet/d1-eloquent";

export type T${modelName}Attrs = {
  id: string;
  // add fields
  created_at: string;
  updated_at: string;
};

export class ${name} extends Factory<T${modelName}Attrs> {
  public readonly table = "${tableName}";

  public definition(): T${modelName}Attrs {
    const ts = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      // define defaults
      created_at: ts,
      updated_at: ts,
    };
  }
}
`;

  await writeFile(path, contents, "utf-8");
  console.log(`Created factory: ${path}`);
};

const command: TCommand = {
  meta: {
    name: "make:factory",
    description: "Create a new factory file",
    usage: "make:factory <name>",
    category: "generate",
  },
  async run(ctx) {
    const name = ctx.args[0];
    if (!name) {
      console.error("Usage: make:factory <name>");
      process.exit(1);
    }
    await makeFactoryRun(name);
  },
};

register(command);
export { command as makeFactory };
