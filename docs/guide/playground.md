# Query Playground

Run SELECT queries against a pre-seeded demo database that mirrors the examples used throughout these docs. The playground runs entirely in your browser using sql.js (SQLite compiled to WASM) — no server required.

> [!TIP]
> Only SELECT queries are permitted. INSERT, UPDATE, and DELETE are blocked.

> [!NOTE]
> The interactive in-browser playground runs on the docs site. **[▶ Open the live Query Playground →](https://d1-eloquent.orph.dev/guide/playground)**
>
> The schema and sample queries below mirror what's loaded there, so you can also copy them straight into your own project.

## Available Tables

The demo database is pre-seeded with sample rows across five tables.

```sql
-- users
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TEXT,
  deleted_at TEXT
);
```

```sql
-- posts
CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  created_at TEXT
);
```

```sql
-- tags
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
```

```sql
-- post_tags (pivot)
CREATE TABLE post_tags (
  post_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  PRIMARY KEY (post_id, tag_id)
);
```

```sql
-- model_revisions
CREATE TABLE model_revisions (
  id TEXT PRIMARY KEY,
  model_table TEXT NOT NULL,
  model_id TEXT NOT NULL,
  action TEXT NOT NULL,
  diff TEXT,
  after TEXT,
  actor_id TEXT,
  created_at TEXT
);
```

## Sample Queries

Try these queries to explore the demo data.

All active users (no soft deletes):

```sql
SELECT * FROM users WHERE deleted_at IS NULL
```

Posts with author names:

```sql
SELECT posts.title, users.name AS author
FROM posts
JOIN users ON posts.user_id = users.id
```

Tag post counts (most-used first):

```sql
SELECT tags.name, COUNT(post_tags.post_id) AS post_count
FROM tags
LEFT JOIN post_tags ON tags.id = post_tags.tag_id
GROUP BY tags.id
ORDER BY post_count DESC
```

All revision entries (most recent first):

```sql
SELECT * FROM model_revisions ORDER BY created_at DESC
```

Posts by a specific user:

```sql
SELECT * FROM posts WHERE user_id = 'u1'
```
