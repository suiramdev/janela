#!/usr/bin/env bun

import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Subprocess } from "bun";

export interface LineSplitter {
  push(chunk: Uint8Array): string[];
  flush(): string[];
}

type Piped = Subprocess<"ignore", "pipe", "pipe">;

const SOCKET_PATH = join(homedir(), ".janela", "run", "janelad.sock");

const REPO_ROOT = new URL("..", import.meta.url).pathname;

const READY_DEADLINE_MS = 10_000;

const PROBE_INTERVAL_MS = 150;

const PROBE_TIMEOUT_MS = 250;

const APP_GRACE_MS = 5_000;

const EXIT_DRAIN_MS = 2_000;

const MAX_LINE_LENGTH = 64 * 1024;

const DAEMON_PREFIX = "janelad │ ";

export function lineSplitter(limit: number = MAX_LINE_LENGTH): LineSplitter {
  const decoder = new TextDecoder();
  let carry = "";

  return {
    push(chunk: Uint8Array): string[] {
      carry += decoder.decode(chunk, { stream: true });
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";

      if (carry.length > limit) {
        lines.push(carry);
        carry = "";
      }

      return lines;
    },
    flush(): string[] {
      if (carry === "") return [];

      const last = carry;
      carry = "";

      return [last];
    },
  };
}

export async function daemonIsListening(
  socketPath: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = connect(socketPath);

  const settle = (answer: boolean): void => {
    socket.destroy();
    resolve(answer);
  };

  socket.setTimeout(timeoutMs, () => settle(false));
  socket.once("connect", () => settle(true));
  socket.once("error", () => settle(false));

  return await promise;
}

function residentDaemons(): string {
  const found = Bun.spawnSync(["pgrep", "-lf", String.raw`janelad|main\.ts --foreground`]);

  return new TextDecoder().decode(found.stdout).trim();
}

async function forward(stream: ReadableStream<Uint8Array>): Promise<void> {
  const splitter = lineSplitter();

  for await (const chunk of stream) {
    for (const line of splitter.push(chunk)) console.log(`${DAEMON_PREFIX}${line}`);
  }

  for (const line of splitter.flush()) console.log(`${DAEMON_PREFIX}${line}`);
}

function startDaemon(): Piped {
  const entryPoint = join(REPO_ROOT, "apps", "daemon", "src", "main.ts");

  const daemon = Bun.spawn(["bun", "run", entryPoint, "--foreground"], {
    cwd: join(REPO_ROOT, "apps", "daemon"),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  void forward(daemon.stdout);
  void forward(daemon.stderr);

  return daemon;
}

async function waitForDaemon(daemon: Piped): Promise<boolean> {
  const deadline = Date.now() + READY_DEADLINE_MS;

  while (Date.now() < deadline) {
    if (daemon.exitCode !== null || daemon.signalCode !== null) return false;

    if (await daemonIsListening(SOCKET_PATH)) return true;

    await Bun.sleep(PROBE_INTERVAL_MS);
  }

  return false;
}

async function main(): Promise<void> {
  const target = process.argv.includes("--web") ? "web:dev" : "app";
  let started: Piped | undefined;

  if (await daemonIsListening(SOCKET_PATH)) {
    console.log(`janelad is already listening on ${SOCKET_PATH}. Reusing it.`);
    const resident = residentDaemons();
    console.log(
      resident === ""
        ? "  `pgrep` cannot name it; `lsof -U | grep janelad` shows the process holding the socket."
        : resident.replaceAll(/^/gm, "  "),
    );
    console.log("  Leaving it alone. To hand over to this checkout: bun run daemon:restart");
  } else {
    started = startDaemon();

    if (!(await waitForDaemon(started))) {
      const failure = started.exitCode;
      started.kill("SIGTERM");
      await started.exited;
      console.error(
        failure === null
          ? `janelad did not bind ${SOCKET_PATH} within ${READY_DEADLINE_MS / 1000}s. Not starting the app.`
          : `janelad exited ${failure} before it bound its socket. Not starting the app.`,
      );
      console.error("If this is a fresh checkout, `bun run bootstrap` first.");
      process.exit(1);
    }
  }

  const app = Bun.spawn(["bun", "run", target], {
    cwd: REPO_ROOT,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  let stopping = false;

  const announceExit = async (daemon: Piped): Promise<void> => {
    const code = await daemon.exited;

    if (stopping) return;

    console.log(
      `${DAEMON_PREFIX}exited (${code}). The app will retry; start another with \`bun run --cwd apps/daemon dev\`.`,
    );
  };

  if (started !== undefined) void announceExit(started);

  const stopDaemon = async (): Promise<void> => {
    if (started === undefined) return;

    const daemon = started;
    started = undefined;

    if (daemon.exitCode !== null || daemon.signalCode !== null) return;

    daemon.kill("SIGTERM");
    await daemon.exited;
    console.log("Stopped the janelad this script started. That closed the terminals it held.");
  };

  const finish = (code: number): void => {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    process.exitCode = code;
    setTimeout(() => process.exit(code), EXIT_DRAIN_MS).unref();
  };

  const shutdown = async (code: number): Promise<void> => {
    if (stopping) return;

    stopping = true;
    app.kill("SIGTERM");
    await Promise.race([app.exited, Bun.sleep(APP_GRACE_MS)]);
    await stopDaemon();
    finish(code);
  };

  const onInterrupt = (): void => void shutdown(130);
  const onTerminate = (): void => void shutdown(143);
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);

  const code = await app.exited;
  stopping = true;
  await stopDaemon();
  finish(code);
}

if (import.meta.main) await main();
