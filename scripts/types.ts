import type {Schema} from "./schema";
import type {TFlags} from "./flags";

// ─── Migration & Seeder types ────────────────────────────────────────────────

export type TMigration = {
  name: string;
  description?: string;
  up: (schema: Schema) => void | Promise<void>;
  down: (schema: Schema) => void | Promise<void>;
};

export type TSeederOpts = { dbName: string; local: boolean; remote: boolean; pretend?: boolean; idempotent?: boolean; fresh?: boolean; verbose?: boolean };
export type TSeeder = { name: string; description?: string; run: (opts: TSeederOpts) => Promise<void> };

// ─── D1 execution types ─────────────────────────────────────────────────────

export type TD1ExecOptions = {
  dbName: string;
  local: boolean;
  remote: boolean;
  command: string;
};

export type TD1JsonRow = Record<string, unknown>;

export type TD1JsonResult = {
  results?: TD1JsonRow[];
  success?: boolean;
  meta?: Record<string, unknown>;
};

export type TD1JsonRaw = TD1JsonResult | TD1JsonResult[];

// ─── Command registry types ─────────────────────────────────────────────────

export type TCommandCategory = "generate" | "database" | "inspect";

export type TCommandMeta = {
  /** Command name as invoked, e.g. "migrate", "make:model". */
  name: string;
  /** One-liner for help text. */
  description: string;
  /** Usage string, e.g. "make:model <name> [--soft-deletes]". */
  usage: string;
  /** Grouping for help display. */
  category: TCommandCategory;
};

export type TCommandContext = {
  /** Positional args after command name. */
  args: string[];
  /** Parsed flags (--key=value and --boolean). */
  flags: TFlags;
  /** Resolved D1 database binding name. */
  db: string;
  /** Whether --remote was passed. */
  isRemote: boolean;
};

export type TCommand = {
  meta: TCommandMeta;
  run: (ctx: TCommandContext) => Promise<void>;
};