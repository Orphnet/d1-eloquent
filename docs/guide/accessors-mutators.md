# Accessors & Mutators

Accessors transform attribute values on read. Mutators transform values on write. Together they let you define how data flows between your application logic and the database — building on top of [attribute casting](./casting.md).

**Without d1-eloquent**

```ts
// Computed fields — helper functions scattered across the codebase
function getFullName(user: UserRow): string {
  return `${user.first_name} ${user.last_name}`
}

// Mutating on write — must remember at every call site
import { hashSync } from 'bcryptjs'
function createUser(db: D1Database, data: UserInput) {
  return db.prepare('INSERT INTO users (...) VALUES (?, ?, ?)')
    .bind(data.name, data.email, hashSync(data.password))
    .run()
}
function updatePassword(db: D1Database, id: string, raw: string) {
  // Forget hashSync here? Security bug.
  return db.prepare('UPDATE users SET password = ? WHERE id = ?')
    .bind(hashSync(raw), id)
    .run()
}

// API responses need manual assembly for computed fields
function toResponse(user: UserRow) {
  return { ...user, full_name: getFullName(user) }
}
```

**With d1-eloquent**

```ts
class User extends BaseModel<UserAttrs> {
  static table = 'users'

  static accessors = {
    // Virtual attribute — computed on read, no DB column needed
    full_name: Attribute.get<string>((_, attrs) =>
      `${attrs.first_name} ${attrs.last_name}`
    ),

    // Mutator — enforced on every write, impossible to forget
    password: Attribute.set<string>((value) => hashSync(value)),
  }

  static appends = ['full_name']  // include in toObject()
  static hidden = ['password']     // exclude from toObject()
}

user.get('full_name')     // "Alice Smith" (computed automatically)
user.set('password', 'raw')    // hashed automatically — every time
user.toObject()           // { ..., full_name: "Alice Smith" } (no password)
```

## Defining Accessors & Mutators

Declare accessors and mutators via `static accessors` on your model. Each key maps to an `Attribute` instance created with one of three factories:

```ts
import { BaseModel, Attribute } from '@orphnet/d1-eloquent'

interface UserAttrs {
  id: string
  first_name: string
  last_name: string
  password: string
  created_at: Date
  updated_at: Date
}

class User extends BaseModel<UserAttrs> {
  static table = 'users'

  static accessors = {
    // Get-only accessor (virtual attribute)
    full_name: Attribute.get<string>((_, attrs) =>
      `${attrs.first_name} ${attrs.last_name}`
    ),

    // Set-only mutator
    password: Attribute.set<string>((value) =>
      hashSync(value)
    ),

    // Both get and set
    email: Attribute.make({
      get: (value: string) => value.toLowerCase(),
      set: (value: string) => value.trim().toLowerCase(),
    }),
  }
}
```

**Factory methods:**

| Factory | Purpose |
|---|---|
| `Attribute.make({ get?, set? })` | Accessor with get and/or set (at least one required) |
| `Attribute.get(fn)` | Get-only accessor (shorthand) |
| `Attribute.set(fn)` | Set-only mutator (shorthand) |

Attribute instances are frozen after creation for immutability.

> [!NOTE]
> Accessors are inherited. A subclass's `static accessors` are merged with those of its parent classes (walking the prototype chain), and a child definition wins on any key it redefines — the same resolution rule as [casts](./casting.md).

## Accessor Pipeline

When you call `model.get('key')`, the value is resolved through a pipeline:

1. **Cast hydration** — the raw DB value is transformed by the column cast (e.g., `'boolean'` turns `1` into `true`)
2. **Accessor** — the cast-hydrated value is passed to the accessor's `get` function

The accessor receives two arguments: the cast-hydrated value and a plain object of all cast-hydrated attributes:

```ts
static accessors = {
  display_name: Attribute.get<string>((value, attrs) => {
    // `value` is the cast-hydrated value of `display_name`
    // `attrs` contains all cast-hydrated attribute values
    return value || `${attrs.first_name} ${attrs.last_name}`
  }),
}
```

## Mutator Fan-Out

When a mutator returns a plain object (not `null`, `Date`, or `Array`), the keys are spread across multiple columns. This is useful for splitting a single input into several database fields:

```ts
static accessors = {
  name: Attribute.make({
    get: (_, attrs) => `${attrs.first_name} ${attrs.last_name}`,
    set: (value: string) => {
      const [first, ...rest] = value.split(' ')
      return { first_name: first, last_name: rest.join(' ') }
    },
  }),
}

// Usage
user.set('name' as any, 'Alice Smith')
// Sets first_name = 'Alice', last_name = 'Smith'
```

> [!WARNING]
> Fanned-out keys bypass mutators on their target keys and are marked dirty unconditionally. This matches Laravel behavior.

## Cycle Detection

If an accessor references another accessor that eventually loops back, d1-eloquent throws a descriptive error showing the full resolution chain:

```
Circular accessor detected: a -> b -> c -> a
```

This prevents infinite recursion. Cycle detection uses a module-scoped WeakMap, not instance state, so it works correctly across nested accessor calls.

## Virtual Attributes

A virtual attribute is a get-only accessor where the key has **no backing database column**. The key exists only in the accessor map, not in `attrs`:

```ts
interface PostAttrs {
  id: string
  first_name: string
  last_name: string
}

class Post extends BaseModel<PostAttrs> {
  static table = 'posts'

  static accessors = {
    // `full_name` has no matching column — it's virtual
    full_name: Attribute.get<string>((_, attrs) =>
      `${attrs.first_name} ${attrs.last_name}`
    ),
  }
}

const post = await Post.find(id)
post.get('full_name' as any)  // "Alice Smith" (computed)
```

Calling `set()` on a virtual key is a silent no-op. Virtuals are excluded from dirty tracking and database writes.

## Serialization Control

Two static properties control which keys appear in `toObject()`:

### `static appends`

Include virtual attribute keys in `toObject()` output:

```ts
class Post extends BaseModel<PostAttrs> {
  static table = 'posts'
  static appends = ['full_name']

  static accessors = {
    full_name: Attribute.get<string>((_, attrs) =>
      `${attrs.first_name} ${attrs.last_name}`
    ),
  }
}

post.toObject()
// { id: "...", first_name: "Alice", last_name: "Smith", full_name: "Alice Smith" }
```

### `static hidden`

Exclude keys from `toObject()` output:

```ts
class User extends BaseModel<UserAttrs> {
  static table = 'users'
  static hidden = ['password']
}

user.toObject()
// { id: "...", name: "Alice", email: "..." }  (no password field)
```

**Hidden wins over appends.** If a key appears in both, it is excluded.

`toRaw()` never includes virtual or appended keys — it returns only real column data in DB-safe format.

## Raw & Original Access

### `getRaw(key)`

Bypasses the accessor pipeline entirely. Returns the cast-hydrated value directly, without running the accessor's `get` function:

```ts
const user = await User.find(id)

user.get('email')     // "alice@example.com" (accessor applied)
user.getRaw('email')  // "Alice@Example.com" (cast-hydrated, no accessor)
```

### `getOriginal(key)`

Returns the value from the construction-time or last-save snapshot. Useful for comparing current state against what was originally loaded:

```ts
const user = await User.find(id)
user.set('name', 'Bob')

user.get('name')          // "Bob"
user.getOriginal('name')  // "Alice" (value at load time)
```

## Accessor Caching

Accessor results are cached per-instance. Calling `model.get('key')` multiple times runs the accessor function only once — subsequent calls return the cached result.

The cache is automatically invalidated whenever a write operation occurs (`set`, `fill`, `setRaw`, `forceFill`). You can also clear it manually:

```ts
model.clearAccessorCache()
```

This is useful when an accessor depends on external state that has changed since the last access.

> [!NOTE]
> The cache is skipped during cycle detection to avoid storing stale entries from partial resolution chains.

## Proxy Access

`model.asProxy()` returns a `Proxy` wrapper that enables direct property access instead of calling `get()` and `set()`:

```ts
const user = await User.find(id)
const proxy = user.asProxy()

// Instead of model.get('name')
proxy.name           // "Alice"

// Instead of model.set('name', 'Bob')
proxy.name = 'Bob'

// Methods work too
await proxy.save()
```

The proxy is lazily created and cached on the instance.

### `$model` Escape Hatch

Access the underlying `BaseModel` instance via `proxy.$model`:

```ts
const model = proxy.$model
model.isDirty()  // true
```

### JSON Serialization

`JSON.stringify(proxy)` matches `model.toObject()`, including appended virtuals and excluding hidden keys.

### `instanceof`

The proxy preserves prototype identity:

```ts
proxy instanceof User  // true
```

### Type Safety with `TVirtuals`

Use the second generic parameter to type virtual attribute access through the proxy:

```ts
interface PostAttrs {
  id: string
  first_name: string
  last_name: string
}

class Post extends BaseModel<PostAttrs, { full_name: string }> {
  static table = 'posts'
  static appends = ['full_name']

  static accessors = {
    full_name: Attribute.get<string>((_, attrs) =>
      `${attrs.first_name} ${attrs.last_name}`
    ),
  }
}

const proxy = post.asProxy()
proxy.full_name  // string (typed via TVirtuals)
```

`TVirtuals` defaults to `{}`, so existing `BaseModel<TAttrs>` usage is fully backward compatible.

## `ModelProxy` Type

Import `ModelProxy` from the package to type proxy references:

```ts
import type { ModelProxy } from '@orphnet/d1-eloquent'
import type { PostAttrs } from './models/Post'

function render(post: ModelProxy<PostAttrs, { full_name: string }>) {
  console.log(post.full_name)
}
```

`ModelProxy<TAttrs, TVirtuals>` combines attribute access, virtual access, model methods, and the `$model` escape hatch into a single type.
