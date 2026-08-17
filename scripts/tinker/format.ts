import { inspect } from "node:util";
import type { QueryRecord } from "./d1Sqlite";

// ─── tiny ANSI palette (no deps) ─────────────────────────────────────────────
const useColor = process.stdout.isTTY === true;
const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  dim: wrap("2"),
  bold: wrap("1"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
  gray: wrap("90"),
};

type Modelish = { toObject?: () => Record<string, unknown> };

function isModel(v: unknown): v is Required<Modelish> {
  return !!v && typeof (v as Modelish).toObject === "function";
}

function toPlain(v: unknown): unknown {
  if (isModel(v)) return v.toObject();
  // Array.from (not .map) so a Collection becomes a plain array — otherwise
  // util.inspect prints the bundler-renamed class name (e.g. `_Collection(1)`).
  if (Array.isArray(v)) return Array.from(v, (x) => toPlain(x));
  return v;
}

/** Format any REPL result value for display. */
export function formatValue(value: unknown): string {
  if (value === undefined) return c.gray("undefined");
  const plain = toPlain(value);
  const body = inspect(plain, { colors: useColor, depth: 4, maxArrayLength: 100 });
  if (Array.isArray(plain)) {
    return `${body}\n${c.gray(`${plain.length} row${plain.length === 1 ? "" : "s"}`)}`;
  }
  return body;
}

/** Render an array of rows/models as an aligned ASCII table. */
export function renderTable(value: unknown): string {
  const rows = (Array.isArray(value) ? value : [value]).map(toPlain) as Record<string, unknown>[];
  if (rows.length === 0) return c.gray("(0 rows)");
  if (typeof rows[0] !== "object" || rows[0] === null) {
    return rows.map((r) => String(r)).join("\n");
  }

  const cols: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);

  const cell = (v: unknown): string => {
    if (v === null) return "∅";
    if (v === undefined) return "";
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  };

  const widths = cols.map((col) =>
    Math.min(40, Math.max(col.length, ...rows.map((r) => cell(r[col]).length))),
  );
  const clip = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + "…" : s.padEnd(w));

  const header = cols.map((col, i) => c.bold(clip(col, widths[i]))).join(c.gray(" │ "));
  const sep = widths.map((w) => "─".repeat(w)).join(c.gray("─┼─"));
  const body = rows
    .map((r) => cols.map((col, i) => clip(cell(r[col]), widths[i])).join(c.gray(" │ ")))
    .join("\n");

  return `${header}\n${c.gray(sep)}\n${body}\n${c.gray(`(${rows.length} row${rows.length === 1 ? "" : "s"})`)}`;
}

/** Format query-log records for `.sql` echo. */
export function formatQueries(records: QueryRecord[]): string {
  return records
    .map((r) => {
      const ms = c.gray(`${r.durationMs.toFixed(1)}ms`);
      const meta =
        r.kind === "run" ? c.gray(`${r.changes ?? 0} changed`) : c.gray(`${r.rows ?? 0} rows`);
      const params = r.params.length ? c.gray(` ‹${r.params.map((p) => JSON.stringify(p)).join(", ")}›`) : "";
      return `${c.cyan("sql")} ${r.sql}${params}  ${ms} ${meta}`;
    })
    .join("\n");
}
