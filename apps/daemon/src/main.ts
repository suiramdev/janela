/**
 * `janelad` — the process that owns the user's terminals.
 *
 * One per user and outliving every client. See
 * docs/decisions/0017-daemon-lifecycle.md.
 *
 * This file is deliberately thin: process plumbing only, nothing worth testing.
 * Everything with behaviour lives in `environment.ts`, `socket.ts` and
 * `lifecycle.ts` beside it, and in `@janela/daemon` and below, where it can be
 * exercised without a process.
 *
 * Shipped as a single compiled binary — `bun build --compile` embeds the runtime,
 * the Prisma client, the emulator and the PTY cdylib, and the result runs from a
 * directory containing nothing else. Verified in the migration spikes; see
 * docs/decisions/0020-bun-daemon-runtime.md.
 */

import { defaultDatabasePath } from "@janela/db";
import { log, setLogSink } from "@janela/support";

import { daemonEnvironment } from "./environment.ts";
import { createIdleMonitor, isDaemonIdle, shutdown } from "./lifecycle.ts";

/**
 * The version `--version` prints.
 *
 * A literal rather than an import of `package.json`: `bun build --compile` would
 * have to embed the manifest, and a daemon whose version depends on a file being
 * next to it is a daemon that reports the wrong version from a bundle. The app's
 * own version lives in `tauri.conf.json`, and the two are released together.
 */
const JANELAD_VERSION = "0.0.0";

/**
 * The daemon's sink: one JSON object per line on stderr.
 *
 * launchd captures stderr, and JSON keeps a record readable next to the client's,
 * which goes through Tauri's log plugin. Records only ever carry shapes — an id, a
 * count, an exit status — because that is what `LogRecord.fields` is for; terminal
 * traffic, command output and environment values never reach one by construction.
 */
function installLogSink(): void {
  setLogSink({
    write: (record) => {
      process.stderr.write(`${JSON.stringify(record)}\n`);
    },
  });
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes("--version")) {
    // Touches nothing else: CI runs `./janelad --version` from an empty directory
    // to prove the compiled binary carries its own runtime.
    process.stdout.write(`${JANELAD_VERSION}\n`);
    return;
  }

  installLogSink();
  const logger = log("app");
  const foreground = argv.includes("--foreground");
  const environment = await daemonEnvironment({
    databasePath: defaultDatabasePath(),
    foreground,
  }).catch((error: unknown) => {
    // The interesting error is a failed migration: it means the daemon cannot
    // start, and the only way a user learns about it is a client that cannot
    // connect. Exit non-zero so launchd's KeepAlive does not spin.
    logger.error("daemon start failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return process.exit(1);
  });

  const controller = new AbortController();
  const stop = (): void => {
    void shutdown({
      terminals: environment.terminals,
      log: logger,
      stopServing: () => controller.abort(),
      finish: (code) => process.exit(code),
    });
  };

  // `once`, so a second SIGTERM while the sweep is in flight does not start a
  // second one. Never kill the terminals harder than SIGHUP: terminating them is
  // always the user's explicit choice (non-negotiable #7).
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  // A client vanishing mid-write is routine and must never kill a daemon holding
  // another client's terminals. Bun follows Node in ignoring SIGPIPE and
  // surfacing EPIPE on the socket instead, which `socketTransport` already
  // absorbs; this is explicit so a runtime that does not cannot take us down.
  process.on("SIGPIPE", () => {});

  const idle = createIdleMonitor({
    isIdle: () => isDaemonIdle(environment.server),
    onIdleExpired: stop,
  });
  idle.start();

  try {
    await environment.serve(controller.signal);
  } finally {
    idle.stop();
    await environment.database.close();
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
