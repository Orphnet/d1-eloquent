import { EloquentException } from "./exceptions";

/**
 * Context handed to a custom key-generator function.
 */
export interface TKeyGeneratorContext {
    /** The model's table name. */
    table: string;
    /** The primary-key column the value is being generated for. */
    keyName: string;
}

/**
 * A custom primary-key generator. Receives the model context and returns the
 * key value to assign. Invoked only when the key is absent at insert time.
 */
export type TKeyGeneratorFn = (ctx: TKeyGeneratorContext) => string;

/**
 * Strategy controlling how a model's primary key is auto-generated on insert
 * when the caller does not supply one.
 *
 * - `'uuid'`   — RFC 4122 version-4 UUID via `crypto.randomUUID()` (default).
 * - `'uuidv7'` — RFC 9562 version-7 UUID: 48-bit millisecond timestamp prefix +
 *                random bits, so keys sort in creation order (better B-tree index
 *                locality than random v4 on large tables).
 * - `'ulid'`   — 26-char Crockford base32 ULID: 48-bit timestamp (10 chars) +
 *                80 random bits (16 chars); sortable to the millisecond, URL-safe,
 *                case-insensitive.
 * - `false`    — disabled: no key is generated and a missing key throws on insert
 *                (the pre-auto-id behaviour).
 * - a function — custom generator, see {@link TKeyGeneratorFn}.
 */
export type TKeyStrategy = "uuid" | "uuidv7" | "ulid" | false | TKeyGeneratorFn;

/** Crockford base32 alphabet (excludes I, L, O, U). */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Byte → 2-char lowercase hex lookup, for canonical UUID formatting. */
const HEX: string[] = [];
for (let i = 0; i < 256; i++) HEX.push((i + 0x100).toString(16).slice(1));

/**
 * Generate an RFC 4122 version-4 UUID. Thin wrapper over the platform
 * `crypto.randomUUID()` (present in the Workers runtime); exported so consumers
 * can mint ids for foreign keys or seeders without reaching for `crypto`.
 */
export function uuid(): string {
    return crypto.randomUUID();
}

/** Format 16 bytes as a canonical dashed UUID string. */
function formatUuid(b: Uint8Array): string {
    return (
        HEX[b[0]] + HEX[b[1]] + HEX[b[2]] + HEX[b[3]] + "-" +
        HEX[b[4]] + HEX[b[5]] + "-" +
        HEX[b[6]] + HEX[b[7]] + "-" +
        HEX[b[8]] + HEX[b[9]] + "-" +
        HEX[b[10]] + HEX[b[11]] + HEX[b[12]] + HEX[b[13]] + HEX[b[14]] + HEX[b[15]]
    );
}

/**
 * Generate an RFC 9562 version-7 UUID: a 48-bit big-endian Unix-millisecond
 * timestamp followed by 74 random bits (with the version and variant fields
 * set). v7 keys sort in creation order, giving far better index locality than
 * random v4 keys.
 */
export function uuidv7(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));

    // 48-bit millisecond timestamp, big-endian, into bytes[0..5].
    let ts = Date.now();
    for (let i = 5; i >= 0; i--) {
        bytes[i] = ts & 0xff;
        ts = Math.floor(ts / 256);
    }

    // Version 7 in the high nibble of byte 6; variant 0b10 in the top bits of byte 8.
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    return formatUuid(bytes);
}

/**
 * Generate a ULID: a 26-character Crockford-base32 string comprising a 48-bit
 * millisecond timestamp (10 chars) and 80 bits of randomness (16 chars). ULIDs
 * are lexicographically sortable by creation time (to the millisecond), URL-safe
 * and case-insensitive. Ordering of two ULIDs minted within the same millisecond
 * is not guaranteed (the random suffix is not monotonic).
 */
export function ulid(): string {
    let ts = Date.now();
    let time = "";
    for (let i = 0; i < 10; i++) {
        time = CROCKFORD[ts % 32] + time;
        ts = Math.floor(ts / 32);
    }

    const rnd = crypto.getRandomValues(new Uint8Array(16));
    let rand = "";
    for (let i = 0; i < 16; i++) rand += CROCKFORD[rnd[i] & 31];

    return time + rand;
}

/**
 * Resolve a non-`false` {@link TKeyStrategy} to a freshly generated key value.
 * The `false` strategy is handled by callers (which skip generation entirely).
 */
export function generateId(
    strategy: Exclude<TKeyStrategy, false>,
    ctx: TKeyGeneratorContext,
): string {
    if (typeof strategy === "function") return strategy(ctx);
    switch (strategy) {
        case "uuid":
            return uuid();
        case "uuidv7":
            return uuidv7();
        case "ulid":
            return ulid();
        default:
            throw new EloquentException(
                `Unknown keyStrategy: ${JSON.stringify(strategy)}. ` +
                    "Expected 'uuid', 'uuidv7', 'ulid', false, or a generator function.",
            );
    }
}
