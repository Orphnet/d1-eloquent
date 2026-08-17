# Transactions

Transactions give you an atomic unit of work over D1: collect any number of model writes inside a closure, and they all commit - or all roll back - as **one** `db.batch()`. Hooks, casts, timestamps, key strategies, and revision rows are handled with the same fidelity as single-model writes.

**Without d1-eloquent**

```ts
// Hand-rolled batch - no hooks, no casts, no audit trail
const userId = crypto.randomUUID()
const postId = crypto.randomUUID()
const now = new Date().toISOString()

await db.batch([
  db.prepare('INSERT INTO users (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .bind(userId, 'Alice', now, now),
  db.prepare('INSERT INTO posts (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(postId, userId, 'Hello', now, now),
  // Want an audit row too? Build the diff JSON and the INSERT yourself,
  // remember to redact sensitive fields, and keep the column list in sync.
])
```

**With d1-eloquent**

```ts
import { transaction } from '@orphnet/d1-eloquent'

const user = await transaction(env.DB, async (tx) => {
  const u = await tx.create(User, { name: 'Alice' })          // UUID auto-generated
  await tx.create(Post, { user_id: u.get('id'), title: 'Hello' })
  return u
})
// Both rows committed atomically - hooks, casts, timestamps,
// and revision rows (if enabled) all included in the same batch.
```

## How It Works - a Write-Only Collector

D1 has **no interactive transactions**. Every statement auto-commits, and `db.batch()` is the platform's only atomicity primitive. So `transaction()` doesn't try to fake `BEGIN`/`COMMIT` - it hands your closure a write-only collector `tx`:

1. **During the closure** - each `tx.*` op runs its before-hooks, casts, timestamps, and key strategy immediately, then records a prepared statement. **Nothing executes yet.**
2. **When the closure returns** - every collected statement (data rows *and* their revision rows) runs as one ordered `db.batch()`.
3. **After the commit** - after-hooks fire, `_persisted` is stamped, dirty state is synced, and each op's `D1Result` is mapped back.

If anything fails - a constraint violation mid-batch, a thrown error in the closure, a before-hook returning `false` - nothing persists.

> [!WARNING]
> **D1 constraints - read this before reaching for `tx`**
>
> - **No interactive transactions.** There is no `BEGIN` / `COMMIT` on D1 - `db.batch()` is the only atomicity primitive, and it's what `transaction()` uses under the hood.
> - **No mid-transaction reads.** `tx` is *write-only by design*. You cannot `SELECT` inside the unit of work - no statement has executed yet, so there is nothing to read. Do all reads **before** opening the transaction.
> - **No savepoints, no nesting.** A `transaction()` inside another `transaction()` is two independent batches - the inner one will not roll back with the outer.
>
> The idioms below show how to work naturally within these limits.

## Three Forms

```ts
import { transaction } from '@orphnet/d1-eloquent'

// 1. Standalone - the primary form. Returns whatever the closure returns.
const order = await transaction(env.DB, async (tx) => {
  return tx.create(Order, { customer_id: customerId, total: 4999 })
})

// 2. Static closure form - identical behavior, delegates to transaction().
const order2 = await Order.transaction(env.DB, async (tx) => {
  return tx.create(Order, { customer_id: customerId, total: 1299 })
})

// 3. Raw statement array - batch pre-built prepared statements,
//    returns their D1Result[]. No hooks, no casts, no revisions.
const stmts = [
  Order.query().toInsertPrepared(env.DB, { id: crypto.randomUUID(), total: 100 }),
  Order.query().whereEq('id', staleId).toDeletePrepared(env.DB),
]
const results = await Order.transaction(env.DB, stmts)
```

## The `tx` Surface

| Op | Hooks / casts | Revisions | Notes |
|---|---|---|---|
| `await tx.create(Model, attrs)` | `saving` / `creating` before; `created` / `saved` after | Yes | Timestamps + key strategy applied; returns the model instance |
| `await tx.save(instance)` | `saving` + `creating` *or* `updating` before; matching after-hooks | Yes | INSERT if unpersisted, else UPDATE of dirty attrs by PK |
| `tx.update(query, values)` | none | - | Bulk UPDATE via a query builder |
| `await tx.delete(instance)` | `deleting` before; `deleted` after | Yes | Soft-delete aware: sets `deleted_at` when the model uses `softDeletes`, else DELETE by primary key |
| `tx.delete(query)` | none | - | Bulk DELETE via a query builder |
| `await tx.upsert(Model, attrs, conflictCols, updateCols?)` | `saving` / `creating` before; `created` / `saved` after | Yes | `INSERT ... ON CONFLICT` create-or-update; writes an optimistic `create` revision |
| `tx.updateJsonSet(query, col, path, value)` | none | - | Bulk `json_set()` UPDATE |
| `tx.updateJsonPatch(query, col, patch)` | none | - | Bulk `json_patch()` UPDATE |
| `tx.updateJsonRemove(query, col, path)` | none | - | Bulk `json_remove()` UPDATE |
| `tx.increment(query, col, amount?, extra?)` | none | - | Atomic `SET col = col + ?` (default `1`); `extra` sets more columns |
| `tx.decrement(query, col, amount?, extra?)` | none | - | Atomic `SET col = col - ?` |
| `tx.results` | - | - | Ordered `D1Result[]`, one per collected statement, populated after the flush |

The instance ops (`create`, `save`, `upsert`, `delete(instance)`) are async because their before-hooks run during collection - always `await` them. The bulk query ops collect synchronously.

```ts
await transaction(env.DB, async (tx) => {
  // instance ops - hooks + casts, revision rows if enabled
  const user = await tx.create(User, { name: 'Alice' })
  loaded.set('status', 'active')
  await tx.save(loaded)
  await tx.delete(staleUser)

  // bulk ops - straight to SQL, no hooks
  tx.update(User.query().whereEq('plan', 'trial'), { plan: 'free' })
  tx.delete(Session.query().where('expires_at', '<', now))

  // create-or-update by conflict target
  await tx.upsert(Setting, { key: 'theme', value: 'dark' }, ['key'])

  // in-place JSON edits
  tx.updateJsonSet(Doc.query().whereEq('id', docId), 'meta', '$.reviewed', true)
  tx.updateJsonPatch(Doc.query().whereEq('id', docId), 'meta', { version: 2 })
  tx.updateJsonRemove(Doc.query().whereEq('id', docId), 'meta', '$.draft')

  // atomic counters/balances - e.g. debit a wallet + write its ledger row,
  // both committing (or rolling back) together
  tx.decrement(Wallet.query().whereEq('id', walletId), 'balance', 500)
  await tx.create(Ledger, { wallet_id: walletId, amount: -500 })
})
```

## Hook Ordering

Hooks fire in the same order as single-model writes, split around the flush:

1. **During collection** - `saving` then `creating` (insert-shaped ops), `saving` then `updating` (persisted `save`), or `deleting` (instance delete). Before-hooks see the model *before* auto timestamps and key generation are applied, matching the non-transaction path.
2. **After the commit** - `created` / `updated` / `deleted` then `saved` fire per op, in collection order. For updates and instance deletes, after-hooks fire only when the row actually changed (`meta.changes > 0`).

## Atomicity & Rollback

Any statement failing rolls back the entire batch - D1 guarantees `batch()` is all-or-nothing:

```ts
await expect(
  transaction(env.DB, async (tx) => {
    await tx.create(User, { name: 'Ok' })
    await tx.create(User, {}) // name NOT NULL -> the batch fails
  }),
).rejects.toThrow()

await User.query().count(env.DB) // -> 0 - the first create rolled back too
```

A before-hook (`saving` / `creating` / `updating` / `deleting`) returning `false` inside the closure throws `TransactionAborted` - the flush is never reached, so **nothing** executes, not even ops collected earlier:

```ts
import { transaction, TransactionAborted } from '@orphnet/d1-eloquent'

class GuardedDoc extends BaseModel<DocAttrs> {
  static table = 'docs'
  static hooks = { creating: (doc: GuardedDoc) => doc.get('title') !== '' }
}

try {
  await transaction(env.DB, async (tx) => {
    await tx.create(User, { name: 'Alice' })     // collected...
    await tx.create(GuardedDoc, { title: '' })   // hook -> false
  })
} catch (e) {
  if (e instanceof TransactionAborted) {
    // nothing was written - the user row above was discarded too
  }
}
```

Equally, throwing any error from the closure discards the whole unit of work.

## Revisions Ride in the Same Batch

For [revision-tracked](./revisions.md) models, each instance op's `model_revisions` INSERT is collected immediately after its data statement - both commit or roll back **together**. No orphan audit rows, no unaudited writes:

```ts
await transaction(
  env.DB,
  async (tx) => {
    await tx.create(Invoice, { total: 4999 })       // data row + revision row
    invoice.set('status', 'paid')
    await tx.save(invoice)                          // data row + revision row
  },
  { revision: { actorId: userId, requestId, reason: 'checkout' } },
)
```

The `revision` context (`actorId` / `requestId` / `reason`) applies to every revision row written by the transaction. Pass `skipRevisions: true` to write data rows only.

### Options (`TxOptions`)

| Option | Type | Default | Effect |
|---|---|---|---|
| `revision` | `{ actorId?, requestId?, reason? }` | - | Revision context stamped onto every revision row in the batch |
| `skipRevisions` | `boolean` | `false` | Suppress revision rows for this transaction |

## Idioms for a Write-Only World

### Parent to child without a read

Because primary keys are client-generated (the default `uuid` key strategy fills them during collection), a child row can reference its parent **before anything hits the database**:

```ts
await transaction(env.DB, async (tx) => {
  const order = await tx.create(Order, { customer_id: customerId })
  // order.get('id') is already set - no round-trip needed
  await tx.create(OrderItem, { order_id: order.get('id'), sku: 'A-1', qty: 2 })
  await tx.create(OrderItem, { order_id: order.get('id'), sku: 'B-7', qty: 1 })
})
```

### Read before, write inside

Since `tx` can't read, load everything you need first, decide, then open the transaction purely to write:

```ts
// 1. Read phase - normal queries, outside the transaction
const wallet = await Wallet.find(env.DB, walletId)
if (!wallet || (wallet.get('balance') as number) < price) {
  throw new Error('Insufficient funds')
}

// 2. Write phase - one atomic batch
await transaction(env.DB, async (tx) => {
  wallet.set('balance', (wallet.get('balance') as number) - price)
  await tx.save(wallet)
  await tx.create(Purchase, { wallet_id: walletId, amount: price })
})
```

> [!WARNING]
> **Reads inside the closure see PRE-transaction state.** Nothing executes until the closure returns, so a `Model.find()` / `query().get()` awaited *inside* the closure runs immediately against the database as it was before the transaction - it will not see your collected writes. Keep reads out of the closure to avoid confusing yourself.

## Per-Op Results

After the transaction resolves, `tx.results` holds one `D1Result` per collected statement, in collection order (revision statements included). Capture the `tx` reference if you need them:

```ts
import type { Tx } from '@orphnet/d1-eloquent'

let captured!: Tx
await transaction(env.DB, async (tx) => {
  captured = tx
  tx.update(User.query().whereEq('plan', 'trial'), { plan: 'free' })
})
captured.results[0]?.meta.changes // rows the bulk update touched
```

Each instance op's own data-statement result is also mapped back onto its model post-commit via the model's `recordMeta()` hook, if the model defines one - bulk statements and interleaved revision rows don't shift the mapping.

## When You Don't Need a Transaction

- **A single write** - `Model.create()` / `save()` / `delete()` are already atomic on their own.
- **Bulk-inserting many rows of one model** - [`Model.createMany()`](../api/base-model.md) already batches inserts (and their revision rows) atomically.
- **Reads** - transactions are write-only; plain queries don't need (and can't use) them.

Reach for `transaction()` when *multiple related writes* - across models, or mixing instance and bulk ops - must stand or fall together.
