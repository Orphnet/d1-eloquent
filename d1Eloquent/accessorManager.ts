import type { Attribute } from "./attribute";

// ─── Types ───

/** Structural type for constructor with optional accessors. No BaseModel import needed. */
type AccessorCtor = {
  accessors?: Record<string, Attribute>;
  prototype: object;
};

// ─── AccessorManager ───

/**
 * Static utility for resolving accessor definitions from class hierarchies.
 *
 * Mirrors the CastManager pattern: resolves once, caches per constructor,
 * walks prototype chain for inheritance merging (child wins on key conflict).
 */
export class AccessorManager {
  private static cache = new WeakMap<object, Record<string, Attribute>>();

  /**
   * Resolve all accessors for a constructor, walking the prototype chain.
   * Child class accessors override parent accessors on the same key.
   * Result is frozen and cached.
   */
  static resolveAccessorsFor(ctor: AccessorCtor): Record<string, Attribute> {
    const cached = AccessorManager.cache.get(ctor);
    if (cached) return cached;

    // Collect own accessors from each level of the prototype chain (parent-first).
    // Walk via prototype.constructor chain to support both ES classes and
    // manual prototype setups (Object.create).
    const chain: Record<string, Attribute>[] = [];
    const visited = new Set<object>();
    let current: AccessorCtor | null = ctor;

    while (current && !visited.has(current)) {
      visited.add(current);
      if (
        current.hasOwnProperty("accessors") &&
        current.accessors &&
        typeof current.accessors === "object"
      ) {
        chain.unshift(current.accessors);
      }
      // Walk the instance prototype chain to find the parent constructor.
      // This works for both ES classes and function-based inheritance.
      const proto: object | null = current.prototype
        ? (Object.getPrototypeOf(current.prototype) as object | null)
        : null;
      const parentCtor: AccessorCtor | null =
        proto &&
        (proto as { constructor?: unknown }).constructor &&
        (proto as { constructor: unknown }).constructor !== current
          ? ((proto as { constructor: unknown }).constructor as AccessorCtor)
          : null;
      current =
        parentCtor && typeof parentCtor === "function" ? parentCtor : null;
    }

    // Merge parent-first so child overrides
    const merged: Record<string, Attribute> = {};
    for (const level of chain) {
      for (const [key, attr] of Object.entries(level)) {
        merged[key] = attr;
      }
    }

    const frozen = Object.freeze(merged);
    AccessorManager.cache.set(ctor, frozen);
    return frozen;
  }

  /** Check if a constructor has an accessor defined for a specific key. */
  static hasAccessor(ctor: AccessorCtor, key: string): boolean {
    const accessors = AccessorManager.resolveAccessorsFor(ctor);
    return key in accessors;
  }

  /** Clear the accessor cache. Primarily for testing. */
  static clearCache(): void {
    AccessorManager.cache = new WeakMap<object, Record<string, Attribute>>();
  }
}
