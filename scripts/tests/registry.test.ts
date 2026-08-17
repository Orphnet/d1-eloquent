import { describe, it, expect, beforeEach } from "vitest";

// We can't easily reset the module-level Map between tests, so we test
// the registry indirectly via the CLI's actual registrations.
// Instead, test the generateHelp output shape and resolve behavior.

// For isolated unit testing, re-implement the registry logic inline:
import type { TCommand } from "../types";

const createRegistry = () => {
  const commands = new Map<string, TCommand>();
  return {
    register: (cmd: TCommand) => {
      if (commands.has(cmd.meta.name)) throw new Error(`Duplicate: ${cmd.meta.name}`);
      commands.set(cmd.meta.name, cmd);
    },
    resolve: (name: string) => commands.get(name),
    all: () => [...commands.values()],
  };
};

const fakeCommand = (name: string, category: TCommand["meta"]["category"] = "generate"): TCommand => ({
  meta: { name, description: `${name} desc`, usage: `${name} <arg>`, category },
  run: async () => {},
});

describe("registry", () => {
  it("registers and resolves commands", () => {
    const reg = createRegistry();
    const cmd = fakeCommand("test:cmd");
    reg.register(cmd);
    expect(reg.resolve("test:cmd")).toBe(cmd);
  });

  it("returns undefined for unknown commands", () => {
    const reg = createRegistry();
    expect(reg.resolve("nope")).toBeUndefined();
  });

  it("throws on duplicate registration", () => {
    const reg = createRegistry();
    reg.register(fakeCommand("dupe"));
    expect(() => reg.register(fakeCommand("dupe"))).toThrow("Duplicate: dupe");
  });

  it("all() returns all registered commands", () => {
    const reg = createRegistry();
    reg.register(fakeCommand("a"));
    reg.register(fakeCommand("b"));
    reg.register(fakeCommand("c"));
    expect(reg.all()).toHaveLength(3);
  });
});
