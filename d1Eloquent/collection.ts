/** Structural type for objects with a model-like get() method. */
interface Gettable {
    get(key: string): unknown;
}

/** Structural type for objects with a toObject() serialization method. */
interface Serializable {
    toObject(): object;
}

/**
 * Lightweight collection wrapper for model query results.
 *
 * Extends Array so it's fully compatible with array operations,
 * while adding convenience methods for common data transformations.
 */
export class Collection<T> extends Array<T> {
    /**
     * Create a Collection from an iterable (e.g., array).
     * Use `Collection.from(arr)` instead of `new Collection(arr)`.
     */
    static override from<T>(items: Iterable<T> | ArrayLike<T>): Collection<T> {
        const arr = Array.from(items);
        const col = new Collection<T>(arr.length);
        for (let i = 0; i < arr.length; i++) col[i] = arr[i];
        return col;
    }

    /**
     * Whether the collection is empty.
     */
    isEmpty(): boolean {
        return this.length === 0;
    }

    /**
     * Whether the collection has items.
     */
    isNotEmpty(): boolean {
        return this.length > 0;
    }

    /**
     * Get the first item, optionally matching a predicate.
     */
    first(predicate?: (item: T, index: number) => boolean): T | undefined {
        if (!predicate) return this[0];
        for (let i = 0; i < this.length; i++) {
            if (predicate(this[i], i)) return this[i];
        }
        return undefined;
    }

    /**
     * Get the last item, optionally matching a predicate.
     */
    last(predicate?: (item: T, index: number) => boolean): T | undefined {
        if (!predicate) return this[this.length - 1];
        for (let i = this.length - 1; i >= 0; i--) {
            if (predicate(this[i], i)) return this[i];
        }
        return undefined;
    }

    /**
     * Return items that do NOT match the predicate (inverse of filter).
     */
    reject(predicate: (item: T, index: number) => boolean): Collection<T> {
        return this.filter((item, i) => !predicate(item, i));
    }

    /**
     * Filter items where a key equals a value.
     */
    where(key: string, value: unknown): Collection<T> {
        return this.filter((item) => this._extractKey(item, key) === value);
    }

    /**
     * Filter items where a key's value is in the given set.
     */
    whereIn(key: string, values: unknown[]): Collection<T> {
        const set = new Set(values);
        return this.filter((item) => set.has(this._extractKey(item, key)));
    }

    /**
     * Check if any item matches. Accepts a predicate, or a key + value pair.
     */
    contains(predicateOrKey: ((item: T, index: number) => boolean) | string, value?: unknown): boolean {
        if (typeof predicateOrKey === "function") {
            for (let i = 0; i < this.length; i++) {
                if (predicateOrKey(this[i], i)) return true;
            }
            return false;
        }
        for (const item of this) {
            if (this._extractKey(item, predicateOrKey) === value) return true;
        }
        return false;
    }

    /**
     * Extract a single property from each item.
     *
     * @example
     * users.pluck("email") // ["alice@example.com", "bob@example.com"]
     */
    pluck<K extends string>(key: K): unknown[] {
        return this.map((item) => this._extractKey(item, key));
    }

    /**
     * Index items by a key, returning a Map.
     * If multiple items share a key, the last one wins.
     *
     * @example
     * users.keyBy("id") // Map { "u1" => User, "u2" => User }
     */
    keyBy<K extends string>(key: K): Map<unknown, T> {
        const map = new Map<unknown, T>();
        for (const item of this) {
            const k = this._extractKey(item, key);
            map.set(k, item);
        }
        return map;
    }

    /**
     * Group items by a key, returning a Map of arrays.
     *
     * @example
     * posts.groupBy("user_id") // Map { "u1" => [Post, Post], "u2" => [Post] }
     */
    groupBy<K extends string>(key: K): Map<unknown, Collection<T>> {
        const map = new Map<unknown, Collection<T>>();
        for (const item of this) {
            const k = this._extractKey(item, key);
            let group = map.get(k);
            if (!group) {
                group = new Collection<T>();
                map.set(k, group);
            }
            group.push(item);
        }
        return map;
    }

    /**
     * Return unique items. For objects, uses the provided key for comparison.
     * Without a key, uses strict equality.
     */
    unique(key?: string): Collection<T> {
        if (!key) {
            return Collection.from(new Set(this));
        }
        const seen = new Set<unknown>();
        const result = new Collection<T>();
        for (const item of this) {
            const k = this._extractKey(item, key);
            if (!seen.has(k)) {
                seen.add(k);
                result.push(item);
            }
        }
        return result;
    }

    /**
     * Split collection into two based on a predicate.
     * Returns [truthy, falsy] as a tuple of Collections.
     *
     * @example
     * const [active, inactive] = users.partition(u => u.get("status") === "active")
     */
    partition(predicate: (item: T, index: number) => boolean): [Collection<T>, Collection<T>] {
        const pass = new Collection<T>();
        const fail = new Collection<T>();
        for (let i = 0; i < this.length; i++) {
            if (predicate(this[i], i)) pass.push(this[i]);
            else fail.push(this[i]);
        }
        return [pass, fail];
    }

    /**
     * Sum a numeric property across all items.
     *
     * @example
     * orders.sum("total") // 1234.56
     */
    sum(key: string): number {
        let total = 0;
        for (const item of this) {
            const v = this._extractKey(item, key);
            if (typeof v === "number") total += v;
        }
        return total;
    }

    /**
     * Get min value of a numeric property.
     */
    min(key: string): number | null {
        let result: number | null = null;
        for (const item of this) {
            const v = this._extractKey(item, key);
            if (typeof v === "number" && (result === null || v < result)) result = v;
        }
        return result;
    }

    /**
     * Get max value of a numeric property.
     */
    max(key: string): number | null {
        let result: number | null = null;
        for (const item of this) {
            const v = this._extractKey(item, key);
            if (typeof v === "number" && (result === null || v > result)) result = v;
        }
        return result;
    }

    /**
     * Get average of a numeric property.
     */
    avg(key: string): number | null {
        // Divide by the count of NUMERIC values, not the full length - sum() skips
        // null/non-numeric entries, so dividing by length would understate the mean
        // whenever a row's key is null/missing (matches Laravel's avg()).
        let total = 0;
        let n = 0;
        for (const item of this) {
            const v = this._extractKey(item, key);
            if (typeof v === "number") {
                total += v;
                n++;
            }
        }
        return n === 0 ? null : total / n;
    }

    /**
     * Return items sorted by a key.
     */
    sortBy(key: string, dir: "asc" | "desc" = "asc"): Collection<T> {
        const sorted = Collection.from(this);
        sorted.sort((a, b) => {
            const va = this._extractKey(a, key);
            const vb = this._extractKey(b, key);
            if (va == null && vb == null) return 0;
            if (va == null) return dir === "asc" ? -1 : 1;
            if (vb == null) return dir === "asc" ? 1 : -1;
            if (va < vb) return dir === "asc" ? -1 : 1;
            if (va > vb) return dir === "asc" ? 1 : -1;
            return 0;
        });
        return sorted;
    }

    /**
     * Return items sorted by a key in descending order.
     */
    sortByDesc(key: string): Collection<T> {
        return this.sortBy(key, "desc");
    }

    /**
     * Iterate over items with a side-effect callback. Returns self for chaining.
     */
    each(fn: (item: T, index: number) => void): this {
        for (let i = 0; i < this.length; i++) {
            fn(this[i], i);
        }
        return this;
    }

    /**
     * Apply a side-effect to the collection itself without changing it. Returns self for chaining.
     */
    tap(fn: (collection: this) => void): this {
        fn(this);
        return this;
    }

    /**
     * Pass the collection to a callback and return the result.
     */
    pipe<U>(fn: (collection: this) => U): U {
        return fn(this);
    }

    /**
     * Override Array.map to return a Collection instead of a plain Array.
     */
    override map<U>(callbackfn: (value: T, index: number, array: T[]) => U, thisArg?: unknown): Collection<U> {
        const result = new Collection<U>();
        for (let i = 0; i < this.length; i++) {
            result.push(callbackfn.call(thisArg, this[i], i, this));
        }
        return result;
    }

    /**
     * Override Array.filter to return a Collection instead of a plain Array.
     */
    override filter<S extends T>(predicate: (value: T, index: number, array: T[]) => value is S, thisArg?: unknown): Collection<S>;
    override filter(predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: unknown): Collection<T>;
    override filter(predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: unknown): Collection<T> {
        const result = new Collection<T>();
        for (let i = 0; i < this.length; i++) {
            if (predicate.call(thisArg, this[i], i, this)) {
                result.push(this[i]);
            }
        }
        return result;
    }

    /**
     * Override Array.flatMap to return a Collection instead of a plain Array.
     */
    override flatMap<U, This = undefined>(
        callback: (this: This, value: T, index: number, array: T[]) => U | ReadonlyArray<U>,
        thisArg?: This,
    ): Collection<U> {
        const result = new Collection<U>();
        for (let i = 0; i < this.length; i++) {
            const mapped = callback.call(thisArg as This, this[i], i, this);
            if (Array.isArray(mapped)) {
                for (const item of mapped) result.push(item);
            } else {
                result.push(mapped as U);
            }
        }
        return result;
    }

    /**
     * Take the first n items. If n is negative, take the last |n| items.
     */
    take(count: number): Collection<T> {
        if (count < 0) {
            return Collection.from(this.slice(count));
        }
        return Collection.from(this.slice(0, count));
    }

    /**
     * Skip the first n items.
     */
    skip(count: number): Collection<T> {
        return Collection.from(this.slice(count));
    }

    /**
     * Group items by a callback that returns [key, value] pairs.
     * Returns a Map of key → Collection of values.
     */
    mapToGroups<K, V>(fn: (item: T, index: number) => [K, V]): Map<K, Collection<V>> {
        const map = new Map<K, Collection<V>>();
        for (let i = 0; i < this.length; i++) {
            const [key, value] = fn(this[i], i);
            let group = map.get(key);
            if (!group) {
                group = new Collection<V>();
                map.set(key, group);
            }
            group.push(value);
        }
        return map;
    }

    /**
     * Chunk the collection into smaller collections of the given size.
     */
    chunk(size: number): Collection<Collection<T>> {
        // Guard size <= 0 (and NaN): `i += 0` never advances → infinite loop that
        // hangs the Worker. Coerce to a minimum step of 1.
        const step = size >= 1 ? Math.floor(size) : 1;
        const result = new Collection<Collection<T>>();
        for (let i = 0; i < this.length; i += step) {
            result.push(Collection.from(this.slice(i, i + step)));
        }
        return result;
    }

    /**
     * Serialize all items to plain objects.
     * Calls toObject() on each item if available, otherwise returns the item as-is.
     */
    toArray(): Record<string, unknown>[] {
        return this.map((item) => {
            if (typeof item === "object" && item !== null && "toObject" in item) {
                return (item as Serializable).toObject() as Record<string, unknown>;
            }
            return item as unknown as Record<string, unknown>;
        });
    }

    /**
     * Extract a key value from an item (supports model.get() and plain objects).
     */
    private _extractKey(item: T, key: string): unknown {
        if (typeof item === "object" && item !== null) {
            if ("get" in item && typeof (item as Gettable).get === "function") {
                return (item as Gettable).get(key);
            }
            return (item as Record<string, unknown>)[key];
        }
        return undefined;
    }
}
