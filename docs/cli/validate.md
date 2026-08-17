# validate

Check models against their migrations for drift. Catches mismatches between what a model declares and what the migration schema defines. No D1 connection is needed -- this command reads project files only.

## Synopsis

```bash
bunx d1-eloquent validate [model] [--json]
```

## Options

| Flag | Description |
| --- | --- |
| `[model]` | Optional. Validate a single model by name. Omit to validate all discovered models. |
| `--json` | Output machine-readable JSON. Exits with code 1 if any failures are found. |

---

## What it checks

| Check | Severity | Description |
| --- | --- | --- |
| No `static table` | **fail** | Model has no table name defined. |
| No migration found | **warn** | No migration file matches the model's table. |
| Timestamps mismatch | **fail** | Model has `timestamps=true` but migration is missing `created_at` or `updated_at`. |
| Soft deletes mismatch | **fail** | Model has `softDeletes=true` but migration is missing `deleted_at`. |
| Missing migration column | **warn** | A type field has no corresponding column in the migration. |
| Extra migration column | **warn** | A migration column is not represented in the model's type definition. |
| FK mismatch | **fail** | A `belongsTo` relation declares a `foreignKey` that has no matching migration column. |

**Severity levels:**

- **pass** -- all checks passed, no issues.
- **warn** -- potential drift that may be intentional (e.g. computed fields, relation-only types).
- **fail** -- definite mismatch that will cause runtime errors.

---

## Examples

### Validate all models

```bash
bunx d1-eloquent validate
```

```
Validating 4 model(s)...

  [PASS] User (src/app/models/User.ts)
  [PASS] Role (src/app/models/Role.ts)
  [WARN] Post (src/app/models/Post.ts)
    WARN: Type field "excerpt" has no matching migration column
  [FAIL] Comment (src/app/models/Comment.ts)
    FAIL: Model has timestamps=true but migration missing created_at column
    FAIL: Relation "post" declares foreignKey="post_id" but migration has no such column

Results: 2 passed, 1 warnings, 1 failed
```

The process exits with code 1 when any model has a **fail** status.

### Validate a single model

```bash
bunx d1-eloquent validate Comment
```

```
Validating 1 model(s)...

  [FAIL] Comment (src/app/models/Comment.ts)
    FAIL: Model has timestamps=true but migration missing created_at column
    FAIL: Relation "post" declares foreignKey="post_id" but migration has no such column

Results: 0 passed, 0 warnings, 1 failed
```

---

## JSON output

Use `--json` for CI pipelines. The output includes all validation results plus a count of skipped (unparseable) models.

```bash
bunx d1-eloquent validate --json
```

```json
{
  "results": [
    {
      "model": "User",
      "file": "src/app/models/User.ts",
      "status": "pass",
      "issues": [
        { "severity": "pass", "message": "All checks passed" }
      ]
    },
    {
      "model": "Comment",
      "file": "src/app/models/Comment.ts",
      "status": "fail",
      "issues": [
        { "severity": "fail", "message": "Model has timestamps=true but migration missing created_at column" },
        { "severity": "fail", "message": "Relation \"post\" declares foreignKey=\"post_id\" but migration has no such column" }
      ]
    }
  ],
  "skipped": 0
}
```

When any result has `"status": "fail"`, the process exits with code 1. This lets you gate deployments in CI:

```bash
bunx d1-eloquent validate --json || exit 1
```

---

## Unparseable models

Models that cannot be statically parsed (e.g. dynamically generated classes, non-standard syntax) are skipped with a warning:

```
  Skipping unparseable: src/app/models/Legacy.ts
```

The skipped count is included in both human-readable and JSON output.

---

## Notes

- Model names are matched case-insensitively against filenames.
- Use [inspect](./inspect.md) to view the full resolved schema for a single model before fixing issues.
