import { installResolveHook } from "./installResolveHook";
import { parseFlags } from "./flags";
import { resolve, generateHelp } from "./registry";
import { resolveDbFromWrangler } from "./utils";

// Let project seeders/migrations/models use extensionless relative imports under
// plain Node (no-op under Bun). Must run before any user file is dynamically
// imported by the migrate/seed/fresh commands.
installResolveHook();

// ─── Register all commands (side-effect imports) ────────────────────────────
import "./commands/makeMigration";
import "./commands/makeModel";
import "./commands/makeFactory";
import "./commands/makeSeeder";
import "./commands/makeResource";
import "./commands/makePivot";
import "./commands/migrate";
import "./commands/rollback";
import "./commands/status";
import "./commands/fresh";
import "./commands/seed";
import "./commands/inspect";
import "./commands/validate";
import "./commands/generate";
import "./commands/makeDto";
import "./commands/makeTypes";
import "./commands/tinker";

// ─── Dispatch ───────────────────────────────────────────────────────────────

const cmdName = process.argv[2];
const flags = parseFlags(process.argv.slice(3));

if (!cmdName || cmdName === "--help" || cmdName === "help" || cmdName === "-h") {
  console.log(generateHelp());
  process.exit(0);
}

const command = resolve(cmdName);
if (!command) {
  console.error(`Unknown command: ${cmdName}\n`);
  console.log(generateHelp());
  process.exit(1);
}

// Resolve DB config once — shared by all commands
const dbName = flags.get("db") ?? flags.get("database") ?? flags.get("d1") ?? resolveDbFromWrangler() ?? "DB";
const isRemote = flags.bool("remote");

await command.run({
  args: flags.positional,
  flags,
  db: dbName,
  isRemote,
});
