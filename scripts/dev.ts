#!/usr/bin/env bun
/**
 * `bun run dev` — a daemon and the app, in one terminal.
 *
 * ## Why this exists
 *
 * `bun run app` is `tauri dev`, and nothing in it starts `janelad`. An installed
 * build does not need it to: the app registers a LaunchAgent, launchd owns the
 * daemon's lifecycle, and a client that cannot connect runs `launchctl kickstart`
 * and retries. A development build has no `.app` bundle, so `SMAppService` reports
 * `unsupported`, no agent is ever registered, and the kickstart has no service to
 * start. The app then renders its last known state and retries forever — correct
 * behaviour (non-negotiable 8) and a confusing first five minutes.
 *
 * ## The rules it is held to
 *
 * - **It never stops a daemon it did not start.** A resident `janelad` holds the
 *   user's terminals, and terminating them is their explicit choice with a stated
 *   cost (non-negotiable 7). Two clients on one daemon is the design, so a live
 *   socket means *reuse* — and the provenance is printed, because "the app behaves
 *   like code I did not write" is the footgun of this architecture.
 * - **The daemon it did start is stopped on the way out**, and it says what that
 *   cost. An orphan foreground daemon serving a checkout you have moved on from is
 *   that same footgun, invisible in a fresh shell.
 * - **Liveness is a connect, not a `stat`.** A stale socket file outlives a killed
 *   daemon; testing for the file would refuse to start a daemon forever. The
 *   daemon's own bind path takes over a dead incumbent's address.
 * - **It starts nothing else.** No watcher restarts the daemon on a source change:
 *   that would hang up the terminals it holds every time you save.
 */

import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Subprocess } from "bun";

/**
 * The same path `@janela/daemon`'s `defaultSocketPath()` computes, spelled out
 * rather than imported: a script is held to the layering rule too, and this one is
 * a client's neighbour, not a daemon package.
 */
const SOCKET_PATH = join(homedir(), ".janela", "run", "janelad.sock");

const REPO_ROOT = new URL("..", import.meta.url).pathname;

/** How long the daemon gets to bind before this gives up and says so. */
const READY_DEADLINE_MS = 10_000;
const PROBE_INTERVAL_MS = 150;
const PROBE_TIMEOUT_MS = 250;

/** Long enough that the app's tree has hung up, short enough to not feel stuck. */
const APP_GRACE_MS = 5_000;

/** The belt on a natural exit, so an unexpected handle cannot hang the terminal. */
const EXIT_DRAIN_MS = 2_000;

/**
 * A partial line is a buffer, and the daemon is one save away from writing
 * something enormous. The sink already bounds a record at 120 characters, so this
 * is slack rather than a limit anybody should reach (non-negotiable 9).
 */
const MAX_LINE_LENGTH = 64 * 1024;

const DAEMON_PREFIX = "janelad │ ";

export interface LineSplitter {
  /** Whole lines completed by this chunk, in order. */
  push(chunk: Uint8Array): string[];
  /** Whatever is left when the stream ends. */
  flush(): string[];
}

/**
 * Splits a byte stream into lines across chunk boundaries.
 *
 * A pipe hands over whatever the kernel had, which cuts a JSON record in half far
 * more often than it looks like it should — and a half-record prefixed and printed
 * is unreadable exactly when the daemon is telling you why it died.
 */
export function lineSplitter(limit: number = MAX_LINE_LENGTH): LineSplitter {
  const decoder = new TextDecoder();
  let carry = "";
  return {
    push(chunk: Uint8Array): string[] {
      carry += decoder.decode(chunk, { stream: true });
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      // A producer that never emits a newline does not get to grow this forever.
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

/**
 * Whether something is accepting connections on `socketPath`.
 *
 * A connect, because the file is not the answer: `~/.janela/run/janelad.sock`
 * survives a `SIGKILL`, and a dead incumbent's address is exactly what the
 * daemon's bind takes over. The connection is closed immediately without a
 * handshake, which the daemon treats as any other client hanging up — so a run
 * leaves one `peer left during handshake` record in the log it probed. That is the
 * whole cost of asking, and it is the only honest way to ask.
 */
export async function daemonIsListening(
  socketPath: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connect(socketPath);
    const settle = (answer: boolean): void => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

/**
 * `pgrep`'s view, for provenance — which checkout is about to serve this app.
 *
 * Two spellings, because there are two ways to start one: the compiled sidecar,
 * whose command line contains `janelad`, and the source entry point, which never
 * mentions the word. Same pattern as `daemon-status.ts`.
 */
function residentDaemons(): string {
  const found = Bun.spawnSync(["pgrep", "-lf", String.raw`janelad|main\.ts --foreground`]);
  return new TextDecoder().decode(found.stdout).trim();
}

type Piped = Subprocess<"ignore", "pipe", "pipe">;

/** Prefixes the daemon's records so they cannot be mistaken for the app's. */
async function forward(stream: ReadableStream<Uint8Array>): Promise<void> {
  const splitter = lineSplitter();
  for await (const chunk of stream) {
    for (const line of splitter.push(chunk)) console.log(`${DAEMON_PREFIX}${line}`);
  }
  for (const line of splitter.flush()) console.log(`${DAEMON_PREFIX}${line}`);
}

function startDaemon(): Piped {
  // From source, in the foreground, against your real `HOME`: the same daemon
  // `bun run --cwd apps/daemon dev` starts, so there is one dev daemon and not a
  // second flavour of it. No compile step, so an edit costs a restart, not a build.
  //
  // The entry point is absolute rather than relative so that the checkout it came
  // from is visible in `ps`: a daemon run from source has no "janelad" in its
  // command line, and `.superset/teardown.sh` has to be able to recognise its own
  // orphan without killing somebody else's.
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

/** Resolves once the socket answers, or `false` if the daemon died or never bound. */
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
  let started: Piped | undefined;

  if (await daemonIsListening(SOCKET_PATH)) {
    console.log(`janelad is already listening on ${SOCKET_PATH}. Reusing it.`);
    const resident = residentDaemons();
    console.log(
      resident === ""
        ? "  `pgrep` cannot name it; `lsof -U | grep janelad` shows the process holding the socket."
        : resident.replaceAll(/^/gm, "  "),
    );
    // Non-negotiable 7: it holds terminals, and stopping it is the user's call.
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

  // Inherited stdio: `tauri dev` is the thing you are watching, and the terminal
  // delivers Ctrl-C to the whole process group, children included.
  const app = Bun.spawn(["bun", "run", "app"], {
    cwd: REPO_ROOT,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  let stopping = false;

  /**
   * Reports a daemon that died under us, and leaves the app alone.
   *
   * Not restarted: the app renders its last known state and reconnects, which is
   * exactly what a user's client does when launchd's daemon goes away. Restarting
   * it here would also race the bind of whatever killed it.
   */
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

  /**
   * Exits without truncating what the last few lines said.
   *
   * `process.exit()` in a signal handler drops output that has not reached the
   * file descriptor yet, and the message it drops is the one that matters: that a
   * daemon was stopped and terminals with it. So the signal handlers are removed,
   * an exit code is set, and the loop is allowed to drain — with an unref'd timer
   * as the belt, because a handle nobody expected must not hang the terminal.
   */
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
