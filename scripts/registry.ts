/**
 * Command registry — single source of truth for all CLI commands.
 *
 * Each command self-registers via `register()`. The CLI entry point
 * resolves and dispatches via `resolve()`. Help text is auto-generated
 * from `all()` grouped by category.
 */

import type {TCommand, TCommandCategory} from "./types";

const commands: Map<string, TCommand> = new Map();

/** Register a command. Throws on duplicate name. */
export const register = (cmd: TCommand): void => {
  if (commands.has(cmd.meta.name)) {
    throw new Error(`Duplicate command registration: "${cmd.meta.name}"`);
  }
  commands.set(cmd.meta.name, cmd);
};

/** Resolve a command by name. Returns undefined if not found. */
export const resolve = (name: string): TCommand | undefined => {
  return commands.get(name);
};

/** Get all registered commands. */
export const all = (): TCommand[] => {
  return [...commands.values()];
};

/** Category display order and labels. */
const categoryOrder: TCommandCategory[] = ["generate", "database", "inspect"];
const categoryLabels: Record<TCommandCategory, string> = {
  generate: "Code Generation",
  database: "Database Operations",
  inspect: "Inspection & Validation",
};

/** Generate formatted help text from all registered commands. */
export const generateHelp = (): string => {
  const cmds = all();

  const grouped = new Map<TCommandCategory, TCommand[]>();
  for (const cmd of cmds) {
    const list = grouped.get(cmd.meta.category) ?? [];
    list.push(cmd);
    grouped.set(cmd.meta.category, list);
  }

  const lines: string[] = [
    "d1-eloquent - CLI for D1 Eloquent ORM",
    "",
    "Usage:",
    "  d1-eloquent <command> [options]",
    "",
  ];

  for (const cat of categoryOrder) {
    const list = grouped.get(cat);
    if (!list?.length) continue;

    lines.push(`${categoryLabels[cat]}:`);

    // Align descriptions to the longest usage string
    const maxUsage = Math.max(...list.map((c) => c.meta.usage.length));

    for (const cmd of list) {
      const pad = " ".repeat(maxUsage - cmd.meta.usage.length + 2);
      lines.push(`  ${cmd.meta.usage}${pad}${cmd.meta.description}`);
    }

    lines.push("");
  }

  lines.push(
    "Global Options:",
    "  --db=<name>             D1 database binding name (auto-detected from wrangler config)",
    "  --local                 Execute against local D1 (default)",
    "  --remote                Execute against remote D1",
    "  --json                  Output as JSON (where supported)",
    "  --force                 Skip confirmation prompts",
    "  --help                  Show this help message",
    "",
  );

  return lines.join("\n");
};
