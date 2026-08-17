// schema.test.ts
// Schema builder SQL generation tests (pure unit — no D1 needed)

import { describe, it, expect } from "vitest";
import { Schema, ColumnBuilder, AlterColumnBuilder } from "../../scripts/schema";

describe("Schema.createTable", () => {
    it("generates CREATE TABLE IF NOT EXISTS statement", () => {
        const schema = new Schema();
        schema.createTable("users", (t) => {
            t.id();
        });
        expect(schema.toSql()).toContain("CREATE TABLE IF NOT EXISTS users");
    });

    it("id() generates 'id TEXT PRIMARY KEY'", () => {
        const schema = new Schema();
        schema.createTable("users", (t) => {
            t.id();
        });
        expect(schema.toSql()).toContain("id TEXT PRIMARY KEY");
    });

    it("text(col, { nullable: false }) generates 'col TEXT NOT NULL'", () => {
        const schema = new Schema();
        schema.createTable("users", (t) => {
            t.id();
            t.text("email", { nullable: false });
        });
        expect(schema.toSql()).toContain("email TEXT NOT NULL");
    });

    it("text(col) without options is nullable by default", () => {
        const schema = new Schema();
        schema.createTable("items", (t) => {
            t.id();
            t.text("description");
        });
        const sql = schema.toSql();
        expect(sql).toContain("description TEXT");
        expect(sql).not.toContain("description TEXT NOT NULL");
    });

    it("integer(col) generates INTEGER column", () => {
        const schema = new Schema();
        schema.createTable("items", (t) => {
            t.id();
            t.integer("count");
        });
        expect(schema.toSql()).toContain("count INTEGER");
    });

    it("text(col, { default: 'val' }) generates DEFAULT clause", () => {
        const schema = new Schema();
        schema.createTable("settings", (t) => {
            t.id();
            t.text("status", { default: "active" });
        });
        expect(schema.toSql()).toContain("DEFAULT 'active'");
    });

    it("integer(col, { default: 0 }) generates DEFAULT 0", () => {
        const schema = new Schema();
        schema.createTable("counters", (t) => {
            t.id();
            t.integer("hits", { default: 0 });
        });
        expect(schema.toSql()).toContain("DEFAULT 0");
    });

    it("timestamps() adds created_at and updated_at TEXT columns", () => {
        const schema = new Schema();
        schema.createTable("posts", (t) => {
            t.id();
            t.timestamps();
        });
        const sql = schema.toSql();
        expect(sql).toContain("created_at TEXT");
        expect(sql).toContain("updated_at TEXT");
    });

    it("softDeletes() adds deleted_at TEXT column", () => {
        const schema = new Schema();
        schema.createTable("posts", (t) => {
            t.id();
            t.softDeletes();
        });
        const sql = schema.toSql();
        expect(sql).toContain("deleted_at TEXT");
    });
});

describe("Schema.table (ALTER TABLE)", () => {
    it("addText(col) generates ALTER TABLE ADD COLUMN TEXT", () => {
        const schema = new Schema();
        schema.table("users", (t) => {
            t.addText("bio");
        });
        const sql = schema.toSql();
        expect(sql).toContain("ALTER TABLE users ADD COLUMN bio TEXT");
    });

    it("addInteger(col) generates ALTER TABLE ADD COLUMN INTEGER", () => {
        const schema = new Schema();
        schema.table("users", (t) => {
            t.addInteger("age");
        });
        expect(schema.toSql()).toContain("ALTER TABLE users ADD COLUMN age INTEGER");
    });

    it("addText(col, { nullable: false }) includes NOT NULL", () => {
        const schema = new Schema();
        schema.table("users", (t) => {
            t.addText("required_field", { nullable: false });
        });
        expect(schema.toSql()).toContain("NOT NULL");
    });

    it("addText(col, { default: 'val' }) includes DEFAULT", () => {
        const schema = new Schema();
        schema.table("users", (t) => {
            t.addText("status", { default: "pending" });
        });
        expect(schema.toSql()).toContain("DEFAULT 'pending'");
    });
});

describe("Schema.dropTable", () => {
    it("generates DROP TABLE IF EXISTS statement", () => {
        const schema = new Schema();
        schema.dropTable("old_table");
        expect(schema.toSql()).toBe("DROP TABLE IF EXISTS old_table;");
    });

    it("dropTable statement contains the table name", () => {
        const schema = new Schema();
        schema.dropTable("legacy_data");
        expect(schema.toSql()).toContain("legacy_data");
    });
});

describe("Schema index creation", () => {
    it("unique(col) generates CREATE UNIQUE INDEX with standard naming", () => {
        const schema = new Schema();
        schema.createTable("users", (t) => {
            t.id();
            t.text("email");
            t.unique("email");
        });
        const sql = schema.toSql();
        expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS uidx_users_email ON users(email)");
    });

    it("index(col) generates CREATE INDEX with standard naming", () => {
        const schema = new Schema();
        schema.createTable("posts", (t) => {
            t.id();
            t.text("slug");
            t.index("slug");
        });
        const sql = schema.toSql();
        expect(sql).toContain("CREATE INDEX IF NOT EXISTS idx_posts_slug ON posts(slug)");
    });

    it("softDeletes() adds an index on deleted_at by default", () => {
        const schema = new Schema();
        schema.createTable("posts", (t) => {
            t.id();
            t.softDeletes();
        });
        const sql = schema.toSql();
        expect(sql).toContain("CREATE INDEX IF NOT EXISTS idx_posts_deleted_at ON posts(deleted_at)");
    });
});

describe("Schema.toStatements", () => {
    it("toStatements() returns an array of statements", () => {
        const schema = new Schema();
        schema.createTable("a", (t) => { t.id(); });
        schema.dropTable("b");
        const stmts = schema.toStatements();
        expect(Array.isArray(stmts)).toBe(true);
        expect(stmts.length).toBe(2);
    });

    it("each statement in toStatements() ends with a semicolon", () => {
        const schema = new Schema();
        schema.dropTable("test");
        const stmts = schema.toStatements();
        for (const stmt of stmts) {
            expect(stmt.trim()).toMatch(/;$/);
        }
    });

    it("createTable with an index produces 2 statements (CREATE TABLE + CREATE INDEX)", () => {
        const schema = new Schema();
        schema.createTable("items", (t) => {
            t.id();
            t.text("slug");
            t.index("slug");
        });
        const stmts = schema.toStatements();
        // CREATE TABLE + CREATE INDEX = 2
        expect(stmts.length).toBe(2);
        expect(stmts[0]).toContain("CREATE TABLE");
        expect(stmts[1]).toContain("CREATE INDEX");
    });

    it("toSql() returns all statements joined by newline", () => {
        const schema = new Schema();
        schema.dropTable("x");
        schema.dropTable("y");
        const sql = schema.toSql();
        expect(sql).toContain("DROP TABLE IF EXISTS x");
        expect(sql).toContain("DROP TABLE IF EXISTS y");
    });
});

// ---------------------------------------------------------------------------
// Chainable column builder API
// ---------------------------------------------------------------------------

describe("Chainable column builder — create mode", () => {
    it("text().nullable() generates nullable column", () => {
        const schema = new Schema();
        schema.createTable("posts", (t) => {
            t.id();
            t.text("body").nullable();
        });
        const sql = schema.toSql();
        expect(sql).toContain("body TEXT");
        expect(sql).not.toContain("body TEXT NOT NULL");
    });

    it("text().notNull() generates NOT NULL column", () => {
        const schema = new Schema();
        schema.createTable("posts", (t) => {
            t.id();
            t.text("title").notNull();
        });
        expect(schema.toSql()).toContain("title TEXT NOT NULL");
    });

    it("text().default() generates DEFAULT clause", () => {
        const schema = new Schema();
        schema.createTable("posts", (t) => {
            t.id();
            t.text("status").default("draft");
        });
        expect(schema.toSql()).toContain("status TEXT DEFAULT 'draft'");
    });

    it("integer().default() generates DEFAULT clause", () => {
        const schema = new Schema();
        schema.createTable("posts", (t) => {
            t.id();
            t.integer("views").default(0);
        });
        expect(schema.toSql()).toContain("views INTEGER DEFAULT 0");
    });

    it("boolean().default(true) generates DEFAULT 1", () => {
        const schema = new Schema();
        schema.createTable("posts", (t) => {
            t.id();
            t.boolean("is_active").default(true);
        });
        expect(schema.toSql()).toContain("is_active INTEGER DEFAULT 1");
    });

    it("boolean().default(false) generates DEFAULT 0", () => {
        const schema = new Schema();
        schema.createTable("posts", (t) => {
            t.id();
            t.boolean("is_draft").default(false);
        });
        expect(schema.toSql()).toContain("is_draft INTEGER DEFAULT 0");
    });

    it("text().unique() generates a UNIQUE INDEX", () => {
        const schema = new Schema();
        schema.createTable("users", (t) => {
            t.id();
            t.text("email").unique();
        });
        const sql = schema.toSql();
        expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS uidx_users_email ON users(email)");
    });

    it("text().unique(customName) uses custom index name", () => {
        const schema = new Schema();
        schema.createTable("users", (t) => {
            t.id();
            t.text("email").unique("my_idx");
        });
        expect(schema.toSql()).toContain("CREATE UNIQUE INDEX IF NOT EXISTS my_idx ON users(email)");
    });

    it("text().index() generates a regular INDEX", () => {
        const schema = new Schema();
        schema.createTable("posts", (t) => {
            t.id();
            t.text("user_id").index();
        });
        expect(schema.toSql()).toContain("CREATE INDEX IF NOT EXISTS idx_posts_user_id ON posts(user_id)");
    });

    it("text().primary() generates PRIMARY KEY column", () => {
        const schema = new Schema();
        schema.createTable("settings", (t) => {
            t.text("key").primary();
            t.text("value");
        });
        const sql = schema.toSql();
        expect(sql).toContain("key TEXT PRIMARY KEY NOT NULL");
    });

    it("integer().check() generates inline CHECK constraint", () => {
        const schema = new Schema();
        schema.createTable("users", (t) => {
            t.id();
            t.integer("age").check("age >= 0");
        });
        expect(schema.toSql()).toContain("age INTEGER CHECK (age >= 0)");
    });

    it("real().nullable(false).default() chains multiple modifiers", () => {
        const schema = new Schema();
        schema.createTable("products", (t) => {
            t.id();
            t.real("price").nullable(false).default(0.0);
        });
        expect(schema.toSql()).toContain("price REAL NOT NULL DEFAULT 0");
    });

    it("returns ColumnBuilder from text()", () => {
        const schema = new Schema();
        schema.createTable("t", (t) => {
            const col = t.text("name");
            expect(col).toBeInstanceOf(ColumnBuilder);
        });
    });
});

describe("Chainable column builder — last-wins semantics", () => {
    it("chain overrides options object", () => {
        const schema = new Schema();
        schema.createTable("t", (t) => {
            t.id();
            t.text("name", { nullable: true }).nullable(false);
        });
        expect(schema.toSql()).toContain("name TEXT NOT NULL");
    });

    it("later chain overrides earlier chain", () => {
        const schema = new Schema();
        schema.createTable("t", (t) => {
            t.id();
            t.text("name").nullable(false).nullable(true);
        });
        const sql = schema.toSql();
        expect(sql).toContain("name TEXT");
        expect(sql).not.toContain("name TEXT NOT NULL");
    });

    it("chain default overrides options default", () => {
        const schema = new Schema();
        schema.createTable("t", (t) => {
            t.id();
            t.text("status", { default: "old" }).default("new");
        });
        const sql = schema.toSql();
        expect(sql).toContain("DEFAULT 'new'");
        expect(sql).not.toContain("DEFAULT 'old'");
    });
});

describe("Chainable column builder — foreign keys", () => {
    it("references() generates FOREIGN KEY clause", () => {
        const schema = new Schema();
        schema.createTable("posts", (t) => {
            t.id();
            t.text("user_id").references("users", "id");
        });
        const sql = schema.toSql();
        expect(sql).toContain("FOREIGN KEY (user_id) REFERENCES users(id)");
        expect(sql).toContain("ON DELETE RESTRICT");
        expect(sql).toContain("ON UPDATE RESTRICT");
    });

    it("references() defaults column to 'id'", () => {
        const schema = new Schema();
        schema.createTable("posts", (t) => {
            t.id();
            t.text("user_id").references("users");
        });
        expect(schema.toSql()).toContain("FOREIGN KEY (user_id) REFERENCES users(id)");
    });

    it("constrained() is sugar for references(table, 'id')", () => {
        const schema = new Schema();
        schema.createTable("posts", (t) => {
            t.id();
            t.text("user_id").constrained("users");
        });
        expect(schema.toSql()).toContain("FOREIGN KEY (user_id) REFERENCES users(id)");
    });

    it("onDelete('cascade') overrides default RESTRICT", () => {
        const schema = new Schema();
        schema.createTable("posts", (t) => {
            t.id();
            t.text("user_id").references("users").onDelete("cascade");
        });
        const sql = schema.toSql();
        expect(sql).toContain("ON DELETE CASCADE");
        expect(sql).toContain("ON UPDATE RESTRICT");
    });

    it("onUpdate('set null') overrides default RESTRICT", () => {
        const schema = new Schema();
        schema.createTable("posts", (t) => {
            t.id();
            t.text("user_id").constrained("users").onUpdate("set null");
        });
        const sql = schema.toSql();
        expect(sql).toContain("ON DELETE RESTRICT");
        expect(sql).toContain("ON UPDATE SET NULL");
    });

    it("full FK chain with onDelete and onUpdate", () => {
        const schema = new Schema();
        schema.createTable("comments", (t) => {
            t.id();
            t.text("post_id").references("posts", "id").onDelete("cascade").onUpdate("cascade");
        });
        const sql = schema.toSql();
        expect(sql).toContain("FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE ON UPDATE CASCADE");
    });

    it("FK clause appears after column definitions", () => {
        const schema = new Schema();
        schema.createTable("posts", (t) => {
            t.id();
            t.text("user_id").constrained("users").onDelete("cascade");
            t.text("title").notNull();
        });
        const sql = schema.toSql();
        const colIdx = sql.indexOf("user_id TEXT");
        const titleIdx = sql.indexOf("title TEXT NOT NULL");
        const fkIdx = sql.indexOf("FOREIGN KEY");
        expect(colIdx).toBeLessThan(titleIdx);
        expect(titleIdx).toBeLessThan(fkIdx);
    });

    it("multiple FK columns generate multiple FOREIGN KEY clauses", () => {
        const schema = new Schema();
        schema.createTable("comments", (t) => {
            t.id();
            t.text("user_id").constrained("users").onDelete("cascade");
            t.text("post_id").constrained("posts").onDelete("cascade");
        });
        const sql = schema.toSql();
        expect(sql).toContain("FOREIGN KEY (user_id) REFERENCES users(id)");
        expect(sql).toContain("FOREIGN KEY (post_id) REFERENCES posts(id)");
    });

    it("references with custom column name", () => {
        const schema = new Schema();
        schema.createTable("profiles", (t) => {
            t.id();
            t.text("user_email").references("users", "email").onDelete("cascade");
        });
        expect(schema.toSql()).toContain("FOREIGN KEY (user_email) REFERENCES users(email)");
    });

    it("references() accepts the referenced column as a string[]", () => {
        const schema = new Schema();
        schema.createTable("profiles", (t) => {
            t.id();
            t.text("user_email").references("users", ["email"]);
        });
        expect(schema.toSql()).toContain("FOREIGN KEY (user_email) REFERENCES users(email)");
    });

    it("references() accepts a composite referenced key as an array", () => {
        const schema = new Schema();
        schema.createTable("memberships_fk", (t) => {
            t.id();
            t.text("membership_ref").references("memberships", ["tenant_id", "user_id"]);
        });
        expect(schema.toSql()).toContain(
            "FOREIGN KEY (membership_ref) REFERENCES memberships(tenant_id, user_id)",
        );
    });

    it("references() normalizes a comma-separated referenced key (not verbatim)", () => {
        const schema = new Schema();
        schema.createTable("memberships_fk2", (t) => {
            t.id();
            t.text("membership_ref").references("memberships", "tenant_id,user_id");
        });
        // comma-string is canonicalized to spaced form, not emitted verbatim
        expect(schema.toSql()).toContain(
            "FOREIGN KEY (membership_ref) REFERENCES memberships(tenant_id, user_id)",
        );
    });
});

describe("Chainable column builder — alter mode", () => {
    it("addText().nullable(false) generates ALTER with NOT NULL", () => {
        const schema = new Schema();
        schema.table("users", (t) => {
            t.addText("bio").nullable(false);
        });
        expect(schema.toSql()).toContain("ALTER TABLE users ADD COLUMN bio TEXT NOT NULL");
    });

    it("addInteger().default() generates ALTER with DEFAULT", () => {
        const schema = new Schema();
        schema.table("posts", (t) => {
            t.addInteger("view_count").notNull().default(0);
        });
        expect(schema.toSql()).toContain("ALTER TABLE posts ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0");
    });

    it("addText().unique() generates ALTER + CREATE UNIQUE INDEX", () => {
        const schema = new Schema();
        schema.table("users", (t) => {
            t.addText("slug").unique();
        });
        const stmts = schema.toStatements();
        expect(stmts.length).toBe(2);
        expect(stmts[0]).toContain("ALTER TABLE users ADD COLUMN slug TEXT");
        expect(stmts[1]).toContain("CREATE UNIQUE INDEX IF NOT EXISTS uidx_users_slug ON users(slug)");
    });

    it("addReal().index() generates ALTER + CREATE INDEX", () => {
        const schema = new Schema();
        schema.table("products", (t) => {
            t.addReal("score").index();
        });
        const stmts = schema.toStatements();
        expect(stmts[0]).toContain("ALTER TABLE products ADD COLUMN score REAL");
        expect(stmts[1]).toContain("CREATE INDEX IF NOT EXISTS idx_products_score ON products(score)");
    });

    it("returns AlterColumnBuilder from addText()", () => {
        const schema = new Schema();
        schema.table("t", (t) => {
            const col = t.addText("name");
            expect(col).toBeInstanceOf(AlterColumnBuilder);
        });
    });

    it("AlterColumnBuilder does not have references method", () => {
        const schema = new Schema();
        schema.table("t", (t) => {
            const col = t.addText("fk");
            expect("references" in col).toBe(false);
            expect("constrained" in col).toBe(false);
            expect("onDelete" in col).toBe(false);
            expect("onUpdate" in col).toBe(false);
        });
    });
});

describe("Chainable column builder — mixed options + chain", () => {
    it("options { unique: true } + chain .nullable(false) both apply", () => {
        const schema = new Schema();
        schema.createTable("users", (t) => {
            t.id();
            t.text("email", { unique: true }).nullable(false);
        });
        const sql = schema.toSql();
        expect(sql).toContain("email TEXT NOT NULL");
        expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS uidx_users_email ON users(email)");
    });

    it("options { default: 'a' } + chain .notNull() both apply", () => {
        const schema = new Schema();
        schema.createTable("t", (t) => {
            t.id();
            t.text("status", { default: "active" }).notNull();
        });
        expect(schema.toSql()).toContain("status TEXT NOT NULL DEFAULT 'active'");
    });

    it("full chain: text().notNull().default().unique().index().check()", () => {
        const schema = new Schema();
        schema.createTable("products", (t) => {
            t.id();
            t.text("sku").notNull().default("UNKNOWN").unique().check("length(sku) > 0");
        });
        const sql = schema.toSql();
        expect(sql).toContain("sku TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (length(sku) > 0)");
        expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS uidx_products_sku ON products(sku)");
    });

    it("FK + modifiers: text().notNull().constrained().onDelete()", () => {
        const schema = new Schema();
        schema.createTable("posts", (t) => {
            t.id();
            t.text("user_id").notNull().constrained("users").onDelete("cascade");
        });
        const sql = schema.toSql();
        expect(sql).toContain("user_id TEXT NOT NULL");
        expect(sql).toContain("FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE");
    });

    it("default escapes single quotes", () => {
        const schema = new Schema();
        schema.createTable("t", (t) => {
            t.id();
            t.text("name").default("it's");
        });
        expect(schema.toSql()).toContain("DEFAULT 'it''s'");
    });
});
