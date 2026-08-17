import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { register } from "../registry";
import { c } from "../tinker/format";
import type { TCommand } from "../types";

const command: TCommand = {
  meta: {
    name: "tinker",
    description: "Interactive REPL with your models loaded (sandboxed by default)",
    usage: "tinker [--live] [--file=<path>]",
    category: "inspect",
  },

  async run(ctx) {
    // The REPL is backed by `bun:sqlite`, so it requires Bun. Keep this guard
    // (and the lazy imports below) so loading the command list under Node never
    // pulls a Bun builtin.
    if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
      console.error(c.red("`tinker` requires Bun.") + " Run it with: " + c.cyan("bunx d1-eloquent tinker"));
      process.exit(1);
    }
    if (ctx.isRemote) {
      console.error(
        c.red("Remote tinker isn't supported yet.") +
          " It needs the D1 HTTP API for safe parameter binding (the wrangler CLI can't bind params). Run against local D1 instead.",
      );
      process.exit(1);
    }

    const { resolveLocalD1 } = await import("../tinker/resolveLocalD1");
    const { openD1 } = await import("../tinker/d1Sqlite");
    const { loadModels, discoverSeeders, discoverFactories } = await import("../tinker/loadModels");
    const { startTinker } = await import("../tinker/repl");

    // Resolve the local wrangler D1 SQLite file.
    const fileFlag = ctx.flags.get("file");
    const res = fileFlag
      ? { path: fileFlag, candidates: [{ path: fileFlag, rows: 0, tables: 0 }], ambiguous: false }
      : resolveLocalD1();
    if (!res) {
      console.error(
        c.red("No local D1 found.") +
          " Run `d1-eloquent migrate` first (it creates the local D1 under .wrangler/), or pass --file=<path>.",
      );
      process.exit(1);
    }
    if (res.ambiguous) {
      console.error(c.gray("Multiple local D1 files found — using the one with the most data:"));
      for (const cand of res.candidates) {
        const mark = cand.path === res.path ? c.cyan("  ← using") : "";
        console.error(c.gray(`  ${cand.path.split("/").pop()}  ·  ${cand.tables} tables, ${cand.rows} rows${mark}`));
      }
      console.error(c.gray("  override with --file=<path>"));
    }

    // Discover the project's models.
    const { models, errors } = await loadModels();
    for (const e of errors) console.error(c.gray(`  (skipped ${e.file}: ${e.error})`));
    if (models.length === 0) {
      console.error(c.red("No models found.") + " Run tinker from your project root (where your models live).");
      process.exit(1);
    }

    const opened = openD1(res.path);

    // `configure` must be the SAME @orphnet/d1-eloquent copy the models import,
    // so resolve it from the project — not this file's bundle.
    try {
      const bun = (globalThis as { Bun?: { resolveSync(s: string, d: string): string } }).Bun;
      const entry = bun!.resolveSync("@orphnet/d1-eloquent", process.cwd());
      const orm = (await import(pathToFileURL(entry).href)) as { configure: (env: Record<string, unknown>) => void };
      orm.configure({ DB: opened.d1 });
    } catch {
      console.error(c.red("Could not resolve @orphnet/d1-eloquent from this project.") + " Is it installed/linked here?");
      opened.close();
      process.exit(1);
    }

    const sandbox = !ctx.flags.bool("live"); // sandboxed by default; --live writes directly
    const [seeders, factories] = await Promise.all([discoverSeeders(), discoverFactories()]);

    await startTinker({
      shim: opened.shim,
      raw: opened.raw,
      models,
      binding: ctx.db,
      sandbox,
      remote: false,
      file: res.path,
      seeders,
      factories,
    });

    opened.close();
    process.exit(0);
  },
};

register(command);
export default command;
