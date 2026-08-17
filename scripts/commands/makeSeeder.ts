import { writeFile } from "node:fs/promises";
import { register } from "../registry";
import { ensureDir, toClassName } from "../utils";
import type { TCommand } from "../types";

export const formatSeederName = (raw: string): string => {
  const name = toClassName(raw);
  return name.endsWith("Seeder") ? name : name + "Seeder";
};

/** Core logic — callable by other commands (e.g. makeMigration --seeder). */
export const makeSeederRun = async (rawName: string): Promise<void> => {
  const name = formatSeederName(rawName);
  const dir = "src/database/seeders";

  await ensureDir(dir);

  const path = `${dir}/${name}.ts`;

  const contents = `import type { TSeeder, TSeederOpts } from "@orphnet/d1-eloquent/cli";
import { fake, output } from "@orphnet/d1-eloquent/cli";
// import { YourFactory } from "../factories/YourFactory";

const seeder: TSeeder = {
  name: "${name}",
  // description: "Purpose of this seeder",
  run: async (opts: TSeederOpts): Promise<void> => {
    // const factory = new YourFactory();
    // const rows = await factory.createMany(opts, 50);
    //
    // output.log(\`Seeded \${rows.length} records\`, { tag: "${name.replace("Seeder", "").toLowerCase()}" });
  },
};

export default seeder;
`;

  await writeFile(path, contents, "utf-8");
  console.log(`Created seeder: ${path}`);
};

const command: TCommand = {
  meta: {
    name: "make:seeder",
    description: "Create a new seeder file",
    usage: "make:seeder <name>",
    category: "generate",
  },
  async run(ctx) {
    const name = ctx.args[0];
    if (!name) {
      console.error("Usage: make:seeder <name>");
      process.exit(1);
    }
    await makeSeederRun(name);
  },
};

register(command);
export { command as makeSeeder };
