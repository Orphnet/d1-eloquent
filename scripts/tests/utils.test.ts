import { describe, it, expect } from "vitest";
import { toClassName, toSnakePlural, toPascalCase, formatMigrationName, resolveOutputDir } from "../utils";

describe("toClassName", () => {
  it("converts snake_case", () => {
    expect(toClassName("blog_post")).toBe("BlogPost");
  });

  it("converts kebab-case", () => {
    expect(toClassName("blog-post")).toBe("BlogPost");
  });

  it("converts space-separated", () => {
    expect(toClassName("blog post")).toBe("BlogPost");
  });

  it("preserves already PascalCase", () => {
    expect(toClassName("BlogPost")).toBe("BlogPost");
  });

  it("handles single word", () => {
    expect(toClassName("user")).toBe("User");
  });
});

describe("toSnakePlural", () => {
  it("converts PascalCase to snake_plural", () => {
    expect(toSnakePlural("BlogPost")).toBe("blog_posts");
  });

  it("does not double-pluralize", () => {
    expect(toSnakePlural("BlogPosts")).toBe("blog_posts");
  });

  it("handles single word", () => {
    expect(toSnakePlural("User")).toBe("users");
  });
});

describe("toPascalCase", () => {
  it("strips create_ prefix and converts", () => {
    expect(toPascalCase("create_blog_posts")).toBe("BlogPosts");
  });

  it("strips alter_ prefix and converts", () => {
    expect(toPascalCase("alter_users")).toBe("Users");
  });

  it("converts plain snake_case", () => {
    expect(toPascalCase("blog_posts")).toBe("BlogPosts");
  });
});

describe("formatMigrationName", () => {
  it("normalizes to snake_case", () => {
    expect(formatMigrationName("Create Blog Posts")).toBe("create_blog_posts");
  });

  it("strips special characters", () => {
    expect(formatMigrationName("add-user@table!")).toBe("add_user_table");
  });

  it("collapses multiple underscores", () => {
    expect(formatMigrationName("create___users")).toBe("create_users");
  });

  it("trims leading/trailing underscores", () => {
    expect(formatMigrationName("_create_users_")).toBe("create_users");
  });
});

describe("resolveOutputDir", () => {
  it("returns flag value when provided", () => {
    const result = resolveOutputDir("/custom/path", "default/path");
    expect(result).toContain("custom/path");
  });

  it("returns default when flag is undefined", () => {
    const result = resolveOutputDir(undefined, "src/types/generated");
    expect(result).toContain("src/types/generated");
  });
});
