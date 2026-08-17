# Tinker — an interactive REPL for your D1

`d1-eloquent tinker` drops you into a REPL with **all your models already loaded**,
running against your **local** D1 database. No Worker, no boot wait — it opens the
wrangler SQLite file directly, so `User.all()` returns real rows instantly.

```sh
bunx d1-eloquent tinker
```

```
d1-eloquent tinker  ·  DB · my-app-db
15 models loaded · sandbox: changes roll back on exit (.commit to keep)
type .help for commands, .exit to quit

tinker> User.query().whereEq('is_admin', true).get()
Collection(2) [ User { … }, User { … } ]
```

It's built to fix the things that make people wary of a REPL against real data.

## Safe by default — sandboxed

Every session runs inside a transaction that **rolls back when you exit**. Poke,
mutate, break things — nothing is persisted unless you say so.

```
tinker> u = await User.find('u_123')
tinker> u.set('email', 'new@example.com').save()
tinker> .commit          # keep the change
✓ committed
tinker> .rollback        # …or throw away everything since the last commit
↩ rolled back
```

Exit without committing and you'll see `sandbox rolled back — no changes persisted`.
Need to write directly (no sandbox)? Start with `--live`.

## See the SQL — `.sql` and `.explain`

Toggle `.sql` to echo the SQL, bindings, and timing of every query you run:

```
tinker> .sql
SQL echo on
tinker> Post.query().whereEq('published', true).limit(5).get()
Collection(5) [ … ]
sql  SELECT * FROM posts WHERE published = ? AND (deleted_at IS NULL) LIMIT 5  ‹1›  0.7ms  5 rows
```

Note `published = ?` with binding `1` — booleans are dehydrated through your casts.
Then `.explain` runs `EXPLAIN QUERY PLAN` on the last query:

```
tinker> .explain
SELECT * FROM posts WHERE published = ? AND (deleted_at IS NULL) LIMIT 5
  SEARCH posts USING INDEX idx_posts_published (published=?)
```

## Readable output — `.table`, `.schema`, `.models`

```
tinker> .table Tag.query().limit(3).get()
id                                   │ label   │ color
─────────────────────────────────────┼─────────┼─────────
fe225024-013c-4b65-95c1-51e2bd53a23c │ urgent  │ #85168d
60959fdc-848c-4f35-bffa-20d428725f07 │ bug     │ #6b1b5e
28a2bf00-9a6c-453a-b1a2-7d8ba6fe1e1f │ feature │ #5f4b24
(3 rows)
```

- `.models` — list loaded models and their tables
- `.schema User` — columns, types, PK/NOT NULL (model name or table name)
- `.tables` — all database tables

## Ergonomics

- **Auto-`await`** — type `User.all()`, not `await User.all()`.
- **Persisted variables** — `u = await User.find(id)` then reuse `u` next line.
- **Tab completion** — model names, your variables, and `.commands`.
- **Models in scope by name** — no imports. `db` is the raw connection.
- **Case-mismatch hints** — type `workspace` when the model is `Workspace` and tinker suggests the right name instead of just erroring.

## Commands

| Command | Does |
|---|---|
| `.help` | list commands + what's in scope |
| `.models` / `.tables` | list models / database tables |
| `.schema <Model\|table>` | show a table's columns |
| `.seeders` / `.factories` | list the project's seeders / factories |
| `.sql` | toggle SQL + bindings + timing echo |
| `.explain` | `EXPLAIN QUERY PLAN` for the last query |
| `.table <expr>` | render an expression's rows as a table |
| `.commit` / `.rollback` | persist / discard sandbox changes, then continue |
| `.clear` | forget REPL variables (keeps models) |
| `.exit` | quit (rolls back the sandbox) |

## Flags

| Flag | Default | Does |
|---|---|---|
| `--live` | off | write directly — no sandbox transaction |
| `--file=<path>` | auto | use a specific SQLite file — overrides the auto-pick |

## Notes

- **Requires Bun** — the REPL opens the local D1 via `bun:sqlite`. Run it with
  `bunx d1-eloquent tinker`.
- **Local only for now** — remote D1 (`--remote`) isn't supported yet; it needs the
  D1 HTTP API for safe parameter binding.
- Run it from your project root, where your models live. If `wrangler dev` is
  holding the database, tinker waits briefly (`busy_timeout`) rather than failing.
- **Multiple local D1 files?** tinker opens the one with the most data and lists
  the candidates (table + row counts) so you can `--file` a different one.
