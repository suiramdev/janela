/**
 * `main.ts` as a process, because both claims here are about a process.
 *
 * One is that an argument the daemon does not understand stops it *before* it
 * touches anything — the defect in #49 was silent ignoring, so the only honest
 * observer is a spawned daemon and an empty `HOME` afterwards. The other is that
 * the daemon's log exists as a file on disk (#45), which no in-process test of the
 * sink can claim about `main`'s wiring.
 *
 * Both spawn the daemon from source rather than the compiled sidecar:
 * `survival.test.ts` owns the artifact claim, and `bun build --compile` per test
 * would add seconds to prove nothing new about argv parsing.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

/** `apps/daemon`, the working directory `bun run src/main.ts` needs. */
const packageDirectory = dirname(import.meta.dir);

/**
 * An isolated `HOME`, under `/tmp` and not `temporaryDirectory()`.
 *
 * A deliberate copy of `survival.test.ts`'s helper, for its reason: the daemon
 * derives its socket from `homedir()` and refuses a path longer than
 * `sockaddr_un.sun_path` (104 bytes), and a macOS per-user `TMPDIR` spends about
 * 50 of those before any label. Sharing the helper would mean exporting a fixture
 * from a test file, which is worse than eight duplicated lines.
 */
async function isolatedHome(): Promise<{ readonly path: string } & AsyncDisposable> {
  const path = await mkdtemp("/tmp/jd-main-");
  return {
    path,
    [Symbol.asyncDispose]: async () => {
      await rm(path, { recursive: true, force: true });
    },
  };
}

interface Spawned {
  readonly stderr: () => string;
  readonly kill: (signal: NodeJS.Signals) => void;
  readonly exited: Promise<number | null>;
}

/** Every daemon a test started, so a failing assertion cannot leave one behind. */
const started = new Set<Spawned>();

afterEach(async () => {
  for (const daemon of started) daemon.kill("SIGKILL");
  await Promise.all([...started].map((daemon) => daemon.exited));
  started.clear();
});

function spawnDaemon(home: string, args: readonly string[]): Spawned {
  const child = Bun.spawn(["bun", "run", "src/main.ts", ...args], {
    cwd: packageDirectory,
    // Tiny on purpose: `HOME` moves the socket, the database and now the log
    // together, `TMPDIR` keeps anything unpacked inside the fixture, and `PATH`
    // is what the login-shell capture needs to find a shell at all.
    env: { HOME: home, PATH: process.env["PATH"] ?? "", TMPDIR: home },
    stdout: "pipe",
    stderr: "pipe",
  });

  const chunks: string[] = [];
  void (async () => {
    const decoder = new TextDecoder();
    // Read continuously: a full pipe must never be what stalls the daemon under
    // test, and `--foreground` mirrors every record here.
    for await (const chunk of child.stderr as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(decoder.decode(chunk));
    }
  })();

  const daemon: Spawned = {
    stderr: () => chunks.join(""),
    kill: (signal) => child.kill(signal),
    exited: child.exited,
  };
  started.add(daemon);
  return daemon;
}

describe("the daemon as a process", () => {
  test("refuses --socket before touching anything", async () => {
    await using home = await isolatedHome();
    const daemon = spawnDaemon(home.path, ["--socket", "/tmp/never", "--foreground"]);

    // Real time, deliberately: the condition — "did another operating-system
    // process exit?" — lives outside this runtime, so there is no clock here to
    // advance. The race is what turns "it started anyway" into a named failure
    // instead of a timeout.
    const stillRunning = Symbol("still running");
    const outcome = await Promise.race([daemon.exited, Bun.sleep(10_000).then(() => stillRunning)]);
    if (outcome === stillRunning) {
      daemon.kill("SIGKILL");
      throw new Error("the daemon ignored --socket and started");
    }

    expect(outcome).toBe(2);
    expect(daemon.stderr()).toContain('unknown argument "--socket"');
    expect(daemon.stderr()).toContain("usage: janelad");
    // Nothing bound, nothing migrated, nothing logged: an argument it cannot
    // honour is refused before the first `mkdir`.
    expect(existsSync(join(home.path, ".janela"))).toBe(false);
    expect(existsSync(join(home.path, "Library", "Logs"))).toBe(false);
  }, 45_000);

  test("writes its log file under HOME, mirrored to stderr in the foreground", async () => {
    await using home = await isolatedHome();
    const daemon = spawnDaemon(home.path, ["--foreground"]);
    const logPath = join(home.path, "Library", "Logs", "sh.janela.Janela", "janelad.log");

    // Same reason as above: a poll of the other process's filesystem effects.
    // Fast when it works (the file appears in milliseconds), and the deadline
    // reports the condition that never came true, not just a timeout.
    const deadline = Date.now() + 30_000;
    let listening: Record<string, unknown> | undefined;
    while (listening === undefined) {
      if (Date.now() > deadline) {
        throw new Error(
          `no "listening" record in ${logPath} (exists: ${existsSync(logPath)})\n${daemon.stderr()}`,
        );
      }
      if (existsSync(logPath)) {
        for (const line of readFileSync(logPath, "utf8").split("\n")) {
          if (line === "") continue;
          const record = JSON.parse(line) as Record<string, unknown>;
          if (record["message"] === "listening") listening = record;
        }
      }
      if (listening !== undefined) break;
      // oxlint-disable-next-line no-await-in-loop
      await Bun.sleep(100);
    }

    expect(listening["category"]).toBe("protocol");
    expect(listening["level"]).toBe("info");
    expect(typeof listening["time"]).toBe("string");
    // The same line, on the same fd a developer's pipe is reading.
    expect(daemon.stderr()).toContain('"message":"listening"');

    daemon.kill("SIGTERM");
    expect(await daemon.exited).toBe(0);
  }, 45_000);
});
