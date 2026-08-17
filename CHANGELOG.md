# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0-beta.1] - 2026-08-17

Initial public beta. Developed and battle-tested privately against production
Cloudflare Workers apps before this release; public versioning starts here.

### Highlights

- Type-safe, Eloquent-style ORM for Cloudflare D1: models, relationships,
  query builder, migrations, seeders/factories, and a zero-config CLI.
- Attribute casting (dates, JSON, booleans, enums via `enumCast` with
  `onInvalidRead`), accessors/mutators, appended virtuals, model proxies.
- Relationships: belongsTo, hasOne, hasMany, belongsToMany (+ pivot sugar),
  hasOneThrough / hasManyThrough, full polymorphic set (morphOne, morphMany,
  morphTo, morphToMany, morphedByMany), eager loading with constraints,
  whereHas / whereRelation, relation aggregates (withCount / withSum /
  withAvg / withMin / withMax / withExists).
- Query builder: fluent wheres (incl. date-part helpers, JSON path/contains,
  FTS5 whereMatch), unions / intersect / except, CTEs, index hints, cursor +
  offset pagination, prepared queries (`prepare()` / `placeholder()`),
  atomic `increment()` / `decrement()`.
- Transactions: `transaction(db, tx => ...)` write-only unit-of-work flushed
  as one atomic `db.batch()`, with hooks, revisions, and soft-delete-aware
  deletes (incl. `tx.increment` / `tx.decrement`).
- Soft deletes, global scopes, named scopes, revision tracking with
  `asOf()` / `revertTo()` time-travel, multi-database support, optional KV
  cache adapter, D1 Sessions / read-replica awareness, `RETURNING` support.
- Auto primary-key generation (`keyStrategy`: uuid / uuidv7 / ulid / custom),
  bulk `createMany()`, `upsert`, dynamic runtime models.
- CLI: migrate / rollback / fresh / seed / status, schema-diff `generate`,
  make:* scaffolding (model, migration, seeder, factory, resource, pivot,
  dto, types), validate / inspect / tinker.
- Quality gates at release: 1621 unit + 121 CLI tests, 100% statement,
  branch, function, and line coverage enforced in CI; zero runtime
  dependencies.
