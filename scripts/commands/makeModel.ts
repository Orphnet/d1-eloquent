import { writeFile } from "node:fs/promises";
import { register } from "../registry";
import { ensureDir, toClassName, toSnakePlural } from "../utils";
import type { TCommand } from "../types";

export const formatModelName = (raw: string): string => toClassName(raw.trim());

/** Core logic — callable by other commands (e.g. makeResource). */
export const makeModelRun = async (rawName: string, softDeletes = false): Promise<void> => {
  const name = formatModelName(rawName);
  const tableName = toSnakePlural(name);
  const dir = "src/app/models";
  await ensureDir(dir);

  const path = `${dir}/${name}.ts`;

  const deletedAtField = softDeletes ? "\n  deleted_at?: string | null;" : "";
  const softDeletesValue = softDeletes ? "true" : "false";

  const contents = `import { BaseModel } from "@orphnet/d1-eloquent";

export type T${name}Attrs = {
  id: string;
  // add fields
  created_at: string;
  updated_at: string;${deletedAtField}
};

export class ${name} extends BaseModel<T${name}Attrs> {
  public static table = "${tableName}";
  public static primaryKey = "id";
  public static softDeletes = ${softDeletesValue};

  // public static revisions = { enabled: true, mode: "diff+after", includeRequestId: true };
  // public static eagerLoaders = { ... };
}
`;

  await writeFile(path, contents, "utf-8");
  console.log(`Created model: ${path}`);
};

const command: TCommand = {
  meta: {
    name: "make:model",
    description: "Create a new model file",
    usage: "make:model <name> [--soft-deletes]",
    category: "generate",
  },
  async run(ctx) {
    const name = ctx.args[0];
    if (!name) {
      console.error("Usage: make:model <name> [--soft-deletes]");
      process.exit(1);
    }
    await makeModelRun(name, ctx.flags.bool("soft-deletes"));
  },
};

register(command);
export { command as makeModel };
