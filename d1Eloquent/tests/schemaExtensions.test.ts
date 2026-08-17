// schemaExtensions.test.ts
// Pure-SQL unit tests for the new Schema builder surface: json/blob columns,
// virtual tables, FTS5, generated columns, partial indexes, views, triggers,
// STRICT / WITHOUT ROWID, drop/rename column.

import { describe, it, expect } from "vitest";
import { Schema, ColumnBuilder, VirtualTableBuilder } from "../../scripts/schema";

describe("Schema — JSON columns", () => {
    it("t.json() generates a TEXT column with no extra constraint", () => {
        const schema = new Schema();
        schema.createTable("docs", (t) => {
            t.id();
            t.json("payload");
        });
        const sql = schema.toSql();
        expect(sql).toContain("payload TEXT");
        expect(sql).not.toContain("CHECK");
    });

    it("t.json({ validate: true }) emits json_valid CHECK with NULL allowance", () => {
        const schema = new Schema();
        schema.createTable("docs", (t) => {
            t.id();
            t.json("payload", { validate: true });
        });
        const sql = schema.toSql();
        expect(sql).toContain("CHECK (payload IS NULL OR json_valid(payload))");
    });

    it("t.json({ validate: true, nullable: false }) omits NULL allowance", () => {
        const schema = new Schema();
        schema.createTable("docs", (t) => {
            t.id();
            t.json("payload", { validate: true, nullable: false });
        });
        const sql = schema.toSql();
        expect(sql).toContain("payload TEXT NOT NULL CHECK (json_valid(payload))");
    });

    it("t.json() returns a ColumnBuilder for chaining", () => {
        const schema = new Schema();
        schema.createTable("t", (t) => {
            const col = t.json("data");
            expect(col).toBeInstanceOf(ColumnBuilder);
        });
    });

    it("addJson() adds JSON column via ALTER TABLE", () => {
        const schema = new Schema();
        schema.table("docs", (t) => {
            t.addJson("metadata", { validate: true });
        });
        const sql = schema.toSql();
        expect(sql).toContain("ALTER TABLE docs ADD COLUMN metadata TEXT");
        expect(sql).toContain("CHECK (metadata IS NULL OR json_valid(metadata))");
    });
});

describe("Schema — BLOB columns", () => {
    it("t.blob() generates a BLOB column", () => {
        const schema = new Schema();
        schema.createTable("files", (t) => {
            t.id();
            t.blob("data");
        });
        expect(schema.toSql()).toContain("data BLOB");
    });

    it("addBlob() adds BLOB column via ALTER TABLE", () => {
        const schema = new Schema();
        schema.table("files", (t) => {
            t.addBlob("preview");
        });
        expect(schema.toSql()).toContain("ALTER TABLE files ADD COLUMN preview BLOB");
    });
});

describe("Schema — generated columns", () => {
    it("default to VIRTUAL mode", () => {
        const schema = new Schema();
        schema.createTable("users", (t) => {
            t.id();
            t.text("first_name");
            t.text("last_name");
            t.text("full_name").generatedAs("first_name || ' ' || last_name");
        });
        expect(schema.toSql()).toContain(
            "full_name TEXT GENERATED ALWAYS AS (first_name || ' ' || last_name) VIRTUAL",
        );
    });

    it("emits STORED for stored mode", () => {
        const schema = new Schema();
        schema.createTable("users", (t) => {
            t.id();
            t.integer("age").generatedAs("strftime('%Y', 'now') - birth_year", "stored");
        });
        expect(schema.toSql()).toContain(
            "GENERATED ALWAYS AS (strftime('%Y', 'now') - birth_year) STORED",
        );
    });

    it("rejects STORED generated columns on ALTER TABLE", () => {
        const schema = new Schema();
        expect(() => {
            schema.table("users", (t) => {
                t.addText("computed").generatedAs("first || last", "stored");
            });
        }).toThrow(/STORED generated columns cannot be added via ALTER TABLE/);
    });

    it("allows VIRTUAL generated columns on ALTER TABLE", () => {
        const schema = new Schema();
        schema.table("users", (t) => {
            t.addText("computed").generatedAs("first || last");
        });
        expect(schema.toSql()).toContain("VIRTUAL");
    });
});

describe("Schema — partial indexes", () => {
    it("column .index().where() emits partial index", () => {
        const schema = new Schema();
        schema.createTable("posts", (t) => {
            t.id();
            t.text("slug").index().where("deleted_at IS NULL");
        });
        const sql = schema.toSql();
        expect(sql).toContain(
            "CREATE INDEX IF NOT EXISTS idx_posts_slug ON posts(slug) WHERE deleted_at IS NULL",
        );
    });

    it("column .unique().where() emits partial unique index", () => {
        const schema = new Schema();
        schema.createTable("users", (t) => {
            t.id();
            t.text("email").unique().where("deleted_at IS NULL");
        });
        const sql = schema.toSql();
        expect(sql).toContain(
            "CREATE UNIQUE INDEX IF NOT EXISTS uidx_users_email ON users(email) WHERE deleted_at IS NULL",
        );
    });

    it("table-level index() accepts where opt for composite partial index", () => {
        const schema = new Schema();
        schema.createTable("posts", (t) => {
            t.id();
            t.text("status");
            t.text("published_at");
            t.index("status, published_at", "idx_pub", { where: "deleted_at IS NULL" });
        });
        const sql = schema.toSql();
        expect(sql).toContain(
            "CREATE INDEX IF NOT EXISTS idx_pub ON posts(status, published_at) WHERE deleted_at IS NULL",
        );
    });

    it(".where() before .index()/.unique() throws", () => {
        const schema = new Schema();
        expect(() =>
            schema.createTable("t", (t) => {
                t.id();
                t.text("name").where("name IS NOT NULL");
            }),
        ).toThrow(/must follow .index\(\) or .unique\(\)/);
    });
});

describe("Schema — virtual tables", () => {
    it("createVirtualTable generates CREATE VIRTUAL TABLE USING <module>(...)", () => {
        const schema = new Schema();
        schema.createVirtualTable("geo_idx", "rtree", (t: VirtualTableBuilder) => {
            t.column("id");
            t.column("minX");
            t.column("maxX");
            t.column("minY");
            t.column("maxY");
        });
        const sql = schema.toSql();
        expect(sql).toContain(
            "CREATE VIRTUAL TABLE IF NOT EXISTS geo_idx USING rtree(id, minX, maxX, minY, maxY);",
        );
    });

    it("options are joined alongside columns", () => {
        const schema = new Schema();
        schema.createVirtualTable("posts_idx", "fts5", (t) => {
            t.column("title");
            t.column("body");
            t.option("tokenize = 'porter unicode61'");
        });
        const sql = schema.toSql();
        expect(sql).toContain(
            "CREATE VIRTUAL TABLE IF NOT EXISTS posts_idx USING fts5(title, body, tokenize = 'porter unicode61');",
        );
    });
});

describe("Schema — createFts5Table convenience", () => {
    it("emits FTS5 virtual table with simple columns", () => {
        const schema = new Schema();
        schema.createFts5Table("posts_idx", { columns: ["title", "body"] });
        expect(schema.toSql()).toContain(
            "CREATE VIRTUAL TABLE IF NOT EXISTS posts_idx USING fts5(title, body);",
        );
    });

    it("appends tokenize option", () => {
        const schema = new Schema();
        schema.createFts5Table("posts_idx", {
            columns: ["title", "body"],
            tokenize: "porter unicode61",
        });
        expect(schema.toSql()).toContain("tokenize = 'porter unicode61'");
    });

    it("supports external content tables and content_rowid", () => {
        const schema = new Schema();
        schema.createFts5Table("posts_idx", {
            columns: ["title", "body"],
            content: "posts",
            contentRowid: "rowid",
        });
        const sql = schema.toSql();
        expect(sql).toContain("content = 'posts'");
        expect(sql).toContain("content_rowid = 'rowid'");
    });

    it("emits UNINDEXED for excluded columns", () => {
        const schema = new Schema();
        schema.createFts5Table("posts_idx", {
            columns: ["title", "body", "source"],
            unindexed: ["source"],
        });
        const sql = schema.toSql();
        expect(sql).toContain("USING fts5(title, body, source UNINDEXED)");
    });

    it("emits prefix index option", () => {
        const schema = new Schema();
        schema.createFts5Table("posts_idx", {
            columns: ["title"],
            prefix: [2, 3],
        });
        expect(schema.toSql()).toContain("prefix = '2 3'");
    });

    it("contentSyncTriggers requires content table — throws otherwise", () => {
        const schema = new Schema();
        expect(() =>
            schema.createFts5Table("posts_idx", {
                columns: ["title"],
                contentSyncTriggers: true,
            }),
        ).toThrow(/contentSyncTriggers requires a non-empty 'content' table/);
    });

    it("contentSyncTriggers emits ai/ad/au triggers", () => {
        const schema = new Schema();
        schema.createFts5Table("posts_idx", {
            columns: ["title", "body"],
            content: "posts",
            contentSyncTriggers: true,
        });
        const sql = schema.toSql();
        expect(sql).toContain("CREATE TRIGGER IF NOT EXISTS posts_idx_ai AFTER INSERT ON posts");
        expect(sql).toContain("CREATE TRIGGER IF NOT EXISTS posts_idx_ad AFTER DELETE ON posts");
        expect(sql).toContain("CREATE TRIGGER IF NOT EXISTS posts_idx_au AFTER UPDATE ON posts");
        expect(sql).toContain("INSERT INTO posts_idx(rowid, title, body) VALUES (new.rowid");
    });

    it("rejects empty columns array", () => {
        const schema = new Schema();
        expect(() => schema.createFts5Table("posts_idx", { columns: [] })).toThrow(
            /at least one column is required/,
        );
    });

    it("rejects prefix array that contains only non-finite values", () => {
        const schema = new Schema();
        expect(() =>
            schema.createFts5Table("posts_idx", {
                columns: ["title"],
                prefix: [NaN, Number.POSITIVE_INFINITY],
            }),
        ).toThrow(/must contain at least one finite integer/);
    });

    it("silently drops non-finite values when at least one valid prefix remains", () => {
        const schema = new Schema();
        schema.createFts5Table("posts_idx", {
            columns: ["title"],
            prefix: [NaN, 3, Number.POSITIVE_INFINITY],
        });
        expect(schema.toSql()).toContain("prefix = '3'");
    });
});

describe("Schema — views", () => {
    it("createView emits CREATE VIEW IF NOT EXISTS", () => {
        const schema = new Schema();
        schema.createView("active_users", "SELECT * FROM users WHERE deleted_at IS NULL");
        expect(schema.toSql()).toBe(
            "CREATE VIEW IF NOT EXISTS active_users AS SELECT * FROM users WHERE deleted_at IS NULL;",
        );
    });

    it("dropView emits DROP VIEW IF EXISTS", () => {
        const schema = new Schema();
        schema.dropView("active_users");
        expect(schema.toSql()).toBe("DROP VIEW IF EXISTS active_users;");
    });

    it("strips trailing semicolon from view body", () => {
        const schema = new Schema();
        schema.createView("v", "SELECT 1;");
        expect(schema.toSql()).toBe("CREATE VIEW IF NOT EXISTS v AS SELECT 1;");
    });
});

describe("Schema — indexes", () => {
    it("createIndex standalone with where clause", () => {
        const schema = new Schema();
        schema.createIndex("idx_users_email_active", "users", "email", {
            where: "deleted_at IS NULL",
        });
        expect(schema.toSql()).toBe(
            "CREATE INDEX IF NOT EXISTS idx_users_email_active ON users(email) WHERE deleted_at IS NULL;",
        );
    });

    it("createIndex with unique and composite columns", () => {
        const schema = new Schema();
        schema.createIndex("uidx_a_b", "t", ["a", "b"], { unique: true });
        expect(schema.toSql()).toContain("CREATE UNIQUE INDEX IF NOT EXISTS uidx_a_b ON t(a, b)");
    });

    it("dropIndex emits DROP INDEX IF EXISTS", () => {
        const schema = new Schema();
        schema.dropIndex("idx_users_email");
        expect(schema.toSql()).toBe("DROP INDEX IF EXISTS idx_users_email;");
    });
});

describe("Schema — triggers", () => {
    it("createTrigger emits AFTER UPDATE FOR EACH ROW by default", () => {
        const schema = new Schema();
        schema.createTrigger("audit_users", {
            timing: "AFTER",
            event: "UPDATE",
            on: "users",
            body: "INSERT INTO audit_log(table_name, row_id) VALUES ('users', new.id);",
        });
        expect(schema.toSql()).toContain(
            "CREATE TRIGGER IF NOT EXISTS audit_users AFTER UPDATE ON users FOR EACH ROW BEGIN INSERT INTO audit_log",
        );
    });

    it("supports WHEN clause", () => {
        const schema = new Schema();
        schema.createTrigger("audit_users", {
            timing: "AFTER",
            event: "UPDATE",
            on: "users",
            when: "new.role != old.role",
            body: "INSERT INTO audit_log DEFAULT VALUES;",
        });
        expect(schema.toSql()).toContain("WHEN new.role != old.role BEGIN");
    });

    it("dropTrigger emits DROP TRIGGER IF EXISTS", () => {
        const schema = new Schema();
        schema.dropTrigger("audit_users");
        expect(schema.toSql()).toBe("DROP TRIGGER IF EXISTS audit_users;");
    });
});

describe("Schema — createTable options", () => {
    it("supports STRICT modifier", () => {
        const schema = new Schema();
        schema.createTable("users", (t) => t.id(), { strict: true });
        expect(schema.toSql()).toContain(") STRICT;");
    });

    it("supports WITHOUT ROWID modifier", () => {
        const schema = new Schema();
        schema.createTable("kv", (t) => {
            t.text("key").primary();
            t.text("value");
        }, { withoutRowid: true });
        expect(schema.toSql()).toContain(") WITHOUT ROWID;");
    });

    it("combines STRICT and WITHOUT ROWID", () => {
        const schema = new Schema();
        schema.createTable("kv", (t) => {
            t.text("key").primary();
        }, { strict: true, withoutRowid: true });
        expect(schema.toSql()).toContain(") WITHOUT ROWID, STRICT;");
    });

    it("opts.ifNotExists: false omits IF NOT EXISTS", () => {
        const schema = new Schema();
        schema.createTable("users", (t) => t.id(), { ifNotExists: false });
        const sql = schema.toSql();
        expect(sql.startsWith("CREATE TABLE users")).toBe(true);
        expect(sql).not.toContain("IF NOT EXISTS");
    });
});

describe("Schema — rename and drop column", () => {
    it("renameTable emits ALTER TABLE RENAME TO", () => {
        const schema = new Schema();
        schema.renameTable("users", "people");
        expect(schema.toSql()).toBe("ALTER TABLE users RENAME TO people;");
    });

    it("dropColumn (alter mode) emits ALTER TABLE DROP COLUMN", () => {
        const schema = new Schema();
        schema.table("users", (t) => {
            t.dropColumn("legacy_field");
        });
        expect(schema.toSql()).toBe("ALTER TABLE users DROP COLUMN legacy_field;");
    });

    it("renameColumn (alter mode) emits ALTER TABLE RENAME COLUMN", () => {
        const schema = new Schema();
        schema.table("users", (t) => {
            t.renameColumn("nick", "username");
        });
        expect(schema.toSql()).toBe("ALTER TABLE users RENAME COLUMN nick TO username;");
    });

    it("dropColumn in create mode throws", () => {
        const schema = new Schema();
        expect(() =>
            schema.createTable("users", (t) => {
                t.id();
                t.dropColumn("foo");
            }),
        ).toThrow(/only available in alter mode/);
    });

    it("dropSoftDeletes in alter mode emits DROP COLUMN deleted_at", () => {
        const schema = new Schema();
        schema.table("posts", (t) => {
            t.dropSoftDeletes();
        });
        expect(schema.toSql()).toContain("ALTER TABLE posts DROP COLUMN deleted_at;");
    });
});

describe("Schema — column collation and defaultRaw", () => {
    it(".collate('NOCASE') emits COLLATE NOCASE", () => {
        const schema = new Schema();
        schema.createTable("users", (t) => {
            t.id();
            t.text("email").collate("NOCASE");
        });
        expect(schema.toSql()).toContain("email TEXT COLLATE NOCASE");
    });

    it(".defaultRaw() emits unquoted expression", () => {
        const schema = new Schema();
        schema.createTable("posts", (t) => {
            t.id();
            t.text("created_at").defaultRaw("(datetime('now'))");
        });
        expect(schema.toSql()).toContain("DEFAULT (datetime('now'))");
    });

    it("timestamps({ useCurrentTimestamp: true }) sets DEFAULT (datetime('now'))", () => {
        const schema = new Schema();
        schema.createTable("posts", (t) => {
            t.id();
            t.timestamps({ useCurrentTimestamp: true });
        });
        const sql = schema.toSql();
        expect(sql).toContain("created_at TEXT NOT NULL DEFAULT (datetime('now'))");
        expect(sql).toContain("updated_at TEXT NOT NULL DEFAULT (datetime('now'))");
    });
});

describe("Schema — table-level foreign keys", () => {
    it("t.foreign() emits standalone FOREIGN KEY constraint", () => {
        const schema = new Schema();
        schema.createTable("comments", (t) => {
            t.id();
            t.text("post_id");
            t.foreign("post_id", { references: "posts", onDelete: "cascade" });
        });
        const sql = schema.toSql();
        expect(sql).toContain(
            "FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE ON UPDATE RESTRICT",
        );
    });

    it("t.foreign() supports composite key references", () => {
        const schema = new Schema();
        schema.createTable("pivot", (t) => {
            t.text("tenant_id");
            t.text("user_id");
            t.foreign("tenant_id, user_id", {
                references: "memberships",
                on: ["tenant_id", "user_id"],
            });
        });
        const sql = schema.toSql();
        expect(sql).toContain(
            "FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id)",
        );
    });

    it("t.foreign() accepts local columns as a string[]", () => {
        const schema = new Schema();
        schema.createTable("pivot_arr", (t) => {
            t.text("tenant_id");
            t.text("user_id");
            t.foreign(["tenant_id", "user_id"], {
                references: "memberships",
                on: ["tenant_id", "user_id"],
            });
        });
        expect(schema.toSql()).toContain(
            "FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id)",
        );
    });

    it("t.foreign() normalizes comma-strings without spaces on both sides", () => {
        const schema = new Schema();
        schema.createTable("pivot_norm", (t) => {
            t.text("tenant_id");
            t.text("user_id");
            t.foreign("tenant_id,user_id", {
                references: "memberships",
                on: "tenant_id,user_id",
            });
        });
        // canonical spaced form, never the verbatim "(tenant_id,user_id)"
        expect(schema.toSql()).toContain(
            "FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id)",
        );
    });

    it("t.foreign() lets local and referenced sides mix array and comma-string", () => {
        const schema = new Schema();
        schema.createTable("pivot_mix", (t) => {
            t.text("a");
            t.text("b");
            t.foreign(["a", "b"], { references: "r", on: "x, y" });
        });
        expect(schema.toSql()).toContain("FOREIGN KEY (a, b) REFERENCES r(x, y)");
    });

    it("t.foreign() trims whitespace and drops empty segments", () => {
        const schema = new Schema();
        schema.createTable("pivot_hygiene", (t) => {
            t.text("a");
            t.text("b");
            t.foreign(" a ,, b ", { references: "r", on: [" x ", ""] });
        });
        expect(schema.toSql()).toContain("FOREIGN KEY (a, b) REFERENCES r(x)");
    });

    it("t.foreign() preserves the default referenced column (id)", () => {
        const schema = new Schema();
        schema.createTable("pivot_default", (t) => {
            t.text("post_id");
            t.foreign("post_id", { references: "posts" });
        });
        expect(schema.toSql()).toContain(
            "FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE RESTRICT ON UPDATE RESTRICT",
        );
    });
});
