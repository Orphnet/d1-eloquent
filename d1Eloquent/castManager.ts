// ─── Interface ───

export interface AttributeCast<TGet = unknown, TSet = unknown> {
  /** Transform DB value → application value */
  get(value: unknown): TGet;
  /** Transform application value → DB value */
  set(value: TSet): unknown;
}

// ─── Built-in cast type string union ───

export type BuiltInCast =
  | "boolean"
  | "integer"
  | "float"
  | "real"
  | "string"
  | "datetime"
  | "date"
  | "timestamp"
  | "json"
  | "array"
  | "blob";

// ─── Cast definition (string shortcut OR class instance) ───

export type CastDefinition = BuiltInCast | AttributeCast;

// ─── Built-in implementations ───

const booleanCast: AttributeCast<boolean, boolean> = {
  get: (v) => Boolean(v),
  set: (v) => (v ? 1 : 0),
};

const integerCast: AttributeCast<number, number> = {
  get: (v) => Math.trunc(Number(v)),
  set: (v) => Math.trunc(v),
};

const floatCast: AttributeCast<number, number> = {
  get: (v) => Number(v),
  set: (v) => Number(v),
};

const stringCast: AttributeCast<string, string> = {
  get: (v) => String(v),
  set: (v) => String(v),
};

const datetimeCast: AttributeCast<Date, Date | string> = {
  get: (v) => new Date(v as string),
  set: (v) => (v instanceof Date ? v.toISOString() : String(v)),
};

const dateCast: AttributeCast<Date, Date | string> = {
  get: (v) => {
    const d = new Date(v as string);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  },
  set: (v) => {
    const d = v instanceof Date ? v : new Date(v);
    return d.toISOString().split("T")[0];
  },
};

const timestampCast: AttributeCast<Date, Date | number> = {
  get: (v) => new Date((v as number) * 1000),
  set: (v) => (v instanceof Date ? Math.floor(v.getTime() / 1000) : Number(v)),
};

/** Parse a JSON-shaped DB value, returning the raw string on parse error rather than throwing. */
function safeJsonParse(v: unknown): unknown {
  if (typeof v !== "string") return v;
  if (v.length === 0) return v;
  try {
    return JSON.parse(v);
  } catch {
    // Tolerate non-JSON strings — log only in debug builds; surface the raw value.
    return v;
  }
}

const jsonCast: AttributeCast<unknown, unknown> = {
  get: safeJsonParse,
  set: (v) => (typeof v === "string" ? v : JSON.stringify(v)),
};

const arrayCast: AttributeCast<unknown[], unknown[]> = {
  get: (v) => {
    const parsed = safeJsonParse(v);
    return Array.isArray(parsed) ? parsed : [];
  },
  set: (v) => JSON.stringify(v ?? []),
};

/**
 * Passthrough cast for BLOB columns. D1 returns BLOB as `ArrayBuffer`; setting
 * accepts `ArrayBuffer`, typed arrays, or `Uint8Array`. We don't transform the
 * value — the cast exists so the column shows up in the attribute manager and
 * so explicit typing works through `casts: { col: 'blob' }`.
 */
const blobCast: AttributeCast<unknown, unknown> = {
  get: (v) => v,
  set: (v) => v,
};

// ─── Registry ───

const BUILT_IN: Record<BuiltInCast, AttributeCast> = {
  boolean: booleanCast,
  integer: integerCast,
  float: floatCast,
  real: floatCast,
  string: stringCast,
  datetime: datetimeCast,
  date: dateCast,
  timestamp: timestampCast,
  json: jsonCast,
  array: arrayCast,
  blob: blobCast,
};

/**
 * A cast that validates a column against a fixed set of allowed values on both
 * read (DB → app) and write (app → DB). SQLite has no native enum type, so this
 * is the runtime-validated equivalent of a backed enum — pair it with a TS union
 * on your attrs interface for compile-time safety too.
 *
 * `null` / `undefined` pass through (use a NOT NULL column to forbid them).
 *
 * @example
 * type Status = 'draft' | 'published' | 'archived'
 * interface PostAttrs { id: string; status: Status }
 * class Post extends BaseModel<PostAttrs> {
 *   static table = 'posts'
 *   static casts = { status: enumCast(['draft', 'published', 'archived']) }
 * }
 */
export function enumCast<const T extends string | number>(
  values: readonly T[],
  opts?: { onInvalidRead?: "throw" | "null" | "keep" },
): AttributeCast<T | null, T | null | undefined> {
  const allowed = new Set<unknown>(values);
  const onInvalidRead = opts?.onInvalidRead ?? "throw";
  const check = (value: unknown): void => {
    if (!allowed.has(value)) {
      throw new Error(
        `Invalid enum value ${JSON.stringify(value)} — allowed: ${values.map((v) => JSON.stringify(v)).join(", ")}`,
      );
    }
  };
  return {
    get(value) {
      if (value == null) return null;
      // Reads default to strict (throw), but a single out-of-set/legacy row
      // shouldn't 500 a whole list query - `onInvalidRead: 'null' | 'keep'`
      // lets a read degrade gracefully instead. Writes stay strict.
      if (!allowed.has(value)) {
        if (onInvalidRead === "null") return null;
        if (onInvalidRead === "keep") return value as T;
        check(value); // 'throw'
      }
      return value as T;
    },
    set(value) {
      if (value == null) return null;
      check(value);
      return value as T;
    },
  };
}

function resolveCast(def: CastDefinition): AttributeCast {
  if (typeof def === "string") {
    const cast = BUILT_IN[def];
    if (!cast) throw new Error(`Unknown cast type: "${def}"`);
    return cast;
  }
  return def;
}

// ─── CastManager ───

export class CastManager {
  static resolveCastsFor(ctor: {
    timestamps?: boolean;
    softDeletes?: boolean;
    casts?: Record<string, CastDefinition>;
  }): Record<string, AttributeCast> {
    const merged: Record<string, AttributeCast> = {};

    if (ctor.timestamps !== false) {
      merged["created_at"] = BUILT_IN.datetime;
      merged["updated_at"] = BUILT_IN.datetime;
    }

    if (ctor.softDeletes) {
      merged["deleted_at"] = BUILT_IN.datetime;
    }

    if (ctor.casts) {
      for (const [key, def] of Object.entries(ctor.casts)) {
        merged[key] = resolveCast(def);
      }
    }

    return merged;
  }

  static castGet(cast: AttributeCast, value: unknown): unknown {
    if (value == null) return value;
    return cast.get(value);
  }

  static castSet(cast: AttributeCast, value: unknown): unknown {
    if (value == null) return value;
    return cast.set(value);
  }

  /**
   * True when `cast` is the built-in `timestamp` cast (column stored as an
   * integer unix-epoch, not an ISO datetime string). Callers building SQLite
   * date()/time()/strftime() expressions need a `'unixepoch'` modifier for
   * these columns, otherwise SQLite reads the integer as a Julian day.
   */
  static isTimestampCast(cast: AttributeCast | undefined): boolean {
    return cast === timestampCast;
  }

  static hydrateRow(
    casts: Record<string, AttributeCast>,
    row: Record<string, unknown>,
  ): Record<string, unknown> {
    const out = { ...row };
    for (const [key, cast] of Object.entries(casts)) {
      if (key in out) out[key] = CastManager.castGet(cast, out[key]);
    }
    return out;
  }

  static dehydrateRow(
    casts: Record<string, AttributeCast>,
    row: Record<string, unknown>,
  ): Record<string, unknown> {
    const out = { ...row };
    for (const [key, cast] of Object.entries(casts)) {
      if (key in out) out[key] = CastManager.castSet(cast, out[key]);
    }
    return out;
  }
}
