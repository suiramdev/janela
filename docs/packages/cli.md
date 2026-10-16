# `apps/cli`

Layer 7, client side: `janela`, the protocol from a shell. It is a client of
`janelad` like the app and the browser, built from the same `@janela/client`
connection and mirror, with a Unix socket where they have a bridge
([`architecture.md`](../architecture.md) § The CLI). Run it from a checkout with
`bun run cli -- <command>`; relative paths are then relative to the repository
root, because that is where `bun run` runs.

```text
janela list [--json]
janela project add <directory> [--name <name>]
janela session create --directory <directory> [--name <name>]
janela session create --project <project> [--branch <branch>] [--name <name>]
janela session create --project <project> --new-branch <branch> [--from <start>] [--name <name>]
janela session remove <session> [--yes] [--delete-directory]
janela terminal create <session> [--title <title>]
janela terminal start <terminal>
janela terminal read <terminal> [--scrollback]
```

A `<project>`, `<session>` or `<terminal>` is an exact id, an exact name (projects
and sessions only), or a unique id prefix — in that order. Two matches is an
error that lists them, never a pick.

## Output

`list` prints one record per line, tab-separated, each led by its noun:

```text
project   <id>  <name>   <directory>
session   <id>  <name>   <directory>  <project id, or ->
terminal  <id>  <session id>  <state>  <title>
```

Projects are followed by their sessions, each session by its terminals; standalone
sessions come last. The records carry their parent's id, so `grep` and `cut` work
without knowing the nesting. `--json` prints the mirror itself —
`{ projects, sessions, terminalStates }` exactly as the daemon sent them — for
anything that would rather parse than split.

`session create` prints the new session's records, `project add` the project's,
`terminal create` the new terminal's id, `terminal read` the screen as text.

## Exit status

| Status | Meaning |
| --- | --- |
| 0 | Done |
| 1 | The daemon failed the request, or a name matched nothing or too much |
| 2 | Usage: an unknown command, option or argument |
| 3 | The daemon is not reachable, or the socket path does not fit `sun_path` |
| 4 | The daemon refused the handshake: another protocol version, or another user |
| 5 | Removal was not confirmed |

Errors go to stderr as a `UserFacingError`: the summary, then the reason, then the
recovery suggestion, one per line. A failure that is not user-facing is wrapped in
`UnexpectedFailure` and printed by name only, never as a stack or raw text.

## `src/socket-transport.ts` — the `MessageTransport`

`openSocketTransport(path)` connects with `node:net` and resolves once connected;
it rejects with `SocketTransportFailure("daemon-unavailable")` carrying the
system's code (`ENOENT` when there is no socket, `ECONNREFUSED` when the file is
left from a daemon that died). Both directions are bounded:

- **Daemon → CLI** goes through a `boundedQueue` of `INCOMING_CHUNK_CAPACITY` (64)
  chunks. When it is full the socket is **paused** and resumed when the reader
  takes one, so a CLI that is slow to read is, to the daemon, a client that
  stopped reading — its per-client output queue does the rest.
- **CLI → daemon** fails the transport with `transport-stalled` when the socket's
  `writableLength` passes `SEND_BACKLOG_LIMIT_BYTES` (1 MiB).

## `src/daemon-link.ts` — connecting once

`linkDaemon` builds a `createConnection` with `createStores()` as its mirror,
calls `connect()` once and then decides; it never waits for the reconnect loop:

- **Refused** (`incompatibleVersion`, `unauthorized`, `protocolViolation`) is
  `DaemonIncompatible`, exit 4.
- **Not connected** is `DaemonNotRunning` when the socket is absent or refuses
  (exit 3, naming the socket and the two ways to start a daemon), and
  `DaemonUnreachable` for anything else.
- **Connected** waits up to `SNAPSHOT_DEADLINE_MS` (5 s) for the first full state
  snapshot, which `createConnection` subscribes for on its own. Every command then
  reads the mirror, never a request of its own for state.

**It never starts the daemon.** The app and the gateway run
`launchctl kickstart gui/<uid>/sh.janela.janelad`; over ssh with no desktop login
there is no `gui/<uid>` domain to kickstart in, and a `janelad` started by hand
would hold the user's terminals outside launchd. The message says so and stops.

## `src/commands.ts` — one request, or two

- `list` sends nothing: the snapshot is the answer.
- `project add` and `session create` remember the ids in the mirror, send the
  request, and wait up to `SETTLE_TIMEOUT_MS` (2 s) for an id that was not there.
  Neither reply carries the id, so this is the only way to know; a session waits
  once more for its first terminal, which the daemon adds before it acknowledges.
  If nothing new appears the CLI says it cannot tell (`NotYetVisible`) rather than
  print the wrong one.
- `session remove` asks for `removalPlan` and prints its cost — terminals that end,
  the teardown automation, the directory deleted or kept, uncommitted or unpushed
  work — **before** anything is destroyed (non-negotiable 7). Then it removes only
  if `--yes` was given, or stdin and stderr are a terminal and the user answers
  `y`. Otherwise it exits 5 and removes nothing; a script reads the plan and runs
  it again with `--yes`. The daemon's plan always keeps the directory, as the app
  does; `--delete-directory` asks for a worktree Janela created to go too, and is
  refused (`DirectoryNotOurs`, before anything is removed) when the plan says the
  directory is not Janela's to delete. The plan printed then names what is lost
  with it.
- `terminal create` answers with the id `createTerminal` returns; `terminal start`
  is `startTerminal`; `terminal read` is `snapshotText`, with `--scrollback` for the
  whole buffer. A terminal that has never started has no emulator, and the daemon's
  failure for it is printed as is.

## What this does not do, on purpose

- **No attach.** A live terminal inside another terminal needs its own decision.
- **No logging.** The connection's logger is silent, so stderr carries only the
  errors meant for the user and nothing a terminal contains.
- **No new request.** Each verb is one the app already sends; adding one is a
  protocol change and gets its own issue.
