import { register } from "../registry";
import { parseModelFile, parseMigrationFile, type TModelMeta, type TMigrationMeta } from "../parser";
import { collectModelFiles, collectMigrationFiles } from "../utils";
import type { TCommand } from "../types";

type TSeverity = "pass" | "warn" | "fail";

type TValidationIssue = {
  severity: TSeverity;
  message: string;
};

type TModelValidation = {
  model: string;
  file: string;
  status: TSeverity;
  issues: TValidationIssue[];
};

const validateModel = (model: TModelMeta, migration: TMigrationMeta | null, modelFile: string): TModelValidation => {
  const issues: TValidationIssue[] = [];

  if (!model.table) {
    issues.push({ severity: "fail", message: "Model has no static table defined" });
  }

  if (!migration) {
    issues.push({ severity: "warn", message: `No migration found for table "${model.table}"` });
    return { model: model.className, file: modelFile, status: worstSeverity(issues), issues };
  }

  const columnNames = new Set(migration.columns.map((c) => c.name));

  // Check: timestamps declared but migration missing columns
  if (model.timestamps) {
    if (!columnNames.has("created_at") && !migration.hasTimestamps) {
      issues.push({ severity: "fail", message: "Model has timestamps=true but migration missing created_at column" });
    }
    if (!columnNames.has("updated_at") && !migration.hasTimestamps) {
      issues.push({ severity: "fail", message: "Model has timestamps=true but migration missing updated_at column" });
    }
  }

  // Check: softDeletes declared but migration missing deleted_at
  if (model.softDeletes) {
    if (!columnNames.has("deleted_at") && !migration.hasSoftDeletes) {
      issues.push({ severity: "fail", message: "Model has softDeletes=true but migration missing deleted_at column" });
    }
  }

  // Check: type fields that don't have corresponding migration columns
  for (const field of model.fields) {
    if (!columnNames.has(field.name)) {
      // Skip relation fields (they often don't have direct columns)
      const isRelation = model.relations.some((r) => r.name === field.name);
      if (!isRelation) {
        issues.push({ severity: "warn", message: `Type field "${field.name}" has no matching migration column` });
      }
    }
  }

  // Check: migration columns not represented in type
  const typeFieldNames = new Set(model.fields.map((f) => f.name));
  for (const col of migration.columns) {
    if (!typeFieldNames.has(col.name)) {
      issues.push({ severity: "warn", message: `Migration column "${col.name}" not in type definition` });
    }
  }

  // Check: belongsTo relations should have FK column in migration
  for (const rel of model.relations) {
    if (rel.type === "belongsTo" && rel.foreignKey) {
      if (!columnNames.has(rel.foreignKey)) {
        issues.push({ severity: "fail", message: `Relation "${rel.name}" declares foreignKey="${rel.foreignKey}" but migration has no such column` });
      }
    }
  }

  if (issues.length === 0) {
    issues.push({ severity: "pass", message: "All checks passed" });
  }

  return { model: model.className, file: modelFile, status: worstSeverity(issues), issues };
};

const worstSeverity = (issues: TValidationIssue[]): TSeverity => {
  if (issues.some((i) => i.severity === "fail")) return "fail";
  if (issues.some((i) => i.severity === "warn")) return "warn";
  return "pass";
};

const statusIcon = (s: TSeverity): string => {
  switch (s) {
    case "pass": return "PASS";
    case "warn": return "WARN";
    case "fail": return "FAIL";
  }
};

const command: TCommand = {
  meta: {
    name: "validate",
    description: "Check models against migrations for drift",
    usage: "validate [model] [--json]",
    category: "inspect",
  },
  async run(ctx) {
    const targetModel = ctx.args[0];
    const modelFiles = await collectModelFiles();
    const migrationFiles = await collectMigrationFiles();

    // Pre-parse all migrations indexed by table name
    const migrationsByTable = new Map<string, TMigrationMeta>();
    for (const file of migrationFiles) {
      try {
        const meta = await parseMigrationFile(file);
        if (meta?.table) migrationsByTable.set(meta.table, meta);
      } catch {
        // skip-and-warn handled below
      }
    }

    const results: TModelValidation[] = [];
    let skipped = 0;

    for (const file of modelFiles) {
      // Filter to specific model if requested
      if (targetModel) {
        const filename = file.split("/").pop()?.replace(/\.ts$/, "").toLowerCase();
        if (filename !== targetModel.toLowerCase()) continue;
      }

      let model: TModelMeta | null;
      try {
        model = await parseModelFile(file);
      } catch {
        console.warn(`  Skipping unparseable: ${file}`);
        skipped++;
        continue;
      }

      if (!model) {
        skipped++;
        continue;
      }

      const migration = model.table ? migrationsByTable.get(model.table) ?? null : null;
      results.push(validateModel(model, migration, file));
    }

    if (ctx.flags.bool("json")) {
      console.log(JSON.stringify({ results, skipped }, null, 2));
      const hasFails = results.some((r) => r.status === "fail");
      if (hasFails) process.exit(1);
      return;
    }

    // Human-readable output
    if (results.length === 0) {
      console.log(targetModel ? `No model found matching "${targetModel}"` : "No model files found.");
      return;
    }

    console.log(`\nValidating ${results.length} model(s)...\n`);

    for (const r of results) {
      console.log(`  [${statusIcon(r.status)}] ${r.model} (${r.file})`);
      for (const issue of r.issues) {
        if (issue.severity === "pass") continue;
        const prefix = issue.severity === "fail" ? "    FAIL:" : "    WARN:";
        console.log(`${prefix} ${issue.message}`);
      }
    }

    const passes = results.filter((r) => r.status === "pass").length;
    const warns = results.filter((r) => r.status === "warn").length;
    const fails = results.filter((r) => r.status === "fail").length;

    console.log(`\nResults: ${passes} passed, ${warns} warnings, ${fails} failed${skipped ? `, ${skipped} skipped` : ""}\n`);

    if (fails > 0) process.exit(1);
  },
};

register(command);
export { command as validate };
