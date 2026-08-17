import type { BaseModel } from "./baseModel";
import { AccessorManager } from "./accessorManager";
import type { Attribute } from "./attribute";

// ─── ModelPublicMethods ───

/**
 * Public method interface of BaseModel, used to type the proxy so that
 * model methods (save, delete, fill, etc.) are callable on the proxy.
 */
type ModelPublicMethods<TAttrs extends object, TVirtuals extends Record<string, unknown> = {}> = {
  get<K extends keyof TAttrs>(key: K): TAttrs[K];
  getRaw<K extends keyof TAttrs>(key: K): TAttrs[K];
  getOriginal<K extends keyof TAttrs>(key: K): TAttrs[K];
  set<K extends keyof TAttrs>(key: K, value: TAttrs[K]): BaseModel<TAttrs, TVirtuals>;
  fill(values: Partial<TAttrs>): BaseModel<TAttrs, TVirtuals>;
  forceFill(values: Partial<TAttrs>): BaseModel<TAttrs, TVirtuals>;
  save(db?: D1Database, opts?: unknown): Promise<BaseModel<TAttrs, TVirtuals>>;
  delete(db?: D1Database, opts?: unknown): Promise<boolean>;
  restore(db?: D1Database, opts?: unknown): Promise<boolean>;
  refresh(db?: D1Database): Promise<BaseModel<TAttrs, TVirtuals>>;
  toObject(): TAttrs;
  toRaw(): Record<string, unknown>;
  isDirty(key?: keyof TAttrs): boolean;
  getDirty(): Partial<TAttrs>;
  getChanges(): Partial<TAttrs>;
  wasChanged(key?: keyof TAttrs): boolean;
  wasRecentlyCreated: boolean;
  replicate(except?: (keyof TAttrs & string)[]): ModelProxy<TAttrs, TVirtuals>;
  getKey<T = unknown>(): T | null;
  getKeyName(): string;
  exists(): boolean;
  setRelation<T>(name: string, value: T): BaseModel<TAttrs, TVirtuals>;
  clearAccessorCache(): void;
  asProxy(): ModelProxy<TAttrs, TVirtuals>;
};

// ─── ModelProxy type ───

/**
 * The type of the proxy returned by asProxy().
 * Combines attribute access (TAttrs), virtual attribute access (TVirtuals),
 * model methods, and a $model escape hatch.
 */
export type ModelProxy<TAttrs extends object, TVirtuals extends Record<string, unknown> = {}> =
  TAttrs & TVirtuals & ModelPublicMethods<TAttrs, TVirtuals> & { $model: BaseModel<TAttrs, TVirtuals> };

// ─── createModelProxy ───

/**
 * Creates a Proxy wrapper around a BaseModel instance.
 * The proxy enables direct property access (proxy.key) that resolves through
 * the accessor pipeline via model.get(key).
 */
export function createModelProxy<TAttrs extends object, TVirtuals extends Record<string, unknown> = {}>(
  target: BaseModel<TAttrs, TVirtuals>,
): ModelProxy<TAttrs, TVirtuals> {
  const ctor = target.constructor as {
    accessors?: Record<string, Attribute>;
    appends?: string[];
    prototype: object;
  };

  const proxy = new Proxy(target, {
    get(target, prop, receiver) {
      // 1. Symbol props passthrough (for iterators, toPrimitive, etc.)
      if (typeof prop === "symbol") {
        return Reflect.get(target, prop, receiver);
      }

      // 2. $model escape hatch
      if (prop === "$model") {
        return target;
      }

      // 3. toJSON for JSON.stringify support — delegate to model's toJSON which includes relations
      if (prop === "toJSON") {
        return () => (target as unknown as { toJSON(): object }).toJSON();
      }

      // 4. Attr or virtual key: resolve through accessor pipeline
      const attrs = Reflect.get(target, 'attrs') as Record<string, unknown>;
      const accessors = AccessorManager.resolveAccessorsFor(ctor as { accessors?: Record<string, Attribute>; prototype: object });
      const hasAccessorGetter = Object.hasOwn(accessors, prop) && accessors[prop]?.hasGetter();

      if (Object.hasOwn(attrs, prop) || hasAccessorGetter) {
        return target.get(prop as keyof TAttrs);
      }

      // 5. Pass through everything else (methods, internals, prototype)
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function" && prop !== "constructor") {
        return (value as Function).bind(target);
      }
      return value;
    },

    set(target, prop, value) {
      if (typeof prop === "string") {
        target.set(prop as keyof TAttrs, value as TAttrs[keyof TAttrs]);
        return true;
      }
      return false;
    },

    has(target, prop) {
      if (typeof prop !== "string") return false;

      const attrs = Reflect.get(target, 'attrs') as Record<string, unknown>;
      if (Object.hasOwn(attrs, prop)) return true;

      // Check appended virtuals
      const appends = ctor.appends;
      if (appends && appends.includes(prop)) return true;

      // Methods return false per spec
      return false;
    },

    ownKeys(target) {
      const attrs = Reflect.get(target, 'attrs') as Record<string, unknown>;
      const attrKeys = Object.keys(attrs);
      const appends = ctor.appends ?? [];

      // Deduplicate attr + virtual keys (the enumerable set)
      const keySet = new Set([...attrKeys, ...appends]);

      // Must also include non-configurable own properties of the target
      // (JS Proxy invariant), but they'll be non-enumerable via getOwnPropertyDescriptor
      const targetOwnKeys = Reflect.ownKeys(target);
      for (const k of targetOwnKeys) {
        if (typeof k === "string") keySet.add(k);
      }

      return [...keySet];
    },

    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop !== "string") return undefined;

      const attrs = Reflect.get(target, 'attrs') as Record<string, unknown>;
      const accessors = AccessorManager.resolveAccessorsFor(ctor as { accessors?: Record<string, Attribute>; prototype: object });
      const hasAccessorGetter = Object.hasOwn(accessors, prop) && accessors[prop]?.hasGetter();
      const appends = ctor.appends;
      const isAppended = appends && appends.includes(prop);

      if (Object.hasOwn(attrs, prop) || hasAccessorGetter || isAppended) {
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: target.get(prop as keyof TAttrs),
        };
      }

      // Non-configurable target own properties must be reported accurately
      const targetDesc = Object.getOwnPropertyDescriptor(target, prop);
      if (targetDesc) {
        return { ...targetDesc, enumerable: false };
      }

      return undefined;
    },

    getPrototypeOf(target) {
      return Object.getPrototypeOf(target);
    },
  });

  return proxy as unknown as ModelProxy<TAttrs, TVirtuals>;
}
