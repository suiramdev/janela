import Foundation
import JanelaDaemon
import JanelaSupport
import OSLog

// janelad — the process that owns the user's terminals.
//
// One per user, started by launchd on first connection to its socket, and outliving
// every client. See docs/decisions/0017-daemon-lifecycle.md.
//
// This file is deliberately thin: process plumbing only, nothing worth testing.
// Everything with behaviour lives in JanelaDaemon and below, where it can be
// exercised without a process.

// MARK: - Signals
//
// TODO: Handle SIGTERM (launchd at logout) by hanging up every PTY and exiting
// cleanly, and SIGINT the same way for a foreground developer run. Ignore SIGPIPE
// — a client vanishing mid-write is routine and must never kill the daemon.
//
// Note the ordering that matters: hang up the PTYs *before* exiting, so children
// get SIGHUP rather than being orphaned onto launchd.

// MARK: - Socket
//
// TODO: Obtain the listening descriptor from launchd via `launch_activate_socket`
// rather than binding a path. launchd created the socket, owns its lifetime, and
// starting us was its decision — binding our own would race with it.
//
// Fall back to binding `DaemonEndpoint.defaultSocketURL()` only when running in the
// foreground for development (`--foreground`), which is the one case where no
// launchd job exists.

// MARK: - Lifecycle
//
// TODO: After the last client disconnects, exit if no terminal is live — but only
// after an idle grace period, so quitting and reopening the app does not tear down
// and rebuild the world. A daemon holding live terminals never exits on its own;
// that asymmetry is the entire feature.

Log.app.notice("janelad starting")

// TODO: build the object graph (DaemonEnvironment.live()), open the database, run
// migrations, restore sessions as `.idle`, then serve until cancelled.
//
// Migration failure is the interesting error: it means the daemon cannot start, and
// the only way a user learns about it is a client that cannot connect. Log it
// clearly and exit non-zero so launchd's KeepAlive does not spin.

RunLoop.main.run()
