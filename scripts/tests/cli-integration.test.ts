import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(__dirname, "..", "cli.ts");
const run = (args: string, cwd?: string): string =>
  execSync(`npx tsx ${CLI} ${args}`, {
    encoding: "utf-8",
    cwd,
    timeout: 30_000,
  });

// ─── Help output ───────────────────────────────────────────────────────────

describe("CLI help", () => {
  let helpText: string;

  beforeAll(() => {
    helpText = run("--help");
  });

  it("prints all 15 commands", () => {
    const commands = [
      "make:model",
      "make:migration",
      "make:factory",
      "make:seeder",
      "make:resource",
      "make:pivot",
      "make:dto",
      "make:types",
      "migrate",
      "rollback",
      "status",
      "seed",
      "fresh",
      "inspect",
      "validate",
    ];

    for (const cmd of commands) {
      expect(helpText).toContain(cmd);
    }
  });

  it("prints all 3 category headings", () => {
    expect(helpText).toContain("Code Generation:");
    expect(helpText).toContain("Database Operations:");
    expect(helpText).toContain("Inspection & Validation:");
  });

  it("prints global options section", () => {
    expect(helpText).toContain("Global Options:");
    expect(helpText).toContain("--db=<name>");
    expect(helpText).toContain("--remote");
  });
});

// ─── File generation ───────────────────────────────────────────────────────

describe("file generation commands", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "d1-eloquent-cli-"));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("make:model generates a valid model file", () => {
    run("make:model Article", tempDir);

    const modelPath = join(tempDir, "src/app/models/Article.ts");
    expect(existsSync(modelPath)).toBe(true);

    const content = readFileSync(modelPath, "utf-8");
    expect(content).toContain("export class Article extends BaseModel");
    expect(content).toContain('public static table = "articles"');
    expect(content).toContain("export type TArticleAttrs");
  });

  it("make:migration generates a timestamped migration file", () => {
    run("make:migration create_articles", tempDir);

    const migrationsDir = join(tempDir, "src/database/migrations");
    expect(existsSync(migrationsDir)).toBe(true);

    // Find the generated file (has a timestamp prefix)
    const { readdirSync } = require("node:fs");
    const files: string[] = readdirSync(migrationsDir);
    const migrationFile = files.find(
      (f: string) => f.endsWith(".ts") && f.includes("create_articles"),
    );
    expect(migrationFile).toBeDefined();

    // Verify timestamp prefix format (YYYYMMDDHHMMSS)
    expect(migrationFile).toMatch(/^\d{14}_create_articles\.ts$/);

    const content = readFileSync(
      join(migrationsDir, migrationFile!),
      "utf-8",
    );
    expect(content).toContain("TMigration");
    expect(content).toContain("Schema");
    expect(content).toContain("up:");
    expect(content).toContain("down:");
  });

  it("make:factory generates a factory class file", () => {
    run("make:factory Article", tempDir);

    const factoryPath = join(tempDir, "src/database/factories/ArticleFactory.ts");
    expect(existsSync(factoryPath)).toBe(true);

    const content = readFileSync(factoryPath, "utf-8");
    expect(content).toContain("export class ArticleFactory extends Factory");
    expect(content).toContain('public readonly table = "articles"');
    expect(content).toContain("definition()");
  });

  it("make:seeder generates a seeder file", () => {
    run("make:seeder Article", tempDir);

    const seederPath = join(tempDir, "src/database/seeders/ArticleSeeder.ts");
    expect(existsSync(seederPath)).toBe(true);

    const content = readFileSync(seederPath, "utf-8");
    expect(content).toContain('name: "ArticleSeeder"');
    expect(content).toContain("TSeeder");
    expect(content).toContain("run:");
  });
});

// ─── Error handling ────────────────────────────────────────────────────────

describe("unknown command", () => {
  it("prints error for unknown command", () => {
    let output = "";
    try {
      execSync(`npx tsx ${CLI} nonexistent-command`, {
        encoding: "utf-8",
        timeout: 30_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err: unknown) {
      const e = err as { stderr?: string; stdout?: string };
      output = (e.stderr ?? "") + (e.stdout ?? "");
    }

    expect(output).toContain("Unknown command: nonexistent-command");
  });
});
