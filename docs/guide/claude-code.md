# Claude Code Integration

d1-eloquent ships with first-class [Claude Code](https://docs.anthropic.com/en/docs/claude-code) support through two complementary tools: a **skill** that teaches Claude how to write correct d1-eloquent code, and an **MCP server** that gives Claude live access to your D1 database.

## Skill

The d1-eloquent skill is a set of reference documents that Claude Code loads automatically when it detects you're working with d1-eloquent. It covers model definitions, migrations, query building, relationships, hooks, casting, seeders, factories, and every CLI command.

When the skill is active, Claude will:

- Generate models with correct `BaseModel<TAttrs>` patterns, TEXT primary keys, and proper casts
- Write migrations using the schema builder (not raw SQL)
- Use declarative `static relations` instead of legacy helpers
- Apply `configure(env)` auto-wiring or explicit `db` arguments consistently
- Follow all d1-eloquent conventions (soft deletes, revision tracking, mass assignment, etc.)

> [!WARNING]
> **Not yet publicly available.** The `d1-eloquent-skill` repository is still private, so the `git clone` command below **won't resolve during this beta**. This section documents the planned install flow; the skill goes public in a later beta.

### Install the Skill

```bash
# Clone into your Claude Code skills directory
git clone https://github.com/Orphnet/d1-eloquent-skill.git ~/.claude/skills/d1-eloquent-skill
```

That's it. Claude Code discovers skills from `~/.claude/skills/` automatically. The skill activates whenever you mention d1-eloquent, Cloudflare D1, or ask Claude to scaffold a Workers + D1 project.

> [!TIP]
> **No configuration needed**
> The skill has no dependencies or build step. It's a set of markdown reference files that Claude reads on demand.

## MCP Server

The MCP server (`@orphnet/d1-eloquent-mcp`) gives Claude, and any [Model Context Protocol](https://modelcontextprotocol.io) compatible client (Claude Desktop, Cursor, Windsurf, JetBrains), live, context-aware access to your project:

- **Introspect** your models, migrations, seeders, factories, and the actual D1 schema
- **Validate** every model against the live schema and report drift
- **Generate** new resources via your existing `bunx d1-eloquent make:*` CLI, including schema-diff migrations via `generate`
- **Execute** `migrate` / `rollback` / `fresh` / `seed` against your local D1
- **Query** the local D1 with read-only SQL (`SELECT` / `WITH` / `EXPLAIN` / `PRAGMA`)

> [!NOTE]
> **Local D1 only.** All query and execution tools target the **local** (miniflare) D1. Remote D1 access is planned for a future release.

### Install in Claude Code

```bash
claude mcp add d1-eloquent -- bunx @orphnet/d1-eloquent-mcp
```

### Install in Claude Desktop

Add to your `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "d1-eloquent": {
      "command": "bunx",
      "args": ["@orphnet/d1-eloquent-mcp"]
    }
  }
}
```

### Per-project (Claude Code)

Drop a `.claude/mcp.json` in your project so the server scopes to that codebase. To target a different directory, pass `--project`:

```json
{
  "mcpServers": {
    "d1-eloquent": {
      "command": "bunx",
      "args": ["@orphnet/d1-eloquent-mcp", "--project", "/path/to/your/project"]
    }
  }
}
```

### What gets discovered

On startup the server scans for `wrangler.jsonc` / `wrangler.toml`, classes that `extends BaseModel`, and the `migrations` / `seeders` / `factories` directories. Static parsing - it never imports your code, so it works without your build chain.

### Available Tools

**Introspection (read-only)**
- `list_models`, `read_model` - model classes + parsed metadata (relations, casts, soft deletes, revisions)
- `list_migrations`, `read_migration`, `migration_status`
- `inspect_schema` - what's actually in your D1 (`sqlite_master`)
- `query_d1` - read-only SQL against the local D1
- `list_seeders`, `list_factories`, `read_file`, `refresh_project`

**Validation (schema drift)**
- `validate_model` - compare one model's declared shape (table, casts, soft deletes, timestamps, revisions) against the actual local D1 schema
- `validate_all` - run the same check across every discovered model, with an ok / warn / fail summary

**Generation** (delegates to your existing CLI)
- `make_model`, `make_migration`, `make_seeder`, `make_factory`, `make_resource`, `make_pivot`
- `run_generate` - schema-diff your models against your migrations; dry-run by default, pass `write: true` to emit the reconciling migration file(s)

**Execution** (local D1)
- `run_migrate`, `run_rollback`, `run_fresh`, `run_seed`

### Resources

Claude can pull these in as background context:

- `d1-eloquent://project/summary` - your project's discovered state
- `d1-eloquent://docs/api/base-model`
- `d1-eloquent://docs/api/query-builder`
- `d1-eloquent://docs/api/relationships`
- `d1-eloquent://docs/api/transactions`
- `d1-eloquent://docs/guide/quick-start`

### Prompts

Pre-built multi-step workflow templates:

- `create-model` - scaffold + migrate + verify in one chat
- `audit-schema` - compare every model against the actual D1 schema, report drift

### Safety

- `query_d1` rejects anything other than `SELECT` / `WITH` / `EXPLAIN` / `PRAGMA`, rejects write/DDL keywords anywhere in the statement (so a CTE can't smuggle DML), and rejects multi-statement payloads.
- `read_file` refuses paths containing `..` or starting with `/`.
- Shell-outs use `spawnSync` with arg arrays - no shell-injection vectors.
- Execution tools (`run_migrate` / `run_rollback` / `run_fresh` / `run_seed`) only operate on the local D1.

## Resources

- [d1-eloquent-skill on GitHub](https://github.com/Orphnet/d1-eloquent-skill) - skill source and reference docs (repository private during this beta)
- [d1-eloquent-mcp on GitHub](https://github.com/Orphnet/d1-eloquent-mcp) - MCP server source + release notes
- [Claude Code documentation](https://docs.anthropic.com/en/docs/claude-code) - skills, MCP servers, and configuration
