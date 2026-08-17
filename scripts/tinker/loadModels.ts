import { readdir } from "node:fs/promises";
import { collectModelFiles, collectSeederDirs, toImportUrl } from "../utils";

export type LoadedModel = {
  /** Class name as it will appear in the REPL scope. */
  name: string;
  /** The BaseModel subclass constructor. */
  ctor: ModelLike;
};

export type ModelLike = {
  name: string;
  table: string;
  query: (...args: unknown[]) => unknown;
  casts?: Record<string, unknown>;
  relations?: Record<string, unknown>;
  scopes?: Record<string, unknown>;
};

export type LoadModelsResult = {
  models: LoadedModel[];
  errors: Array<{ file: string; error: string }>;
};

/**
 * Discover and dynamically import the project's model classes so they can be
 * dropped into the REPL scope by name.
 *
 * Detection is duck-typed (a function with a static `table` string and a static
 * `query` method) rather than `instanceof BaseModel`, so it stays correct even
 * if the loader and the user's models resolve `@orphnet/d1-eloquent` to
 * different module instances (e.g. source vs. linked dist).
 */
export async function loadModels(cwd: string = process.cwd()): Promise<LoadModelsResult> {
  const files = await collectModelFiles();
  const models: LoadedModel[] = [];
  const errors: Array<{ file: string; error: string }> = [];
  const seen = new Set<string>();

  for (const file of files) {
    try {
      const mod = (await import(toImportUrl(`${cwd}/${file}`))) as Record<string, unknown>;
      for (const [key, val] of Object.entries(mod)) {
        if (!isModelClass(val)) continue;
        const name = (val as ModelLike).name || key;
        if (seen.has(name)) continue;
        seen.add(name);
        models.push({ name, ctor: val as ModelLike });
      }
    } catch (e) {
      errors.push({ file, error: (e as Error).message });
    }
  }

  models.sort((a, b) => a.name.localeCompare(b.name));
  return { models, errors };
}

function isModelClass(val: unknown): val is ModelLike {
  return (
    typeof val === "function" &&
    typeof (val as Partial<ModelLike>).table === "string" &&
    typeof (val as Partial<ModelLike>).query === "function"
  );
}

export type DiscoveredFile = { name: string; file: string };

const FACTORY_DIRS = ["src/database/factories", "src/factories", "factories", "database/factories"];

/** List the `.ts` files in the given project-relative directories (first dir wins on name clash). */
async function listTs(dirs: string[], cwd: string): Promise<DiscoveredFile[]> {
  const out: DiscoveredFile[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = (await readdir(`${cwd}/${dir}`)).filter((f) => f.endsWith(".ts"));
    } catch {
      continue;
    }
    for (const f of entries) {
      const name = f.replace(/\.ts$/, "");
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, file: `${dir}/${f}` });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Discover the project's seeder files (`.seeders` in the REPL). */
export async function discoverSeeders(cwd: string = process.cwd()): Promise<DiscoveredFile[]> {
  return listTs(await collectSeederDirs(), cwd);
}

/** Discover the project's factory files (`.factories` in the REPL). */
export async function discoverFactories(cwd: string = process.cwd()): Promise<DiscoveredFile[]> {
  return listTs(FACTORY_DIRS, cwd);
}
