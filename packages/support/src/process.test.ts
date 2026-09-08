import { describe, expect, test } from "bun:test";
import { chmod, writeFile } from "node:fs/promises";

import { temporaryDirectory } from "@janela/test-support";

import { processRunner } from "./process.ts";

describe("processRunner().run", () => {
  test("arguments reach the child verbatim, with no shell", async () => {
    await using directory = await temporaryDirectory("process-argv");

    const outcome = await processRunner().run({
      executable: "/bin/echo",
      arguments: ["$HOME", "a b"],
      workingDirectory: directory.path,
      environment: {},
    });

    // A shell, or a joined argv, would expand `$HOME` or split `a b` in two.
    expect(outcome.standardOutput).toBe("$HOME a b\n");
    expect(outcome.succeeded).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.timedOut).toBe(false);
  });

  test("a timeout kills the child and says so", async () => {
    await using directory = await temporaryDirectory("process-timeout");

    const started = Date.now();
    const outcome = await processRunner().run({
      executable: "/bin/sleep",
      arguments: ["5"],
      workingDirectory: directory.path,
      environment: {},
      timeoutMs: 100,
    });

    expect(outcome.timedOut).toBe(true);
    expect(outcome.succeeded).toBe(false);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  test("a failure to start rejects rather than reporting an exit status", async () => {
    await using directory = await temporaryDirectory("process-enoent");

    // There was no process, so there is no exit code to invent for one.
    await expect(
      processRunner().run({
        executable: directory.join("nothing-here"),
        arguments: [],
        workingDirectory: directory.path,
        environment: {},
      }),
    ).rejects.toThrow();
  });
});

describe("processRunner().which", () => {
  test("searches only the PATH it is given", async () => {
    await using directory = await temporaryDirectory("process-which");
    const probe = directory.join("probe");
    await writeFile(probe, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(probe, 0o755);

    const runner = processRunner();

    expect(await runner.which("probe", directory.path)).toBe(probe);
    expect(await runner.which("probe", "/usr/bin")).toBeUndefined();
    // git is on the real PATH; the argument is the whole search space, so a
    // fallback to `process.env.PATH` would find it here.
    expect(await runner.which("git", "/nonexistent")).toBeUndefined();
  });

  test("a path-ish name is checked where it points, not searched for", async () => {
    await using directory = await temporaryDirectory("process-which-path");
    const script = directory.join("runnable");
    await writeFile(script, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(script, 0o755);
    const notExecutable = directory.join("plain.txt");
    await writeFile(notExecutable, "hello\n", "utf8");

    const runner = processRunner();

    expect(await runner.which(script, "/nonexistent")).toBe(script);
    expect(await runner.which(notExecutable, "/nonexistent")).toBeUndefined();
    expect(await runner.which(directory.path, "/nonexistent")).toBeUndefined();
  });
});
