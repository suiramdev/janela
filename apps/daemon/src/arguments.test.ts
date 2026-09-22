import { describe, expect, test } from "bun:test";

import { parseDaemonArguments, USAGE } from "./arguments.ts";

describe("janelad's command line", () => {
  test("refuses an argument it does not parse, naming it", () => {
    expect(parseDaemonArguments(["--socket", "/tmp/x"])).toEqual({
      kind: "usage",
      problem: 'unknown argument "--socket"',
    });

    expect(parseDaemonArguments(["--foreground", "-v"])).toEqual({
      kind: "usage",
      problem: 'unknown argument "-v"',
    });
  });

  test("--version wins wherever it appears, so probing the binary never starts serving", () => {
    expect(parseDaemonArguments(["--foreground", "--version"])).toEqual({ kind: "version" });
    expect(parseDaemonArguments(["--version"])).toEqual({ kind: "version" });
  });

  test("serves in the foreground, and a repeated flag is not a refusal", () => {
    expect(parseDaemonArguments(["--foreground"])).toEqual({ kind: "serve", foreground: true });
    expect(parseDaemonArguments([])).toEqual({ kind: "serve", foreground: false });
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
