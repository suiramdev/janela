import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { DEFAULT_PORT, parseGatewayArguments } from "./arguments.ts";

describe("parseGatewayArguments", () => {
  test("no arguments serves the default port with no browser client", () => {
    expect(parseGatewayArguments([])).toEqual({
      kind: "serve",
      port: DEFAULT_PORT,
      webRoot: undefined,
    });
  });

  test("both flags are accepted and the web root becomes absolute", () => {
    expect(parseGatewayArguments(["--port", "8080", "--web-root", "apps/web/dist"])).toEqual({
      kind: "serve",
      port: 8080,
      webRoot: resolve("apps/web/dist"),
    });
  });

  test("a port outside 1-65535 is refused rather than clamped", () => {
    for (const value of ["0", "70000", "-1", "abc", "1.5", ""]) {
      const parsed = parseGatewayArguments(["--port", value]);

      expect(parsed.kind).toBe("usage");
    }
  });

  test("the lowest and highest ports are inside the range", () => {
    expect(parseGatewayArguments(["--port", "1"])).toEqual({
      kind: "serve",
      port: 1,
      webRoot: undefined,
    });

    expect(parseGatewayArguments(["--port", "65535"])).toEqual({
      kind: "serve",
      port: 65535,
      webRoot: undefined,
    });
  });

  test("a flag with no value is usage, not a default", () => {
    expect(parseGatewayArguments(["--port"])).toEqual({
      kind: "usage",
      problem: "--port needs a value",
    });

    expect(parseGatewayArguments(["--web-root"])).toEqual({
      kind: "usage",
      problem: "--web-root needs a value",
    });
  });

  test("an unknown argument names itself", () => {
    expect(parseGatewayArguments(["--socket", "/tmp/x"])).toEqual({
      kind: "usage",
      problem: 'unknown argument "--socket"',
    });
  });
});
