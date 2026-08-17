# inspect

Print the resolved schema for a model by reading its source file and matching migration. No D1 connection is needed -- this command reads project files only.

## Synopsis

```bash
bunx d1-eloquent inspect <model> [--json]
```

## Options

| Flag | Description |
| --- | --- |
| `--json` | Output machine-readable JSON instead of the default human-readable format. |

The `<model>` argument is matched case-insensitively against filenames in your models directory (e.g. `User` matches `User.ts` or `user.ts`).

## What it shows

- **Model name, table, primary key**
- **Timestamps and soft deletes** flags
- **Type fields** from the model's attributes interface (name, type, optional)
- **Migration columns** from the matching migration (name, type, nullable, primary)
- **Relations** with type, foreign key, and pivot table where applicable
- **Casts** mapping (field to cast type)
- **Scopes** (named query scopes)
- **Hooks** (lifecycle hooks)

---

## Example

```bash
bunx d1-eloquent inspect Post
```

Human-readable output:

```
Model: Post
Table: posts
Primary Key: id
Timestamps: true
Soft Deletes: false

Type Fields:
  id: string
  title: string
  body: string
  user_id: string
  created_at: string
  updated_at: string

Migration Columns:
  id: TEXT (PK)
  title: TEXT
  body: TEXT
  user_id: TEXT
  created_at: TEXT
  updated_at: TEXT

Relations:
  author: belongsTo (fk=user_id)
  comments: hasMany

Casts:
  created_at: datetime
  updated_at: datetime

Scopes: published, recent

Hooks: creating, updating
```

---

## JSON output

```bash
bunx d1-eloquent inspect Post --json
```

```json
{
  "model": "Post",
  "table": "posts",
  "primaryKey": "id",
  "timestamps": true,
  "softDeletes": false,
  "fields": [
    { "name": "id", "type": "string", "optional": false },
    { "name": "title", "type": "string", "optional": false },
    { "name": "body", "type": "string", "optional": false },
    { "name": "user_id", "type": "string", "optional": false },
    { "name": "created_at", "type": "string", "optional": false },
    { "name": "updated_at", "type": "string", "optional": false }
  ],
  "columns": [
    { "name": "id", "type": "TEXT", "nullable": false, "primary": true },
    { "name": "title", "type": "TEXT", "nullable": false, "primary": false },
    { "name": "body", "type": "TEXT", "nullable": false, "primary": false },
    { "name": "user_id", "type": "TEXT", "nullable": false, "primary": false },
    { "name": "created_at", "type": "TEXT", "nullable": false, "primary": false },
    { "name": "updated_at", "type": "TEXT", "nullable": false, "primary": false }
  ],
  "relations": [
    { "name": "author", "type": "belongsTo", "foreignKey": "user_id" },
    { "name": "comments", "type": "hasMany" }
  ],
  "casts": {
    "created_at": "datetime",
    "updated_at": "datetime"
  },
  "scopes": ["published", "recent"],
  "hooks": ["creating", "updating"]
}
```

---

## Notes

- If no migration matches the model's table name, the **Migration Columns** section is omitted (human mode) or `columns` is an empty array (JSON mode).
- Sections with no data (no relations, no casts, etc.) are omitted from human-readable output.
- Migration column types are reported as uppercase SQLite storage classes — `TEXT`, `INTEGER`, `REAL`, `BLOB`, or `JSON`. `boolean` columns surface as `INTEGER`, and `json` columns are tagged `JSON` (stored as `TEXT`).
- Use [validate](./validate.md) to check for drift between models and migrations.
