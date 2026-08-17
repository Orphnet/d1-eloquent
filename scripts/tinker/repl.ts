import * as readline from "node:readline";
import type { Database } from "bun:sqlite";
import type { ShimD1 } from "./d1Sqlite";
import type { LoadedModel } from "./loadModels";
import { c, formatValue, formatQueries, renderTable } from "./format";

export type TinkerOptions = {
  shim: ShimD1;
  raw: Database;
  models: LoadedModel[];
  /** D1 binding name (for the banner). */
  binding: string;
  /** Wrap the session in a transaction that rolls back on exit. */
  sandbox: boolean;
  /** True when connected to remote D1 (banner warning). */
  remote: boolean;
  /** SQLite file being used (for the banner). */
  file?: string;
  /** Discovered seeders / factories (for `.seeders` / `.factories`). */
  seeders: { name: string; file: string }[];
  factories: { name: string; file: string }[];
};

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...a: unknown[]) => Promise<unknown>;

export function startTinker(opts: TinkerOptions): Promise<void> {
  const { shim, raw, models, sandbox } = opts;

  // ── evaluation scope ───────────────────────────────────────────────────────
  const backing: Record<string, unknown> = Object.create(null);
  for (const m of models) backing[m.name] = m.ctor;
  backing.db = shim;
  backing.models = models.map((m) => m.name);
  backing.console = console;

  const scope = new Proxy(backing, {
    has: () => true,
    get: (t, k) => (k in t ? t[k] : (globalThis as Record<string | symbol, unknown>)[k]),
    set: (t, k, v) => {
      t[k as string] = v;
      return true;
    },
  });

  async function evaluate(code: string): Promise<unknown> {
    let fn: (...a: unknown[]) => Promise<unknown>;
    try {
      fn = new AsyncFunction("__scope", `with (__scope) { return (${code}\n); }`);
    } catch {
      fn = new AsyncFunction("__scope", `with (__scope) { ${code}\n }`);
    }
    let r = await fn(scope);
    if (r && typeof (r as { then?: unknown }).then === "function") r = await r;
    return r;
  }

  // ── output ─────────────────────────────────────────────────────────────────
  let sqlEcho = false;
  const out = (s: string) => process.stdout.write(s + "\n");
  const begin = () => { if (sandbox) raw.exec("BEGIN"); };

  // ── dot-commands ─────────────────────────────────────────────────────────────
  const userTables = (): string[] =>
    (raw
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>).map((r) => r.name);

  const commands: Record<string, { help: string; run: (arg: string) => Promise<void> | void }> = {
    help: {
      help: "show this help",
      run: () => {
        out(c.bold("\nMeta-commands:"));
        for (const [name, cmd] of Object.entries(commands)) out(`  ${c.cyan("." + name).padEnd(22)} ${c.gray(cmd.help)}`);
        out(c.bold("\nIn scope: ") + c.gray(`${models.map((m) => m.name).join(", ")}, db, models`));
        out(c.gray("Auto-awaited — type `User.all()`, no await needed.\n"));
      },
    },
    models: {
      help: "list the loaded models + tables",
      run: () => out(models.map((m) => `  ${c.cyan(m.name).padEnd(24)} ${c.gray(m.ctor.table)}`).join("\n")),
    },
    tables: { help: "list database tables", run: () => out("  " + userTables().join("\n  ")) },
    seeders: {
      help: "list this project's seeders",
      run: () =>
        out(
          opts.seeders.length
            ? opts.seeders.map((s) => `  ${c.cyan(s.name).padEnd(28)} ${c.gray(s.file)}`).join("\n")
            : c.gray("no seeders found"),
        ),
    },
    factories: {
      help: "list this project's factories",
      run: () =>
        out(
          opts.factories.length
            ? opts.factories.map((f) => `  ${c.cyan(f.name).padEnd(28)} ${c.gray(f.file)}`).join("\n")
            : c.gray("no factories found"),
        ),
    },
    schema: {
      help: "schema of a model or table  (.schema User)",
      run: (arg) => {
        const model = models.find((m) => m.name.toLowerCase() === arg.trim().toLowerCase());
        const table = model ? model.ctor.table : arg.trim();
        if (!table) return out(c.red("usage: .schema <Model|table>"));
        const cols = raw.query(`PRAGMA table_info("${table}")`).all() as Array<{
          name: string; type: string; notnull: number; pk: number;
        }>;
        if (cols.length === 0) return out(c.red(`no table "${table}"`));
        out(c.bold(`\n${table}`));
        for (const col of cols) {
          const flags = [col.pk ? c.yellow("PK") : "", col.notnull ? c.gray("NOT NULL") : ""].filter(Boolean).join(" ");
          out(`  ${col.name.padEnd(20)} ${c.magenta(col.type || "—").padEnd(18)} ${flags}`);
        }
        out("");
      },
    },
    sql: {
      help: "toggle echoing the SQL of each query",
      run: () => { sqlEcho = !sqlEcho; out(c.gray(`SQL echo ${sqlEcho ? "on" : "off"}`)); },
    },
    explain: {
      help: "EXPLAIN QUERY PLAN for the last query you ran",
      run: () => {
        const last = shim.lastReadQuery();
        if (!last) return out(c.gray("no query yet"));
        out(c.gray(last.sql));
        const plan = raw.query(`EXPLAIN QUERY PLAN ${last.sql}`).all(...(last.params as never[])) as Array<{ detail: string }>;
        for (const row of plan) out("  " + row.detail);
      },
    },
    table: {
      help: "render an expression's rows as a table  (.table User.all())",
      run: async (arg) => {
        if (!arg.trim()) return out(c.red("usage: .table <expression>"));
        try { out(renderTable(await evaluate(arg))); }
        catch (e) { out(c.red((e as Error).message)); }
      },
    },
    commit: {
      help: "persist changes made so far (sandbox), then keep going",
      run: () => {
        if (!sandbox) return out(c.gray("not in a sandbox — changes already persist"));
        raw.exec("COMMIT"); begin();
        out(c.green("✓ committed"));
      },
    },
    rollback: {
      help: "discard changes made so far (sandbox), then keep going",
      run: () => {
        if (!sandbox) return out(c.gray("not in a sandbox — nothing to roll back"));
        raw.exec("ROLLBACK"); begin();
        out(c.yellow("↩ rolled back"));
      },
    },
    clear: {
      help: "forget REPL variables (keeps models)",
      run: () => {
        for (const k of Object.keys(backing)) {
          if (!models.some((m) => m.name === k) && !["db", "models", "console"].includes(k)) delete backing[k];
        }
        out(c.gray("cleared"));
      },
    },
    exit: { help: "exit (rolls back the sandbox)", run: () => { /* handled by loop */ } },
  };
  commands.quit = commands.exit;

  // ── completion ───────────────────────────────────────────────────────────────
  const completer = (line: string): [string[], string] => {
    if (line.startsWith(".")) {
      const frag = line.slice(1);
      const hits = Object.keys(commands).filter((n) => n.startsWith(frag)).map((n) => "." + n);
      return [hits.length ? hits : Object.keys(commands).map((n) => "." + n), line];
    }
    const token = line.match(/[A-Za-z_$][\w$]*$/)?.[0] ?? "";
    const names = [...models.map((m) => m.name), "db", "models", ...Object.keys(backing)];
    const hits = [...new Set(names)].filter((n) => n.startsWith(token));
    return [hits.length ? hits : [], token];
  };

  // ── banner ───────────────────────────────────────────────────────────────────
  out(c.bold("\nd1-eloquent tinker") + c.gray(`  ·  ${opts.remote ? c.yellow("REMOTE " + opts.binding) : opts.binding}${opts.file ? c.gray(" · " + opts.file.split("/").pop()) : ""}`));
  out(c.gray(`${models.length} models loaded · ${sandbox ? c.green("sandbox: changes roll back on exit (.commit to keep)") : c.yellow("LIVE: changes persist immediately")}`));
  out(c.gray("type .help for commands, .exit to quit\n"));

  // ── loop ─────────────────────────────────────────────────────────────────────
  begin();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: c.cyan("tinker> "),
    completer,
    terminal: process.stdin.isTTY === true,
  });

  return (async () => {
    rl.prompt();
    for await (const raw_line of rl) {
      const line = raw_line.trim();
      if (line === "") { rl.prompt(); continue; }

      if (line.startsWith(".")) {
        const afterDot = line.slice(1);
        const rawName = afterDot.split(/\s+/)[0] ?? "";
        const name = rawName.replace(/\W+$/, ""); // tolerate `.sql()`, `.explain#`
        const arg = afterDot.slice(rawName.length).trim();
        if (name === "exit" || name === "quit") break;
        const cmd = commands[name];
        if (!cmd) out(c.red(`unknown command .${name} — try .help`));
        else { try { await cmd.run(arg); } catch (e) { out(c.red((e as Error).message)); } }
        rl.prompt();
        continue;
      }

      const cursor = shim.log.length;
      try {
        const result = await evaluate(line);
        if (result !== undefined) out(formatValue(result));
        if (sqlEcho && shim.log.length > cursor) out(formatQueries(shim.log.slice(cursor)));
      } catch (e) {
        out(c.red((e as Error).name + ": " + (e as Error).message));
        // Hint for a case-mismatched model name (e.g. `workspace` → `Workspace`).
        const miss = (line.match(/[A-Za-z_$][\w$]*/g) ?? []).find(
          (t) => !(t in backing) && models.some((m) => m.name.toLowerCase() === t.toLowerCase() && m.name !== t),
        );
        if (miss) {
          const correct = models.find((m) => m.name.toLowerCase() === miss.toLowerCase())!.name;
          out(c.gray("  did you mean ") + c.cyan(correct) + c.gray("?"));
        }
      }
      rl.prompt();
    }

    rl.close();
    if (sandbox) {
      raw.exec("ROLLBACK");
      out(c.gray("\nsandbox rolled back — no changes persisted (use .commit next time to keep them)"));
    }
    out(c.gray("bye 👋"));
  })();
}
