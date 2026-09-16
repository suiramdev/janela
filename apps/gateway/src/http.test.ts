import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";

import { temporaryDirectory, type TemporaryDirectory } from "@janela/test-support";

import { NO_WEB_ROOT_TEXT, isAllowedOrigin, safePathname, staticResponse } from "./http.ts";

const INDEX_HTML = "<!doctype html><title>janela</title>";

const APP_JS = "export const janela = 1;\n";

async function builtClient(): Promise<TemporaryDirectory> {
  const directory = await temporaryDirectory("gateway-http");
  await mkdir(directory.join("assets"), { recursive: true });
  await writeFile(directory.join("index.html"), INDEX_HTML);
  await writeFile(directory.join("assets", "app.js"), APP_JS);

  return directory;
}

describe("isAllowedOrigin", () => {
  test("a same-origin browser and a non-browser client are allowed; a cross site is not", () => {
    const table: readonly [string | null, string | null, boolean][] = [
      [null, "localhost:1421", true],
      ["http://localhost:1421", "localhost:1421", true],
      ["https://x.ts.net", "x.ts.net", true],
      ["http://evil.example", "localhost:1421", false],
      ["not a url", "localhost:1421", false],
      ["http://localhost:1421", null, false],
    ];

    for (const [origin, host, allowed] of table) {
      expect(isAllowedOrigin(origin, host)).toBe(allowed);
    }
  });

  test("a matching host with a different port is a different origin", () => {
    expect(isAllowedOrigin("http://localhost:1421", "localhost:7411")).toBe(false);
  });
});

describe("safePathname", () => {
  test("the root is the client's entry point", () => {
    expect(safePathname("/")).toBe("/index.html");
    expect(safePathname("/assets/a.js")).toBe("/assets/a.js");
  });

  test("traversal, encoded traversal and NUL are refused", () => {
    expect(safePathname("/../etc/passwd")).toBeUndefined();
    expect(safePathname("/a/%2e%2e/b")).toBeUndefined();
    expect(safePathname("/a%00b")).toBeUndefined();
    expect(safePathname("/a%ZZb")).toBeUndefined();
    expect(safePathname("no-slash")).toBeUndefined();
  });
});

describe("staticResponse", () => {
  test("a built asset is served as itself", async () => {
    await using client = await builtClient();

    const response = await staticResponse(client.path, "/assets/app.js");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(APP_JS);
  });

  test("an unknown path falls back to the client, which owns routing", async () => {
    await using client = await builtClient();

    const response = await staticResponse(client.path, "/sessions/abc");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(INDEX_HTML);
  });

  test("a traversal attempt is not found", async () => {
    await using client = await builtClient();

    const response = await staticResponse(client.path, "/../package.json");

    expect(response.status).toBe(404);
  });

  test("without a web root the gateway says how to build one", async () => {
    const response = await staticResponse(undefined, "/");

    expect(response.status).toBe(503);
    expect(await response.text()).toBe(NO_WEB_ROOT_TEXT);
  });

  test("a web root with no index says the same thing", async () => {
    await using directory = await temporaryDirectory("gateway-http-empty");

    const response = await staticResponse(directory.path, "/");

    expect(response.status).toBe(503);
    expect(await response.text()).toBe(NO_WEB_ROOT_TEXT);
  });
});
