/**
 * Centralized flag parser for CLI commands.
 *
 * Replaces scattered `parseArgs(process.argv.slice(3))` calls with a
 * structured, typed interface.
 */

export type TFlags = {
  /** Get a string flag value: `--key=value` → `"value"`, `--key` → `undefined` */
  get(key: string): string | undefined;
  /** Get a required string flag, throws with a helpful message if missing. */
  getRequired(key: string): string;
  /** Check if a boolean flag is present: `--force` → `true` */
  bool(key: string): boolean;
  /** Check if a flag exists at all (with or without value). */
  has(key: string): boolean;
  /** All positional args (non-flag arguments). */
  positional: string[];
  /** Raw parsed record for backwards compatibility during migration. */
  raw: Record<string, string | boolean>;
};

export const parseFlags = (argv: string[]): TFlags => {
  const raw: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq === -1) {
        raw[arg.slice(2)] = true;
      } else {
        raw[arg.slice(2, eq)] = arg.slice(eq + 1);
      }
    } else {
      positional.push(arg);
    }
  }

  return {
    get(key: string): string | undefined {
      const v = raw[key];
      return typeof v === "string" ? v : undefined;
    },

    getRequired(key: string): string {
      const v = raw[key];
      if (typeof v !== "string" || !v) {
        throw new Error(`Missing required flag: --${key}`);
      }
      return v;
    },

    bool(key: string): boolean {
      return Boolean(raw[key]);
    },

    has(key: string): boolean {
      return key in raw;
    },

    positional,
    raw,
  };
};
