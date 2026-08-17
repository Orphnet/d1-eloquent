/**
 * Structured console output for seeders.
 *
 * Provides card boxes, tagged list lines, counters, progress bars,
 * in-place counters, step indicators, status messages, timers,
 * tables, progress tracking, and parallel group/seeder execution.
 */

import type { TSeeder, TSeederOpts } from "./types";

// ── Box-drawing characters ──────────────────────────────────────────────────

const BOX = {
  tl: "┌", tr: "┐", bl: "└", br: "┘",
  h: "─", v: "│",
  ml: "├", mr: "┤",
} as const;

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Visible character length (strips ANSI escape codes). */
const visLen = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, "").length;

/** Format milliseconds as human-readable duration. */
const fmtMs = (ms: number): string =>
  ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";

// ── Bar characters ──────────────────────────────────────────────────────────

const BAR_FILLED = "█";
const BAR_EMPTY = "░";

// ── Types ───────────────────────────────────────────────────────────────────

export type TCardRow = {
  label: string;
  value: string | string[];
};

export type TLogOpts = {
  /** Tag shown in brackets, e.g. "spectra". */
  tag?: string;
  /** Counter tuple [current, total], e.g. [15, 50]. */
  counter?: [current: number, total: number];
  /** Symbol before the message. Default: "✓". Use "✗" for errors, "…" for pending, etc. */
  symbol?: string;
  /** Indent depth (multiples of 2 spaces). Default: 1. */
  indent?: number;
};

export type TProgressTracker = {
  /** Increment progress by 1 and log the item. */
  tick(message?: string): void;
  /** Mark the group as successfully completed. */
  complete(message?: string): void;
  /** Mark the group as failed. */
  fail(message?: string): void;
  /** Current count. */
  readonly current: number;
  /** Total count. */
  readonly total: number;
};

export type TProgressOpts = {
  /** Tag shown in brackets. Defaults to label. */
  tag?: string;
  /** Indent depth (multiples of 2 spaces). Default: 1. */
  indent?: number;
  /** Only log every Nth tick. Useful for large batches. */
  every?: number;
};

export type TProgressBarTracker = {
  /** Increment by 1 (or N) and re-render the bar. */
  tick(n?: number): void;
  /** Mark complete with a final success line. */
  complete(message?: string): void;
  /** Mark failed with an error line. */
  fail(message?: string): void;
  /** Current count. */
  readonly current: number;
  /** Total count. */
  readonly total: number;
};

export type TProgressBarOpts = {
  /** Tag shown in brackets. */
  tag?: string;
  /** Bar width in characters. Default: 20. */
  width?: number;
  /** Indent depth (multiples of 2 spaces). Default: 1. */
  indent?: number;
};

export type TCounterTracker = {
  /** Increment by 1 and update the counter display. */
  tick(message?: string): void;
  /** Mark complete. */
  complete(message?: string): void;
  /** Mark failed. */
  fail(message?: string): void;
  /** Current count. */
  readonly current: number;
  /** Total count. */
  readonly total: number;
};

export type TCounterOpts = {
  /** Tag shown in brackets. */
  tag?: string;
  /** Indent depth (multiples of 2 spaces). Default: 1. */
  indent?: number;
};

export type TTimerHandle = {
  /** Stop the timer and print elapsed duration. */
  stop(message?: string): void;
  /** Get elapsed milliseconds without stopping. */
  readonly elapsed: number;
};

export type TGroupDef<T = unknown> = {
  /** Display name for this group. */
  name: string;
  /** Items to process in this group. */
  items: T[];
};

export type TGroupResult = {
  name: string;
  total: number;
  completed: number;
  failed: boolean;
  error?: unknown;
  durationMs: number;
};

export type TSeederResult = {
  name: string;
  failed: boolean;
  error?: unknown;
  durationMs: number;
};

export type TRunSeedersOpts = {
  /** Max seeders to run in parallel. Default: 4, max: 16. */
  concurrency?: number;
};

// ── SeederOutput ────────────────────────────────────────────────────────────

export class SeederOutput {
  private _indent: string;
  /** When true, in-place methods (progressBar, counter) fall back to line-per-tick. */
  private _parallel = false;

  constructor(indent: number = 2) {
    this._indent = " ".repeat(indent);
  }

  // ── Header / Block Title ─────────────────────────────────────────────

  /**
   * Print a block-style header (boxed title without card rows).
   *
   * ```
   * ┌───────────────────────────────────────┐
   * │  Orphnet — Credentials                │
   * └───────────────────────────────────────┘
   * ```
   */
  header(title: string, opts?: { width?: number }): void {
    const pad = 2;
    const titleLen = visLen(title);
    const innerWidth = Math.max((opts?.width ?? 0), titleLen + pad * 2);

    const hrFull = BOX.h.repeat(innerWidth);
    const sp = " ".repeat(pad);
    const titlePad = innerWidth - pad * 2 - titleLen;

    const lines = [
      `${this._indent}${BOX.tl}${hrFull}${BOX.tr}`,
      `${this._indent}${BOX.v}${sp}${BOLD}${title}${RESET}${" ".repeat(Math.max(titlePad, 0))}${sp}${BOX.v}`,
      `${this._indent}${BOX.bl}${hrFull}${BOX.br}`,
    ];

    console.log(lines.join("\n"));
  }

  /**
   * Print a block-style header with a separator, matching the card header style.
   *
   * ```
   * ┌───────────────────────────────────────┐
   * │  API Endpoints — 81 total             │
   * ├───────────────────────────────────────┤
   * ```
   *
   * Call `footer()` to close the block when done.
   */
  headerOpen(title: string, opts?: { width?: number }): { width: number } {
    const pad = 2;
    const titleLen = visLen(title);
    const innerWidth = Math.max((opts?.width ?? 0), titleLen + pad * 2);

    const hrFull = BOX.h.repeat(innerWidth);
    const sp = " ".repeat(pad);
    const titlePad = innerWidth - pad * 2 - titleLen;

    console.log(`${this._indent}${BOX.tl}${hrFull}${BOX.tr}`);
    console.log(`${this._indent}${BOX.v}${sp}${BOLD}${title}${RESET}${" ".repeat(Math.max(titlePad, 0))}${sp}${BOX.v}`);
    console.log(`${this._indent}${BOX.ml}${hrFull}${BOX.mr}`);

    return { width: innerWidth };
  }

  /**
   * Print a row inside an open block.
   */
  headerRow(text: string, blockWidth: number): void {
    const pad = 2;
    const sp = " ".repeat(pad);
    const textPad = blockWidth - pad * 2 - visLen(text);
    console.log(`${this._indent}${BOX.v}${sp}${text}${" ".repeat(Math.max(textPad, 0))}${sp}${BOX.v}`);
  }

  /**
   * Close an open block header.
   */
  footer(blockWidth: number): void {
    const hrFull = BOX.h.repeat(blockWidth);
    console.log(`${this._indent}${BOX.bl}${hrFull}${BOX.br}`);
  }

  // ── Card / Box ──────────────────────────────────────────────────────────

  /**
   * Print a boxed card with a title and key-value rows.
   *
   * Values can be a string or an array of strings (rendered as continuation lines).
   *
   * ```
   * ┌───────────────────────────────────────┐
   * │  Orphnet — Credentials                │
   * ├───────────────────────────────────────┤
   * │  Email:       dev@example.com         │
   * │  Password:    6983f298-1aef-4c        │
   * │  Workspaces:  owner (Orphnet)         │
   * │               admin (Acme Corp)       │
   * └───────────────────────────────────────┘
   * ```
   */
  card(title: string, rows: TCardRow[] | Record<string, string | string[]>): void {
    const normalized: TCardRow[] = Array.isArray(rows)
      ? rows
      : Object.entries(rows).map(([label, value]) => ({ label, value }));

    // Measure widths
    const pad = 2; // inner padding each side
    const labelWidth = Math.max(...normalized.map((r) => r.label.length));
    const gap = 2; // space between label: and value

    // Flatten all value lines to find max content width
    const allLines: string[] = [];
    for (const row of normalized) {
      const vals = Array.isArray(row.value) ? row.value : [row.value];
      for (const v of vals) allLines.push(v);
    }
    const valueWidth = Math.max(...allLines.map((v) => visLen(v)), 0);

    // Total inner width = pad + label + ":  " + value + pad
    // but also must fit the title
    const contentWidth = labelWidth + 1 + gap + valueWidth; // "Label:" + gap + value
    const titleWidth = visLen(title);
    const innerWidth = Math.max(contentWidth, titleWidth) + pad * 2;

    const hrFull = BOX.h.repeat(innerWidth);
    const sp = " ".repeat(pad);

    const lines: string[] = [];

    // Top border
    lines.push(`${this._indent}${BOX.tl}${hrFull}${BOX.tr}`);

    // Title
    const titlePad = innerWidth - pad * 2 - visLen(title);
    lines.push(`${this._indent}${BOX.v}${sp}${BOLD}${title}${RESET}${" ".repeat(Math.max(titlePad, 0))}${sp}${BOX.v}`);

    // Separator
    lines.push(`${this._indent}${BOX.ml}${hrFull}${BOX.mr}`);

    // Rows
    for (const row of normalized) {
      const vals = Array.isArray(row.value) ? row.value : [row.value];
      const labelStr = `${row.label}:`.padEnd(labelWidth + 1);

      for (let i = 0; i < vals.length; i++) {
        const prefix = i === 0
          ? `${labelStr}${" ".repeat(gap)}`
          : " ".repeat(labelWidth + 1 + gap);
        const line = `${prefix}${vals[i]}`;
        const linePad = innerWidth - pad * 2 - visLen(line);
        lines.push(`${this._indent}${BOX.v}${sp}${line}${" ".repeat(Math.max(linePad, 0))}${sp}${BOX.v}`);
      }
    }

    // Bottom border
    lines.push(`${this._indent}${BOX.bl}${hrFull}${BOX.br}`);

    console.log(lines.join("\n"));
  }

  // ── Tagged list lines ───────────────────────────────────────────────────

  /**
   * Print a tagged log line.
   *
   * ```
   * [spectra] ✓ User: Spectra Docs <docs@spectra.dev>
   * [spectra] 15/50 ✓ Workspace member: docs@spectra.dev as owner
   * ```
   */
  log(message: string, opts?: TLogOpts): void {
    const parts: string[] = [];
    const indent = " ".repeat((opts?.indent ?? 1) * 2);

    if (opts?.tag) {
      parts.push(`${DIM}[${opts.tag}]${RESET}`);
    }

    if (opts?.counter) {
      const [cur, total] = opts.counter;
      const width = String(total).length;
      parts.push(`${DIM}${String(cur).padStart(width)}/${total}${RESET}`);
    }

    const symbol = opts?.symbol ?? "✓";
    parts.push(`${GREEN}${symbol}${RESET}`);
    parts.push(message);

    console.log(`${indent}${parts.join(" ")}`);
  }

  // ── Progress tracking ─────────────────────────────────────────────────

  /**
   * Create a progress tracker for a batch of items.
   *
   * Each `tick()` logs a progress line. Use `every` to only log at intervals.
   *
   * ```ts
   * const tracker = output.progress("Seeding users", 50, { tag: "users" });
   * for (const user of users) {
   *   await insertUser(user);
   *   tracker.tick(`Created ${user.email}`);
   * }
   * tracker.complete();
   * ```
   *
   * With milestones (large batches):
   * ```ts
   * const tracker = output.progress("Rows", 5000, { tag: "rows", every: 500 });
   * ```
   */
  progress(label: string, total: number, opts?: TProgressOpts): TProgressTracker {
    let current = 0;
    const tag = opts?.tag ?? label;
    const indent = opts?.indent ?? 1;
    const every = opts?.every ?? 1;

    const tracker: TProgressTracker = {
      get current() { return current; },
      get total() { return total; },

      tick: (message?: string) => {
        current++;
        if (every <= 1 || current % every === 0 || current === total) {
          this.log(message ?? label, {
            tag,
            counter: [current, total],
            indent,
          });
        }
      },

      complete: (message?: string) => {
        const msg = message ?? `Done — ${current} items`;
        this.log(msg, {
          tag,
          counter: [current, total],
          symbol: "✓",
          indent,
        });
      },

      fail: (message?: string) => {
        const msg = message ?? `Failed at ${current}/${total}`;
        console.log(
          `${" ".repeat(indent * 2)}${DIM}[${tag}]${RESET} ${DIM}${String(current).padStart(String(total).length)}/${total}${RESET} ${RED}✗${RESET} ${msg}`
        );
      },
    };

    return tracker;
  }

  // ── Progress bar (in-place) ─────────────────────────────────────────────

  /**
   * Create a visual progress bar that updates in place.
   *
   * Falls back to line-per-tick when running inside `runGroups()` or `runSeeders()`.
   *
   * ```ts
   * const bar = output.progressBar("Seeding users", 100, { tag: "users" });
   * for (const user of users) {
   *   await insertUser(user);
   *   bar.tick();
   * }
   * bar.complete();
   * ```
   *
   * Output (in-place):
   * ```
   *   [users] [████████░░░░░░░░░░░░] 40/100  Seeding users
   *   [users] [████████████████████] 100/100 ✓ Done
   * ```
   */
  progressBar(label: string, total: number, opts?: TProgressBarOpts): TProgressBarTracker {
    let current = 0;
    const tag = opts?.tag;
    const barWidth = opts?.width ?? 20;
    const indent = " ".repeat((opts?.indent ?? 1) * 2);
    const isTTY = !this._parallel && process.stdout.isTTY;
    let lastFilled = -1;

    const render = (symbol: string, message: string, done: boolean) => {
      const filled = total > 0 ? Math.round((current / total) * barWidth) : 0;

      // In non-TTY / parallel mode, only print when the bar visually changes or on done
      if (!isTTY && !done && filled === lastFilled) return;
      lastFilled = filled;

      const empty = barWidth - filled;
      const bar = `${GREEN}${BAR_FILLED.repeat(filled)}${RESET}${DIM}${BAR_EMPTY.repeat(empty)}${RESET}`;
      const cw = String(total).length;
      const cnt = `${String(current).padStart(cw)}/${total}`;

      const tagStr = tag ? `${DIM}[${tag}]${RESET} ` : "";
      const line = `${indent}${tagStr}[${bar}] ${DIM}${cnt}${RESET} ${symbol} ${message}`;

      if (isTTY && !done) {
        process.stdout.write(`\r\x1b[K${line}`);
      } else {
        if (isTTY) process.stdout.write(`\r\x1b[K`);
        console.log(line);
      }
    };

    const tracker: TProgressBarTracker = {
      get current() { return current; },
      get total() { return total; },

      tick: (n?: number) => {
        current = Math.min(current + (n ?? 1), total);
        render(`${DIM}…${RESET}`, label, false);
      },

      complete: (message?: string) => {
        current = total;
        render(`${GREEN}✓${RESET}`, message ?? "Done", true);
      },

      fail: (message?: string) => {
        render(`${RED}✗${RESET}`, message ?? `Failed at ${current}/${total}`, true);
      },
    };

    return tracker;
  }

  // ── Counter (in-place compact) ──────────────────────────────────────────

  /**
   * Create a compact in-place counter.
   *
   * Falls back to line-per-tick when running inside `runGroups()` or `runSeeders()`.
   *
   * ```ts
   * const c = output.counter("Inserting rows", 500, { tag: "rows" });
   * for (const row of rows) {
   *   await insert(row);
   *   c.tick();
   * }
   * c.complete();
   * ```
   *
   * Output (in-place):
   * ```
   *   [rows] 247/500 … Inserting rows
   *   [rows] 500/500 ✓ Done
   * ```
   */
  counter(label: string, total: number, opts?: TCounterOpts): TCounterTracker {
    let current = 0;
    const tag = opts?.tag;
    const indent = " ".repeat((opts?.indent ?? 1) * 2);
    const isTTY = !this._parallel && process.stdout.isTTY;
    const cw = String(total).length;
    let lastPct = -1;

    const render = (symbol: string, message: string, done: boolean) => {
      // In non-TTY / parallel mode, only print every 5% change or on done
      if (!isTTY && !done) {
        const pct = total > 0 ? Math.floor((current / total) * 20) : 0;
        if (pct === lastPct) return;
        lastPct = pct;
      }

      const cnt = `${String(current).padStart(cw)}/${total}`;
      const tagStr = tag ? `${DIM}[${tag}]${RESET} ` : "";
      const line = `${indent}${tagStr}${DIM}${cnt}${RESET} ${symbol} ${message}`;

      if (isTTY && !done) {
        process.stdout.write(`\r\x1b[K${line}`);
      } else {
        if (isTTY) process.stdout.write(`\r\x1b[K`);
        console.log(line);
      }
    };

    const tracker: TCounterTracker = {
      get current() { return current; },
      get total() { return total; },

      tick: (message?: string) => {
        current = Math.min(current + 1, total);
        render(`${DIM}…${RESET}`, message ?? label, false);
      },

      complete: (message?: string) => {
        render(`${GREEN}✓${RESET}`, message ?? `Done — ${current} items`, true);
      },

      fail: (message?: string) => {
        render(`${RED}✗${RESET}`, message ?? `Failed at ${current}/${total}`, true);
      },
    };

    return tracker;
  }

  // ── Step indicator ──────────────────────────────────────────────────────

  /**
   * Print a step indicator for sequential phases.
   *
   * ```ts
   * output.step(1, 5, "Creating workspaces");
   * output.step(2, 5, "Seeding users");
   * ```
   *
   * Output:
   * ```
   *   [1/5] Creating workspaces
   *   [2/5] Seeding users
   * ```
   */
  step(current: number, total: number, message: string, opts?: { indent?: number }): void {
    const indent = " ".repeat((opts?.indent ?? 1) * 2);
    console.log(`${indent}${BOLD}[${current}/${total}]${RESET} ${message}`);
  }

  // ── Status messages ─────────────────────────────────────────────────────

  /**
   * Print an informational message.
   *
   * ```
   *   i Using cached workspace data
   * ```
   */
  info(message: string, opts?: { indent?: number }): void {
    const indent = " ".repeat((opts?.indent ?? 1) * 2);
    console.log(`${indent}${BLUE}i${RESET} ${message}`);
  }

  /**
   * Print a warning message.
   *
   * ```
   *   ! No admin user found, creating default
   * ```
   */
  warn(message: string, opts?: { indent?: number }): void {
    const indent = " ".repeat((opts?.indent ?? 1) * 2);
    console.log(`${indent}${YELLOW}!${RESET} ${YELLOW}${message}${RESET}`);
  }

  /**
   * Print a success message.
   *
   * ```
   *   ✓ Workspace seeded successfully
   * ```
   */
  success(message: string, opts?: { indent?: number }): void {
    const indent = " ".repeat((opts?.indent ?? 1) * 2);
    console.log(`${indent}${GREEN}✓${RESET} ${message}`);
  }

  /**
   * Print an error message.
   *
   * ```
   *   ✗ Failed to create billing records
   * ```
   */
  error(message: string, opts?: { indent?: number }): void {
    const indent = " ".repeat((opts?.indent ?? 1) * 2);
    console.log(`${indent}${RED}✗${RESET} ${RED}${message}${RESET}`);
  }

  // ── Timer ───────────────────────────────────────────────────────────────

  /**
   * Start a timer. Call `.stop()` to print the elapsed duration.
   *
   * ```ts
   * const t = output.timer("Seeding workspace");
   * // ... work ...
   * t.stop(); // →  ⏱ Seeding workspace (2.4s)
   * ```
   */
  timer(label: string, opts?: { indent?: number }): TTimerHandle {
    const start = Date.now();
    const indent = " ".repeat((opts?.indent ?? 1) * 2);

    return {
      get elapsed() { return Date.now() - start; },

      stop: (message?: string) => {
        const ms = Date.now() - start;
        const msg = message ?? label;
        console.log(`${indent}${DIM}⏱${RESET} ${msg} ${DIM}(${fmtMs(ms)})${RESET}`);
      },
    };
  }

  // ── Highlight ─────────────────────────────────────────────────────────

  /**
   * Print a prominent key-value highlight line.
   *
   * ```
   *   ★ Admin password: kX9#mPq2vR4z
   * ```
   */
  highlight(label: string, value: string): void {
    console.log(`${this._indent}${YELLOW}★${RESET} ${BOLD}${label}:${RESET} ${CYAN}${value}${RESET}`);
  }

  // ── Section headers ───────────────────────────────────────────────────

  /**
   * Print a section header with a divider.
   *
   * ```
   *   ── Seeding workspace: Orphnet ──
   * ```
   */
  section(title: string): void {
    console.log(`\n${this._indent}${DIM}──${RESET} ${BOLD}${title}${RESET} ${DIM}──${RESET}`);
  }

  /**
   * Print a blank line.
   */
  break(): void {
    console.log("");
  }

  // ── Summary ───────────────────────────────────────────────────────────

  /**
   * Print a summary table of counts.
   *
   * ```
   *   Table       Count
   *   users       50
   *   posts       150
   *   comments    300
   * ```
   */
  summary(counts: Record<string, number>): void {
    const entries = Object.entries(counts);
    if (entries.length === 0) return;

    const labelWidth = Math.max(...entries.map(([k]) => k.length), 5);
    console.log(`\n${this._indent}${BOLD}${"Table".padEnd(labelWidth)}  Count${RESET}`);
    for (const [table, count] of entries) {
      console.log(`${this._indent}${table.padEnd(labelWidth)}  ${DIM}${count}${RESET}`);
    }
    console.log("");
  }

  // ── Table ─────────────────────────────────────────────────────────────

  /**
   * Print a formatted table with headers and rows.
   *
   * ```ts
   * output.table(["Name", "Role", "Email"], [
   *   ["Alice", "admin",  "alice@example.com"],
   *   ["Bob",   "member", "bob@example.com"],
   * ]);
   * ```
   *
   * Output:
   * ```
   *   Name   Role    Email
   *   Alice  admin   alice@example.com
   *   Bob    member  bob@example.com
   * ```
   */
  table(headers: string[], rows: string[][]): void {
    if (headers.length === 0) return;

    const colWidths = headers.map((h, i) => {
      const dataMax = rows.reduce((max, row) => Math.max(max, visLen(row[i] ?? "")), 0);
      return Math.max(visLen(h), dataMax);
    });

    const gap = "  ";
    const headerLine = headers.map((h, i) => h.padEnd(colWidths[i])).join(gap);
    console.log(`\n${this._indent}${BOLD}${headerLine}${RESET}`);

    for (const row of rows) {
      const line = headers.map((_, i) => {
        const cell = row[i] ?? "";
        const padLen = colWidths[i] - visLen(cell);
        return `${cell}${" ".repeat(Math.max(padLen, 0))}`;
      }).join(gap);
      console.log(`${this._indent}${line}`);
    }
    console.log("");
  }

  // ── Group / Batch Execution ───────────────────────────────────────────

  /**
   * Run multiple groups of work in parallel with per-group progress tracking.
   *
   * Each group gets its own progress tracker. Groups run concurrently via
   * `Promise.allSettled`. Results include timing, counts, and error state.
   *
   * ```ts
   * const results = await output.runGroups(
   *   [
   *     { name: "Users",    items: userEndpoints },
   *     { name: "Posts",    items: postEndpoints },
   *     { name: "Comments", items: commentEndpoints },
   *   ],
   *   async (item, tracker) => {
   *     await testEndpoint(item);
   *     tracker.tick(`${item.method} ${item.path}`);
   *   },
   * );
   * ```
   */
  async runGroups<T>(
    groups: TGroupDef<T>[],
    runner: (item: T, tracker: TProgressTracker, groupName: string) => Promise<void>,
    opts?: { /** Max groups in parallel. Default: all groups, capped at 8. */ concurrency?: number; tag?: string },
  ): Promise<TGroupResult[]> {
    const totalItems = groups.reduce((sum, g) => sum + g.items.length, 0);

    // Print overview header
    const rows: Record<string, string> = {};
    for (const g of groups) {
      rows[g.name] = `${g.items.length} items`;
    }
    this.card(`Running ${groups.length} groups (${totalItems} items)`, rows);
    this.break();

    const MAX_GROUP_CONCURRENCY = 8;
    const concurrency = Math.min(opts?.concurrency ?? groups.length, MAX_GROUP_CONCURRENCY);

    // Enable parallel mode — disables in-place rendering
    this._parallel = true;

    const results: TGroupResult[] = [];
    const queue = [...groups];
    const running = new Set<Promise<void>>();

    const runGroup = async (group: TGroupDef<T>): Promise<TGroupResult> => {
      const tracker = this.progress(group.name, group.items.length, { tag: group.name });
      const start = Date.now();
      let completed = 0;
      let failed = false;
      let error: unknown;

      for (const item of group.items) {
        try {
          await runner(item, tracker, group.name);
          completed++;
        } catch (err) {
          failed = true;
          error = err;
          tracker.fail(err instanceof Error ? err.message : String(err));
          break;
        }
      }

      if (!failed) {
        tracker.complete();
      }

      return {
        name: group.name,
        total: group.items.length,
        completed,
        failed,
        error,
        durationMs: Date.now() - start,
      };
    };

    // Process with concurrency limit
    const processQueue = async () => {
      while (queue.length > 0 || running.size > 0) {
        while (queue.length > 0 && running.size < concurrency) {
          const group = queue.shift()!;
          const p = runGroup(group).then((result) => {
            results.push(result);
            running.delete(p);
          });
          running.add(p);
        }
        if (running.size > 0) {
          await Promise.race(running);
        }
      }
    };

    await processQueue();
    this._parallel = false;

    // Sort results to match input order
    const orderMap = new Map(groups.map((g, i) => [g.name, i]));
    results.sort((a, b) => (orderMap.get(a.name) ?? 0) - (orderMap.get(b.name) ?? 0));

    // Print results summary
    this.break();
    const resultRows: Record<string, string> = {};
    for (const r of results) {
      const symbol = r.failed ? `${RED}✗${RESET}` : `${GREEN}✓${RESET}`;
      resultRows[r.name] = `${symbol} ${r.completed}/${r.total}  ${DIM}(${fmtMs(r.durationMs)})${RESET}`;
    }
    this.card("Results", resultRows);

    return results;
  }

  // ── Parallel Seeder Execution ──────────────────────────────────────────

  /**
   * Run multiple seeders in parallel with per-seeder completion reporting.
   *
   * Each seeder runs independently. Seeders can use the full output API internally
   * (cards, progress, log, etc.) — output will interleave but each line is
   * self-identifying via tags.
   *
   * ```ts
   * import WorkspaceSeeder from "./WorkspaceSeeder";
   * import UserSeeder from "./UserSeeder";
   * import BillingSeeder from "./BillingSeeder";
   *
   * await output.runSeeders(
   *   [WorkspaceSeeder, UserSeeder, BillingSeeder],
   *   opts,
   *   { concurrency: 3 },
   * );
   * ```
   *
   * Output:
   * ```
   * ┌───────────────────────────────────────┐
   * │  Running 3 seeders                    │
   * ├───────────────────────────────────────┤
   * │  WorkspaceSeeder   pending            │
   * │  UserSeeder        pending            │
   * │  BillingSeeder     pending            │
   * └───────────────────────────────────────┘
   *
   *   [WorkspaceSeeder] ✓ Done (1.2s)
   *   [UserSeeder]      ✓ Done (3.4s)
   *   [BillingSeeder]   ✗ Failed (0.8s)
   *
   * ┌───────────────────────────────────────┐
   * │  Seeder Results                       │
   * ├───────────────────────────────────────┤
   * │  WorkspaceSeeder   ✓  (1.2s)         │
   * │  UserSeeder        ✓  (3.4s)         │
   * │  BillingSeeder     ✗  (0.8s)         │
   * └───────────────────────────────────────┘
   * ```
   */
  async runSeeders(
    seeders: TSeeder[],
    seederOpts: TSeederOpts,
    opts?: TRunSeedersOpts,
  ): Promise<TSeederResult[]> {
    // Print overview
    const overviewRows: Record<string, string> = {};
    for (const s of seeders) {
      overviewRows[s.name] = `${DIM}pending${RESET}`;
    }
    this.card(`Running ${seeders.length} seeders`, overviewRows);
    this.break();

    const MAX_SEEDER_CONCURRENCY = 16;
    const DEFAULT_SEEDER_CONCURRENCY = 4;
    const concurrency = Math.min(opts?.concurrency ?? DEFAULT_SEEDER_CONCURRENCY, MAX_SEEDER_CONCURRENCY);

    // Enable parallel mode
    this._parallel = true;

    const results: TSeederResult[] = [];
    const queue = [...seeders];
    const running = new Set<Promise<void>>();

    const runOne = async (seeder: TSeeder): Promise<TSeederResult> => {
      const start = Date.now();
      let failed = false;
      let error: unknown;

      try {
        await seeder.run(seederOpts);
      } catch (err) {
        failed = true;
        error = err;
      }

      const ms = Date.now() - start;

      if (failed) {
        this.log(`Failed ${DIM}(${fmtMs(ms)})${RESET}`, { tag: seeder.name, symbol: `${RED}✗${RESET}` });
      } else {
        this.log(`Done ${DIM}(${fmtMs(ms)})${RESET}`, { tag: seeder.name, symbol: `${GREEN}✓${RESET}` });
      }

      return { name: seeder.name, failed, error, durationMs: ms };
    };

    // Process with concurrency limit
    const processQueue = async () => {
      while (queue.length > 0 || running.size > 0) {
        while (queue.length > 0 && running.size < concurrency) {
          const seeder = queue.shift()!;
          const p = runOne(seeder).then((result) => {
            results.push(result);
            running.delete(p);
          });
          running.add(p);
        }
        if (running.size > 0) {
          await Promise.race(running);
        }
      }
    };

    await processQueue();
    this._parallel = false;

    // Sort results to match input order
    const orderMap = new Map(seeders.map((s, i) => [s.name, i]));
    results.sort((a, b) => (orderMap.get(a.name) ?? 0) - (orderMap.get(b.name) ?? 0));

    // Print results card
    this.break();
    const resultRows: Record<string, string> = {};
    for (const r of results) {
      const symbol = r.failed ? `${RED}✗${RESET}` : `${GREEN}✓${RESET}`;
      resultRows[r.name] = `${symbol}  ${DIM}(${fmtMs(r.durationMs)})${RESET}`;
    }
    this.card("Seeder Results", resultRows);

    // Print errors if any
    const failures = results.filter((r) => r.failed);
    if (failures.length > 0) {
      this.break();
      for (const f of failures) {
        this.error(`${f.name}: ${f.error instanceof Error ? f.error.message : String(f.error)}`);
      }
    }

    return results;
  }
}

/** Default singleton instance. */
export const output = new SeederOutput();
