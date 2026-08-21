import { describe, expect, test } from "bun:test";

import {
  MAXIMUM_SOCKET_PATH_LENGTH,
  SOCKET_DIRECTORY_MODE,
  SocketPathTooLong,
} from "./endpoint.ts";

describe("the socket endpoint", () => {
  test("sun_path is 104 bytes on macOS, which is why the socket is not in Application Support", () => {
    expect(MAXIMUM_SOCKET_PATH_LENGTH).toBe(104);
  });

  test("the socket directory is 0700 — anything that can connect can start processes", () => {
    expect(SOCKET_DIRECTORY_MODE).toBe(0o700);
  });

  test("a too-long path fails loudly, because a truncated sun_path silently addresses another socket", () => {
    const error = new SocketPathTooLong(120);
    expect(error.summary).not.toContain("sun_path");
    expect(error.reason).toContain("120");
    expect(error.reason).toContain("104");
    expect(error.recoverySuggestion).toBeDefined();
  });
});
