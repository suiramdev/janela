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
// TODO: Bind `defaultSocketPath()` — `~/.janela/run/janelad.sock` — in a directory
// this process creates 0700 and then re-checks with `verifySocketDirectory()`.
//
// This is route (b) of the two ADR 0017 originally offered, and it was taken
// deliberately, not silently: see that ADR's 2026-09-08 amendment. The plist declares
// no `Sockets` block, because the only static form of it — launchd's
// `SecureSocketWithKey` — publishes the socket path solely into the GUI login
// session's launchd environment, which a CLI over ssh cannot read, and ADR 0023
// requires an address that survives launchd. So there is no listening descriptor to
// inherit, no `launch_activate_socket`, and no second FFI surface: `bun:ffi` stays
// gated to @janela/pty.
//
// The property socket activation was chosen for is kept by the client instead: the
// agent has no `RunAtLoad`, so nothing runs until a client fails to connect and runs
// `launchctl kickstart gui/<uid>/sh.janela.janelad`. A user who never opens Janela
// never has a process. `--foreground` is the same code path with no launchd job
// above it.

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
