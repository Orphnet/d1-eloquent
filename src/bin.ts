#!/usr/bin/env node
export {};

// Delegate entirely to the CLI dispatcher (handles help, command resolution, etc.)
await import("../scripts/cli.js");
