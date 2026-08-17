import {mkdir, readdir, stat} from "node:fs/promises";
import {readFileSync} from "node:fs";
import * as readline from "node:readline";
import {resolve as pathResolve, join as pathJoin} from "node:path";
import {pathToFileURL} from "node:url";

// ─── Naming conventions ──────────────────────────────────────────────────────

/**
 * Convert any casing (snake_case, kebab-case, space-separated) to PascalCase.
 * Shared by all make:* commands — replaces duplicated `toClassName` functions.
 */
export const toClassName = (s: string): string =>
  s
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");

// ─── Output directory helpers ────────────────────────────────────────────────

/** Resolve output directory from --out-dir flag, falling back to a default. */
export const resolveOutputDir = (outDirFlag: string | undefined, defaultDir: string): string => {
  return outDirFlag ? pathResolve(outDirFlag) : pathResolve(defaultDir);
};

// ─── Overwrite safety ────────────────────────────────────────────────────────

/** Check if a file exists. */
export const fileExists = async (path: string): Promise<boolean> => {
  return stat(path).then((s) => s.isFile()).catch(() => false);
};

/**
 * Prompt user to confirm overwrite when a file already exists.
 * Returns true if safe to proceed (file doesn't exist, user confirmed, or --force).
 */
export const confirmOverwrite = async (filePath: string, force: boolean): Promise<boolean> => {
  if (force) return true;
  if (!(await fileExists(filePath))) return true;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((res) => {
    rl.question(`File already exists: ${filePath}\nOverwrite? [y/N] `, (answer) => {
      rl.close();
      res(answer.trim().toLowerCase() === "y");
    });
  });
};

// ─── File discovery ──────────────────────────────────────────────────────────

/** Standard directories searched for migration files (project root + plugin dirs). */
export const collectMigrationFiles = async (): Promise<string[]> => {
  const baseDirs = [
    "src/database/migrations",
    "src/migrations",
    "migrations",
    "database/migrations",
  ];

  const pluginEntries = await readdir("src/plugins", {withFileTypes: true}).catch(() => []);
  const pluginDirs = pluginEntries
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => [
      `src/plugins/${entry.name}/migrations`,
      `src/plugins/${entry.name}/database/migrations`,
    ]);

  const allDirs = [...baseDirs, ...pluginDirs];
  const files = (await Promise.all(allDirs.map((dir) => listMigrationFiles(dir)))).flat();

  return Array.from(new Set(files)).sort((a, b) => {
    const aName = a.split("/").at(-1) ?? a;
    const bName = b.split("/").at(-1) ?? b;
    if (aName !== bName) return aName.localeCompare(bName);
    return a.localeCompare(b);
  });
};

/** Standard directories searched for seeder files (project root + plugin dirs). */
export const collectSeederDirs = async (): Promise<string[]> => {
  const baseDirs = [
    "src/database/seeders",
    "src/seeders",
    "seeders",
    "database/seeders",
  ];

  const pluginEntries = await readdir("src/plugins", {withFileTypes: true}).catch(() => []);
  const pluginDirs = pluginEntries
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => [
      `src/plugins/${entry.name}/seeders`,
      `src/plugins/${entry.name}/database/seeders`,
    ]);

  return [...baseDirs, ...pluginDirs];
};

export const parseArgs = (argv: string[]): Record<string, string | boolean> => {
  const out: Record<string, string | boolean> = {};
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const [k, v] = a.slice(2).split("=");
    out[k] = v === undefined ? true : v;
  }
  return out;
};

export const ensureDir = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true });
};

export const timestampId = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    String(d.getUTCFullYear()) +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds())
  );
};

export const nowIso = (): string => new Date().toISOString();

export const formatMigrationName = (raw: string): string => {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
};

export const listMigrationFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir).catch(() => []);
  const files = entries
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `${dir}/${f}`)
    .sort(); // timestamp prefix => correct order

  const out: string[] = [];
  for (const f of files) {
    const s = await stat(f).catch(() => null);
    if (s?.isFile()) out.push(f);
  }
  return out;
};

/**
 * Convert a filesystem path to a URL string safe for dynamic `import()`.
 * On Windows, absolute paths like `C:\foo\bar.ts` must be `file:///C:/foo/bar.ts`.
 */
export const toImportUrl = (fsPath: string): string => pathToFileURL(fsPath).href;

export const asNumber = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

// "create_blog_posts" → "BlogPosts"  |  "blog_posts" → "BlogPosts"
export const toPascalCase = (s: string): string => {
  const cleaned = s
    .replace(/^create_/, "")
    .replace(/^alter_/, "")
    .replace(/^update_/, "")
    .replace(/^drop_/, "");
  return cleaned
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
};

export const resolveDbFromWrangler = (): string | null => {
  // Try JSONC first, then TOML
  for (const file of ["wrangler.jsonc", "wrangler.json", "wrangler.toml"]) {
    try {
      const content = readFileSync(file, "utf-8");
      if (file.endsWith(".toml")) {
        const match = content.match(/\[\[d1_databases\]\][\s\S]*?binding\s*=\s*"([^"]+)"/);
        if (match?.[1]) return match[1];
      } else {
        // Strip comments for JSONC
        const json = content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
        const parsed = JSON.parse(json);
        const binding = parsed.d1_databases?.[0]?.binding;
        if (binding) return binding;
      }
    } catch {
      continue;
    }
  }
  return null;
};

// "BlogPost" → "blog_posts"  |  "BlogPosts" → "blog_posts"
export const toSnakePlural = (pascal: string): string => {
  const snake = pascal
    .replace(/([A-Z])/g, (m, p1, offset) => (offset > 0 ? "_" : "") + p1.toLowerCase())
    .toLowerCase();
  return snake.endsWith("s") ? snake : snake + "s";
};

/** Standard directories searched for model files (project root + plugin dirs). */
export const collectModelFiles = async (): Promise<string[]> => {
  const baseDirs = [
    "src/app/models",
    "src/models",
    "models",
    "app/models",
  ];

  const pluginEntries = await readdir("src/plugins", {withFileTypes: true}).catch(() => []);
  const pluginDirs = pluginEntries
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => [
      `src/plugins/${entry.name}/models`,
      `src/plugins/${entry.name}/app/models`,
    ]);

  const allDirs = [...baseDirs, ...pluginDirs];
  const files: string[] = [];

  for (const dir of allDirs) {
    const entries = await readdir(dir).catch(() => []);
    for (const f of entries) {
      if (!f.endsWith(".ts")) continue;
      const full = pathJoin(dir, f);
      const s = await stat(full).catch(() => null);
      if (s?.isFile()) files.push(full);
    }
  }

  return Array.from(new Set(files)).sort();
};
