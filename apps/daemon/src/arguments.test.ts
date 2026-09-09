import { describe, expect, test } from "bun:test";

import { parseDaemonArguments, USAGE } from "./arguments.ts";

describe("janelad's command line", () => {
  test("refuses an argument it does not parse, naming it", () => {
    // The whole point of #49: `--socket /tmp/dev.sock` used to be ignored, and the
    // daemon bound the real user socket while a developer believed otherwise.
    expect(parseDaemonArguments(["--socket", "/tmp/x"])).toEqual({
      kind: "usage",
      problem: 'unknown argument "--socket"',
    });
    expect(parseDaemonArguments(["--foreground", "-v"])).toEqual({
      kind: "usage",
      problem: 'unknown argument "-v"',
    });
  });

  test("--version wins", () => {
    // CI runs `./janelad --version` from an empty directory to prove the compiled
    // binary carries its own runtime. It must never start serving instead.
    expect(parseDaemonArguments(["--foreground", "--version"])).toEqual({ kind: "version" });
    expect(parseDaemonArguments(["--version"])).toEqual({ kind: "version" });
  });

  test("serves in the foreground", () => {
    expect(parseDaemonArguments(["--foreground"])).toEqual({ kind: "serve", foreground: true });
    expect(parseDaemonArguments([])).toEqual({ kind: "serve", foreground: false });
    // A repeat is not a mistake worth refusing.
    expect(parseDaemonArguments(["--foreground", "--foreground"])).toEqual({
      kind: "serve",
      foreground: true,
    });
  });

  test("USAGE names the isolation recipe, not --socket as an option", () => {
    expect(USAGE).toContain("HOME");
    expect(USAGE).not.toContain("[--socket");
  });
});
