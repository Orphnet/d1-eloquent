import type {TD1ExecOptions, TD1JsonRaw, TD1JsonResult} from "./types";

// ─── Structured error ────────────────────────────────────────────────────────

export class D1ExecuteError extends Error {
  constructor(
    public readonly command: string,
    public readonly db: string,
    public readonly stderr: string,
    public readonly exitCode: number,
  ) {
    super(
      `wrangler d1 execute failed (code ${exitCode})\n` +
      `db=${db}\n` +
      `command:\n${command}\n\n` +
      stderr,
    );
    this.name = "D1ExecuteError";
  }
}

// ─── JSON extraction ─────────────────────────────────────────────────────────

/**
 * Bracket-matching JSON extraction.
 *
 * Scans for the first `[` or `{` in the output, then counts matching
 * brackets to find the complete JSON payload. Handles any amount of
 * wrangler noise (warnings, progress bars, ANSI codes) before/after
 * the JSON body.
 */
export const extractJson = (raw: string): unknown | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Fast path: entire output is valid JSON
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to bracket matching
  }

  // Find first JSON-opening character
  const startIdx = findJsonStart(trimmed);
  if (startIdx === -1) return null;

  const openChar = trimmed[startIdx];
  const closeChar = openChar === "[" ? "]" : "}";

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < trimmed.length; i++) {
    const ch = trimmed[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\") {
      if (inString) escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        const candidate = trimmed.slice(startIdx, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          // Matched brackets but invalid JSON — keep scanning
          return null;
        }
      }
    }
  }

  return null;
};

/** Find index of first `[` or `{` that is likely a JSON start (not an ANSI escape). */
const findJsonStart = (s: string): number => {
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{") return i;
    // `[` could be an ANSI escape (ESC[...) — skip if preceded by ESC (\x1b)
    if (ch === "[" && (i === 0 || s[i - 1] !== "\x1b")) return i;
  }
  return -1;
};

// ─── Result normalization ────────────────────────────────────────────────────

const normalizeD1 = (raw: unknown | null): TD1JsonResult => {
  if (!raw) return {};

  // Single result object
  if (!Array.isArray(raw)) return raw as TD1JsonResult;

  // Array of results from multi-statement execution
  const results = raw as TD1JsonResult[];
  const mergedResults = results.flatMap((r) => r.results ?? []);
  const success = results.every((r) => r.success !== false);
  const lastMeta = results.length > 0 ? (results[results.length - 1]?.meta ?? undefined) : undefined;

  return {
    success,
    meta: lastMeta,
    results: mergedResults.length > 0 ? mergedResults : undefined,
  };
};

// ─── Subprocess execution ────────────────────────────────────────────────────

const spawnAsync = async (cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> => {
  // Import child_process lazily so this module's STATIC graph stays Worker-safe:
  // `Factory` (and thus the `/cli` barrel) reaches d1Execute, and a consuming app
  // that imports anything from `/cli` into its Worker (or tests it under
  // vitest-pool-workers) must not fail to bundle `node:child_process`. It's only
  // resolved here, at call time, which never happens in a Worker.
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
};

// ─── Public API ──────────────────────────────────────────────────────────────

export const d1Execute = async (opts: TD1ExecOptions): Promise<TD1JsonResult> => {
  const flags: string[] = [];
  if (opts.local) flags.push("--local");
  if (opts.remote) flags.push("--remote");
  flags.push("--json");

  const { stdout, stderr, code } = await spawnAsync(
    "wrangler",
    ["d1", "execute", opts.dbName, ...flags, "--command", opts.command],
  );

  if (code !== 0) {
    throw new D1ExecuteError(opts.command, opts.dbName, stderr || stdout, code);
  }

  const raw = extractJson(stdout);
  return normalizeD1(raw);
};
