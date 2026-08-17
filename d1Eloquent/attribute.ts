// ─── Types ───

/**
 * Accessor get function signature.
 * Receives the raw attribute value and all model attributes.
 */
export type AccessorGetFn<TGet = unknown, TResult = unknown> = (
  value: TGet,
  attrs: Record<string, unknown>,
) => TResult;

/**
 * Accessor set function signature.
 * Receives the value being set.
 * Can return a single value or a Record for multi-attribute fan-out.
 */
export type AccessorSetFn<TSet = unknown> = (
  value: TSet,
) => unknown;

// ─── Attribute ───

/**
 * Immutable value class for declaring model accessors and mutators.
 *
 * Accessors transform attribute values on read (get).
 * Mutators transform attribute values on write (set).
 *
 * Create via static factories: Attribute.make(), Attribute.get(), Attribute.set().
 */
export class Attribute<TGet = unknown, TSet = unknown> {
  readonly #get: AccessorGetFn<TGet> | undefined;
  readonly #set: AccessorSetFn<TSet> | undefined;

  private constructor(config: {
    get?: AccessorGetFn<TGet>;
    set?: AccessorSetFn<TSet>;
  }) {
    this.#get = config.get;
    this.#set = config.set;
    Object.freeze(this);
  }

  /**
   * Create an Attribute with get and/or set callbacks.
   * At least one of get or set must be provided.
   */
  static make<TGet = unknown, TSet = unknown>(config: {
    get?: AccessorGetFn<TGet>;
    set?: AccessorSetFn<TSet>;
  }): Attribute<TGet, TSet> {
    if (!config.get && !config.set) {
      throw new Error(
        "Attribute.make() requires at least one of 'get' or 'set' callbacks.",
      );
    }
    return new Attribute<TGet, TSet>(config);
  }

  /** Shorthand: create a get-only accessor. */
  static get<TGet = unknown>(fn: AccessorGetFn<TGet>): Attribute<TGet, never> {
    return new Attribute<TGet, never>({ get: fn });
  }

  /** Shorthand: create a set-only mutator. */
  static set<TSet = unknown>(fn: AccessorSetFn<TSet>): Attribute<never, TSet> {
    return new Attribute<never, TSet>({ set: fn });
  }

  /** Whether this attribute has a getter (accessor). */
  hasGetter(): boolean {
    return this.#get !== undefined;
  }

  /** Whether this attribute has a setter (mutator). */
  hasSetter(): boolean {
    return this.#set !== undefined;
  }

  /** Invoke the getter with the raw value and model attributes. */
  applyGet(value: unknown, attrs: Record<string, unknown>): unknown {
    if (!this.#get) {
      throw new Error("Cannot applyGet: no getter defined on this Attribute.");
    }
    return this.#get(value as TGet, attrs);
  }

  /** Invoke the setter with the incoming value. */
  applySet(value: unknown): unknown {
    if (!this.#set) {
      throw new Error("Cannot applySet: no setter defined on this Attribute.");
    }
    return this.#set(value as TSet);
  }
}
