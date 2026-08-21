/**
 * `janelad` — the process that owns the user's terminals.
 *
 * One per user, started by launchd on first connection to its socket, and outliving
 * every client. See docs/decisions/0017-daemon-lifecycle.md.
 *
 * This file is deliberately thin: process plumbing only, nothing worth testing.
 * Everything with behaviour lives in `@janela/daemon` and below, where it can be
 * exercised without a process.
 *
 * Shipped as a single compiled binary — `bun build --compile` embeds the runtime,
 * the Prisma client, the emulator and the PTY cdylib, and the result runs from a
 * directory containing nothing else. Verified in the migration spikes; see
 * docs/decisions/0020-bun-daemon-runtime.md.
 */

// MARK: - Signals
//
// TODO: Handle SIGTERM (launchd at logout) by hanging up every PTY and exiting
// cleanly, and SIGINT the same way for a foreground developer run. Ignore SIGPIPE —
// a client vanishing mid-write is routine and must never kill the daemon.
//
// Note the ordering that matters: hang up the PTYs *before* exiting, so children get
// SIGHUP rather than being reparented onto launchd. `TerminalRegistry.hangUpAll()`
// is that step.

// MARK: - Socket
//
// TODO: Obtain the listening descriptor from launchd rather than binding a path.
// launchd created the socket, owns its lifetime, and starting us was its decision —
// binding our own would race with it.
//
// This is the one place the migration is genuinely harder than what it replaced:
// `launch_activate_socket` is a C function, and `bun:ffi` is gated to @janela/pty so
// that Janela has exactly one FFI surface. Resolve it one of two ways, and write
// down which:
//
//   (a) Extend the PTY cdylib with a `janela_launch_socket()` export. One native
//       artifact, already built and signed, and the descriptor is handed to Bun as
//       a plain integer. This is the expected answer.
//   (b) Bind the path ourselves and drop socket activation, accepting that the
//       daemon is started by the app rather than by launchd. This trades away the
//       "a user who never opens Janela never has a process" property, which ADR
//       0017 chose deliberately. Do not take this route silently.
//
// Fall back to binding `defaultSocketPath()` only when running in the foreground for
// development (`--foreground`), which is the one case where no launchd job exists.

// MARK: - Lifecycle
//
// TODO: After the last client disconnects, exit if no terminal is live — but only
// after an idle grace period, so quitting and reopening the app does not tear down
// and rebuild the world. A daemon holding live terminals never exits on its own;
// that asymmetry is the entire feature.

// TODO: Build the object graph (`daemonEnvironment()` below), open the database, run
// migrations, restore sessions as idle, then serve until cancelled.
//
// Migration failure is the interesting error: it means the daemon cannot start, and
// the only way a user learns about it is a client that cannot connect. Log it
// clearly and exit non-zero so launchd's KeepAlive does not spin.

/**
 * The daemon object graph.
 *
 * Constructor injection from one place, exactly as in the app. There is no service
 * locator, no singleton graph, and nothing global — which is also what makes the
 * whole graph substitutable in `@janela/daemon`'s tests.
 */
export function daemonEnvironment(options: {
  readonly databasePath: string;
  readonly foreground: boolean;
}): Promise<{ serve(signal: AbortSignal): Promise<void> }> {
  void options;
  throw new Error(`not implemented: daemonEnvironment`);
}
