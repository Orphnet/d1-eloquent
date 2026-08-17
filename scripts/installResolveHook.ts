/**
 * Register the extensionless-import resolution hook (see resolveHook.ts) for the
 * current process. Idempotent, and a no-op under Bun — which resolves
 * extensionless TS/JS natively and does not implement the node:module
 * customization hooks. Call once at CLI startup, before any user seeder /
 * migration / model is dynamically imported.
 */
import { register } from "node:module";

let installed = false;

export function installResolveHook(): void {
    if (installed) return;
    installed = true;

    // Bun resolves extensionless specifiers natively; nothing to register.
    if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") return;

    try {
        register(new URL("./resolveHook.js", import.meta.url));
    } catch {
        // Older Node without module.register (<20.6), or a sandbox that forbids
        // it — extensionful imports still work, so fail silently.
    }
}
