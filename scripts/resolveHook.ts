/**
 * Node ESM resolution hook (registered via `node:module` `register`) that lets
 * project seeders/migrations/models use EXTENSIONLESS relative imports under
 * plain Node — e.g. `import { User } from "../models/User"` resolving to
 * `../models/User.ts`.
 *
 * Node's native ESM loader requires explicit extensions on relative specifiers
 * (it throws ERR_MODULE_NOT_FOUND otherwise); Bun and tsx do not. The CLI loads
 * user files via dynamic `import()` under the `#!/usr/bin/env node` bin, so
 * without this hook every extensionless import in a seeder → factory → model
 * chain fails per hop. The hook is a no-op on the happy path: it only runs
 * *after* a resolution failure, and is skipped entirely under Bun (see
 * installResolveHook).
 *
 * Self-contained — imports only `node:` builtins so tsup emits it standalone,
 * which is required because `register()` loads it by URL in a separate thread.
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const CANDIDATE_EXTS = ["ts", "tsx", "mts", "cts", "js", "mjs", "cjs", "jsx"] as const;

interface ResolveContext {
    parentURL?: string;
    conditions?: string[];
    importAttributes?: Record<string, string>;
}
interface ResolveResult {
    url: string;
    format?: string | null;
    shortCircuit?: boolean;
}
type NextResolve = (specifier: string, context: ResolveContext) => Promise<ResolveResult>;

/** Only relative / absolute / file: specifiers are candidates for extension probing. */
function isPathLike(specifier: string): boolean {
    return (
        specifier.startsWith("./") ||
        specifier.startsWith("../") ||
        specifier.startsWith("/") ||
        specifier.startsWith("file:")
    );
}

/** Errors that indicate a bare path that might resolve once an extension/index is added. */
const RETRYABLE = new Set(["ERR_MODULE_NOT_FOUND", "ERR_UNSUPPORTED_DIR_IMPORT"]);

export async function resolve(
    specifier: string,
    context: ResolveContext,
    nextResolve: NextResolve,
): Promise<ResolveResult> {
    // Bare specifiers (node builtins, packages) and already-extensioned paths
    // take the default path untouched.
    if (!isPathLike(specifier)) return nextResolve(specifier, context);

    try {
        return await nextResolve(specifier, context);
    } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        if (!code || !RETRYABLE.has(code)) throw err;

        const parent = context.parentURL ?? pathToFileURL(`${process.cwd()}/`).href;
        let basePath: string;
        try {
            basePath = fileURLToPath(new URL(specifier, parent));
        } catch {
            throw err;
        }

        // Probe `<base>.<ext>` first, then `<base>/index.<ext>`.
        for (const ext of CANDIDATE_EXTS) {
            const candidate = `${basePath}.${ext}`;
            if (existsSync(candidate)) return nextResolve(pathToFileURL(candidate).href, context);
        }
        for (const ext of CANDIDATE_EXTS) {
            const candidate = `${basePath}/index.${ext}`;
            if (existsSync(candidate)) return nextResolve(pathToFileURL(candidate).href, context);
        }
        throw err;
    }
}
