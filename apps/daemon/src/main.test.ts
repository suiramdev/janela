import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Option, Schema } from "effect";

interface IsolatedHome extends AsyncDisposable {
  readonly path: string;
}

interface Spawned extends AsyncDisposable {
  stderr(): string;
  kill(signal: NodeJS.Signals): void;
  readonly exited: Promise<number | null>;
}

const packageDirectory = dirname(import.meta.dir);

const REFUSAL_DEADLINE_MS = 10_000;

const LOG_FILE_DEADLINE_MS = 30_000;

const PROCESS_TIMEOUT_MS = 45_000;

const POLL_INTERVAL_MS = 100;

const WrittenRecord = Schema.Struct({
  time: Schema.String,
  level: Schema.String,
  category: Schema.String,
  message: Schema.String,
});

const parseWrittenRecord = Schema.decodeUnknownOption(Schema.fromJsonString(WrittenRecord));

async function isolatedHome(): Promise<IsolatedHome> {
  const path = await mkdtemp("/tmp/jd-main-");

  return {
    path,
    [Symbol.asyncDispose]: async () => {
      await rm(path, { recursive: true, force: true });
    },
  };
}

function spawnDaemon(home: string, args: readonly string[]): Spawned {
  const child = Bun.spawn(["bun", "run", "src/main.ts", ...args], {
    cwd: packageDirectory,
    env: { HOME: home, PATH: process.env["PATH"] ?? "", TMPDIR: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const chunks: string[] = [];
  const reader = child.stderr.getReader();

  void (async () => {
    const decoder = new TextDecoder();

    for (;;) {
      // oxlint-disable-next-line no-await-in-loop
      const chunk = await reader.read();

      if (chunk.done) return;

      chunks.push(decoder.decode(chunk.value));
    }
  })();

  return {
    stderr: () => chunks.join(""),
    kill: (signal) => child.kill(signal),
    exited: child.exited,
    [Symbol.asyncDispose]: async () => {
      child.kill("SIGKILL");
      await child.exited;
    },
  };
}

describe("the daemon as a process", () => {
  test(
    "refuses an argument it cannot honour before it binds, migrates or logs anything",
    async () => {
      await using home = await isolatedHome();
      await using daemon = spawnDaemon(home.path, ["--socket", "/tmp/never", "--foreground"]);
      const stillRunning = Symbol("still running");
      const outcome = await Promise.race([
        daemon.exited,
        Bun.sleep(REFUSAL_DEADLINE_MS).then(() => stillRunning),
      ]);

      if (outcome === stillRunning) throw new Error("the daemon ignored --socket and started");

      expect(outcome).toBe(2);
      expect(daemon.stderr()).toContain('unknown argument "--socket"');
      expect(daemon.stderr()).toContain("usage: janelad");
      expect(existsSync(join(home.path, ".janela"))).toBe(false);
      expect(existsSync(join(home.path, "Library", "Logs"))).toBe(false);
    },
    PROCESS_TIMEOUT_MS,
  );

  test(
    "writes its log file under HOME, mirrored to stderr in the foreground",
    async () => {
      await using home = await isolatedHome();
      await using daemon = spawnDaemon(home.path, ["--foreground"]);
      const logPath = join(home.path, "Library", "Logs", "sh.janela.Janela", "janelad.log");
      const deadline = Date.now() + LOG_FILE_DEADLINE_MS;
      let listening: typeof WrittenRecord.Type | undefined;

      while (listening === undefined) {
        if (Date.now() > deadline) {
          throw new Error(
            `no "listening" record in ${logPath} (exists: ${existsSync(logPath)})\n${daemon.stderr()}`,
          );
        }

        if (existsSync(logPath)) {
          for (const line of readFileSync(logPath, "utf8").split("\n")) {
            const record = parseWrittenRecord(line);

            if (Option.isSome(record) && record.value.message === "listening") {
              listening = record.value;
            }
          }
        }

        if (listening !== undefined) break;

        // oxlint-disable-next-line no-await-in-loop
        await Bun.sleep(POLL_INTERVAL_MS);
      }

      expect(listening.category).toBe("protocol");
      expect(listening.level).toBe("info");
      expect(daemon.stderr()).toContain('"message":"listening"');

      daemon.kill("SIGTERM");

      expect(await daemon.exited).toBe(0);
    },
    PROCESS_TIMEOUT_MS,
  );
});
