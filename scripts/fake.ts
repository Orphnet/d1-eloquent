/**
 * Lightweight zero-dependency faker for d1-eloquent seeders.
 * Seeded PRNG (mulberry32) for reproducible runs.
 */

// ── PRNG ────────────────────────────────────────────────────────────────────

const mulberry32 = (seed: number): (() => number) => {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// ── Data pools ──────────────────────────────────────────────────────────────

const FIRST_NAMES = [
  "Alice", "Bob", "Carol", "Dave", "Eve", "Frank", "Grace", "Hank",
  "Iris", "Jack", "Karen", "Leo", "Mona", "Nick", "Olivia", "Paul",
  "Quinn", "Rita", "Sam", "Tina", "Uma", "Vic", "Wendy", "Xander",
  "Yara", "Zane", "Aria", "Blake", "Chloe", "Dylan", "Elena", "Finn",
  "Gina", "Hugo", "Isla", "Jake", "Kira", "Liam", "Maya", "Noah",
  "Opal", "Petra", "Reed", "Sara", "Troy", "Vera", "Will", "Zara",
];

const LAST_NAMES = [
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller",
  "Davis", "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez",
  "Wilson", "Anderson", "Thomas", "Taylor", "Moore", "Jackson", "Martin",
  "Lee", "Perez", "Thompson", "White", "Harris", "Sanchez", "Clark",
  "Ramirez", "Lewis", "Robinson", "Walker", "Young", "Allen", "King",
  "Wright", "Scott", "Torres", "Nguyen", "Hill", "Flores", "Green",
  "Adams", "Nelson", "Baker", "Hall", "Rivera", "Campbell", "Mitchell",
];

const LOREM_WORDS = [
  "lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing",
  "elit", "sed", "do", "eiusmod", "tempor", "incididunt", "ut", "labore",
  "et", "dolore", "magna", "aliqua", "enim", "ad", "minim", "veniam",
  "quis", "nostrud", "exercitation", "ullamco", "laboris", "nisi",
  "aliquip", "ex", "ea", "commodo", "consequat", "duis", "aute", "irure",
  "in", "reprehenderit", "voluptate", "velit", "esse", "cillum", "fugiat",
  "nulla", "pariatur", "excepteur", "sint", "occaecat", "cupidatat",
  "non", "proident", "sunt", "culpa", "qui", "officia", "deserunt",
  "mollit", "anim", "id", "est", "laborum",
];

const DOMAINS = [
  "example.com", "test.org", "demo.net", "sample.io", "fake.dev",
  "mail.test", "inbox.example", "seed.local",
];

const PASSWORD_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*";

const COMPANY_SUFFIXES = ["Inc", "LLC", "Corp", "Ltd", "Co", "Group", "Solutions", "Labs", "Systems", "Tech"];

const STREET_SUFFIXES = ["St", "Ave", "Blvd", "Dr", "Ln", "Rd", "Way", "Ct", "Pl", "Cir"];

// ── Date formatting ─────────────────────────────────────────────────────────

const DAY_NAMES_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * Format a Date using PHP-style tokens.
 *
 * Supported tokens:
 * - `Y` — 4-digit year (2025)
 * - `y` — 2-digit year (25)
 * - `m` — 2-digit month (01–12)
 * - `n` — month without leading zero (1–12)
 * - `F` — full month name (January)
 * - `M` — short month name (Jan)
 * - `d` — 2-digit day (01–31)
 * - `j` — day without leading zero (1–31)
 * - `D` — short day name (Mon)
 * - `l` — full day name (Monday)
 * - `H` — 2-digit hour 24h (00–23)
 * - `h` — 2-digit hour 12h (01–12)
 * - `G` — hour 24h no pad (0–23)
 * - `g` — hour 12h no pad (1–12)
 * - `i` — 2-digit minute (00–59)
 * - `s` — 2-digit second (00–59)
 * - `A` — AM/PM
 * - `a` — am/pm
 * - `U` — Unix timestamp (seconds)
 * - `T` — timezone abbreviation (UTC)
 * - `c` — ISO 8601 date
 */
export const formatDate = (date: Date, format: string): string => {
  const tokens: Record<string, () => string> = {
    Y: () => String(date.getUTCFullYear()),
    y: () => String(date.getUTCFullYear()).slice(-2),
    m: () => pad2(date.getUTCMonth() + 1),
    n: () => String(date.getUTCMonth() + 1),
    F: () => MONTH_NAMES[date.getUTCMonth()],
    M: () => MONTH_NAMES_SHORT[date.getUTCMonth()],
    d: () => pad2(date.getUTCDate()),
    j: () => String(date.getUTCDate()),
    D: () => DAY_NAMES_SHORT[date.getUTCDay()],
    l: () => DAY_NAMES[date.getUTCDay()],
    H: () => pad2(date.getUTCHours()),
    h: () => pad2(((date.getUTCHours() + 11) % 12) + 1),
    G: () => String(date.getUTCHours()),
    g: () => String(((date.getUTCHours() + 11) % 12) + 1),
    i: () => pad2(date.getUTCMinutes()),
    s: () => pad2(date.getUTCSeconds()),
    A: () => (date.getUTCHours() < 12 ? "AM" : "PM"),
    a: () => (date.getUTCHours() < 12 ? "am" : "pm"),
    U: () => String(Math.floor(date.getTime() / 1000)),
    T: () => "UTC",
    c: () => date.toISOString(),
  };

  let result = "";
  for (let i = 0; i < format.length; i++) {
    const ch = format[i];
    if (ch === "\\" && i + 1 < format.length) {
      result += format[++i];
    } else if (tokens[ch]) {
      result += tokens[ch]();
    } else {
      result += ch;
    }
  }
  return result;
};

// ── Fake class ──────────────────────────────────────────────────────────────

export type TDateOpts = {
  /** PHP-style format string. Defaults to ISO 8601. */
  format?: string;
  /** Earliest date. Default: 1 year ago. */
  from?: Date;
  /** Latest date. Default: now. */
  to?: Date;
};

export class Fake {
  private _rng: () => number;

  constructor(seed?: number) {
    this._rng = mulberry32(seed ?? Date.now());
  }

  /** Reset the PRNG seed for reproducible output. */
  seed(s: number): this {
    this._rng = mulberry32(s);
    return this;
  }

  // ── Primitives ──────────────────────────────────────────────────────────

  /** Random float in [0, 1). */
  random(): number {
    return this._rng();
  }

  /** Random integer in [min, max] inclusive. */
  int(min: number = 0, max: number = 2147483647): number {
    return Math.floor(this._rng() * (max - min + 1)) + min;
  }

  /** Random float in [min, max). */
  float(min: number = 0, max: number = 1, decimals: number = 4): number {
    const raw = this._rng() * (max - min) + min;
    const factor = 10 ** decimals;
    return Math.round(raw * factor) / factor;
  }

  /** Random boolean with optional probability of true (0–1). */
  boolean(probability: number = 0.5): boolean {
    return this._rng() < probability;
  }

  /** Pick a random element from an array. */
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this._rng() * arr.length)];
  }

  /** Pick N unique random elements from an array. */
  pickMany<T>(arr: readonly T[], count: number): T[] {
    const copy = [...arr];
    const n = Math.min(count, copy.length);
    const result: T[] = [];
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(this._rng() * copy.length);
      result.push(copy.splice(idx, 1)[0]);
    }
    return result;
  }

  /** Shuffle an array (Fisher–Yates). Returns a new array. */
  shuffle<T>(arr: readonly T[]): T[] {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(this._rng() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  // ── Identity ────────────────────────────────────────────────────────────

  firstName(): string {
    return this.pick(FIRST_NAMES);
  }

  lastName(): string {
    return this.pick(LAST_NAMES);
  }

  /** Full name: "Alice Smith". */
  name(): string {
    return `${this.firstName()} ${this.lastName()}`;
  }

  /** Email address derived from name parts. */
  email(domain?: string): string {
    const first = this.firstName().toLowerCase();
    const last = this.lastName().toLowerCase();
    const sep = this.pick([".", "_", ""]);
    const suffix = this.int(1, 999);
    const d = domain ?? this.pick(DOMAINS);
    return `${first}${sep}${last}${suffix}@${d}`;
  }

  /** Username: lowercase + digits. */
  username(): string {
    const first = this.firstName().toLowerCase();
    return `${first}${this.int(10, 9999)}`;
  }

  // ── Strings ─────────────────────────────────────────────────────────────

  uuid(): string {
    return crypto.randomUUID();
  }

  /** Random password of given length. */
  password(length: number = 16): string {
    let pw = "";
    for (let i = 0; i < length; i++) {
      pw += PASSWORD_CHARS[Math.floor(this._rng() * PASSWORD_CHARS.length)];
    }
    return pw;
  }

  /** Random hex string of given byte length. */
  hex(bytes: number = 16): string {
    let h = "";
    for (let i = 0; i < bytes; i++) {
      h += Math.floor(this._rng() * 256).toString(16).padStart(2, "0");
    }
    return h;
  }

  /** URL-safe slug. */
  slug(wordCount: number = 3): string {
    return this.words(wordCount).join("-");
  }

  /** Random URL. */
  url(path?: string): string {
    const proto = this.pick(["https"]);
    const domain = this.pick(DOMAINS);
    const p = path ?? `/${this.slug(2)}`;
    return `${proto}://${domain}${p}`;
  }

  // ── Text ────────────────────────────────────────────────────────────────

  /** Array of random lorem words. */
  words(count: number = 5): string[] {
    return Array.from({ length: count }, () => this.pick(LOREM_WORDS));
  }

  /** Capitalised sentence of N words. */
  sentence(wordCount?: number): string {
    const n = wordCount ?? this.int(5, 12);
    const w = this.words(n);
    w[0] = w[0][0].toUpperCase() + w[0].slice(1);
    return w.join(" ") + ".";
  }

  /** Multiple sentences forming a paragraph. */
  paragraph(sentenceCount?: number): string {
    const n = sentenceCount ?? this.int(3, 6);
    return Array.from({ length: n }, () => this.sentence()).join(" ");
  }

  /** Multiple paragraphs separated by newlines. */
  paragraphs(count: number = 3): string {
    return Array.from({ length: count }, () => this.paragraph()).join("\n\n");
  }

  // ── Business ────────────────────────────────────────────────────────────

  /** Company name: "LastName Suffix". */
  company(): string {
    return `${this.lastName()} ${this.pick(COMPANY_SUFFIXES)}`;
  }

  /** Phone number: +1-XXX-XXX-XXXX. */
  phone(): string {
    return `+1-${this.int(200, 999)}-${this.int(100, 999)}-${this.int(1000, 9999)}`;
  }

  /** Street address. */
  address(): string {
    return `${this.int(100, 9999)} ${this.lastName()} ${this.pick(STREET_SUFFIXES)}`;
  }

  // ── Dates ───────────────────────────────────────────────────────────────

  /**
   * Random date between `from` and `to`.
   *
   * Returns an ISO string by default, or a formatted string if `format` is provided.
   *
   * Uses PHP-style format tokens: `Y`, `m`, `d`, `H`, `i`, `s`, `D`, `M`, `F`, etc.
   * Escape literal characters with `\\` (e.g., `Y\\-m\\-d`).
   *
   * @example
   * fake.date()                          // "2025-08-14T09:32:11.000Z"
   * fake.date({ format: "Y-m-d" })       // "2025-08-14"
   * fake.date({ format: "d/m/Y H:i" })   // "14/08/2025 09:32"
   * fake.date({ format: "D, d M Y" })    // "Thu, 14 Aug 2025"
   */
  date(opts?: TDateOpts): string {
    const now = Date.now();
    const from = opts?.from?.getTime() ?? now - 365 * 24 * 60 * 60 * 1000;
    const to = opts?.to?.getTime() ?? now;
    const ts = Math.floor(this._rng() * (to - from)) + from;
    const d = new Date(ts);
    return opts?.format ? formatDate(d, opts.format) : d.toISOString();
  }

  /** ISO timestamp for "now" (useful for created_at/updated_at). */
  now(): string {
    return new Date().toISOString();
  }

  /** Past date (within the last N days, default 365). */
  pastDate(days: number = 365, format?: string): string {
    const now = new Date();
    const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    return this.date({ from, to: now, format });
  }

  /** Future date (within the next N days, default 365). */
  futureDate(days: number = 365, format?: string): string {
    const now = new Date();
    const to = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    return this.date({ from: now, to, format });
  }
}

/** Default singleton instance — call `fake.seed(n)` for reproducibility. */
export const fake = new Fake();
