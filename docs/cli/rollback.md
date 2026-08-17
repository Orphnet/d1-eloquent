# rollback

Undo already-applied migrations by executing the `down()` function from each migration file. By default, `rollback` reverts the **most recent batch** — every migration that was applied together in the last `migrate` run.

## Synopsis

```bash
bunx d1-eloquent rollback [--step=<n>] [--batch=<n>] [--pretend] [--atomic] [--db=<DB_NAME>] [--remote]
```

## Options

| Flag | Description |
| --- | --- |
| `--step=<n>` | Roll back the `n` most recently applied migrations, regardless of batch. Must be written as `--step=3` (the `--step 3` space form is not parsed). |
| `--batch=<n>` | Roll back every migration recorded under a specific batch number. |
| `--pretend` | Print the `down()` SQL that would run for each targeted migration, without executing it. |
| `--atomic` | Wrap each migration's rollback (its `down()` SQL plus the `_migrations` delete) in a single transaction. Applies to remote execution only. |
| `--db=<DB_NAME>` | Optional. The D1 binding name. Auto-detected from `wrangler.jsonc` (also `wrangler.json` / `wrangler.toml`), falls back to `'DB'`. |
| `--local` | Run against the local D1 database. This is the default. |
| `--remote` | Run against the Cloudflare-hosted D1 database. |

With neither `--step` nor `--batch`, `rollback` targets the entire latest batch.

## Examples

Roll back the most recent batch:

```bash
bunx d1-eloquent rollback
```

Roll back the three most recently applied migrations:

```bash
bunx d1-eloquent rollback --step=3
```

Roll back a specific batch:

```bash
bunx d1-eloquent rollback --batch=2
```

Preview the `down()` SQL without executing it:

```bash
bunx d1-eloquent rollback --pretend
```

Roll back the latest batch on the remote database:

```bash
bunx d1-eloquent rollback --remote
```

## Notes

- Targeted migrations are rolled back newest-first, so each `down()` runs in the reverse of the order its `up()` was applied.
- Ensure your `down()` function correctly reverses every change made by `up()`. If `down()` is missing or incomplete, rollback cannot fully restore the prior schema.
- After each migration is rolled back, its record is removed from `_migrations` so it can be re-applied with `migrate`.
- If there are no applied migrations, `rollback` prints `No migrations to rollback.` and exits without changes.
