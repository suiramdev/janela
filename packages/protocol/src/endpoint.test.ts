import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";

import { MAXIMUM_SOCKET_PATH_LENGTH, SocketPathTooLong, defaultSocketPath } from "./endpoint.ts";

describe("the socket path", () => {
  test("sun_path is 104 bytes on macOS, which is why the socket is not in Application Support", () => {
    expect(MAXIMUM_SOCKET_PATH_LENGTH).toBe(104);
  });

  test("a too-long path fails loudly, because a truncated sun_path silently addresses another socket", () => {
    const error = new SocketPathTooLong(120);

    expect(error.summary).not.toContain("sun_path");
    expect(error.reason).toContain("120");
    expect(error.reason).toContain("104");
    expect(error.recoverySuggestion).toBeDefined();
  });

  test("the default path is `~/.janela/run/janelad.sock` and fits sun_path", () => {
    const path = defaultSocketPath();

    expect(path.startsWith(`${homedir()}/`)).toBe(true);
    expect(path.endsWith("/.janela/run/janelad.sock")).toBe(true);
    expect(Buffer.byteLength(path, "utf8")).toBeLessThanOrEqual(MAXIMUM_SOCKET_PATH_LENGTH);
  });
});
