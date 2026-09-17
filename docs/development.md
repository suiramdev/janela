# Development

> [!WARNING]
> **This document predates the Tauri/TypeScript migration and is stale.**
> It describes the Swift stack — `make` targets, SwiftPM modules, SwiftTerm, GRDB,
> Xcode. The architecture, the domain model and the product thesis it serves are
> unchanged; the stack it names is gone.
>
> Current: [`AGENTS.md`](../AGENTS.md) for commands and layering,
> [`architecture.md`](architecture.md) for the system,
> [`MIGRATION_MAP.md`](MIGRATION_MAP.md) for where every module, type and seam went.
> § Debugging and § The daemon are current (#45, #49); the sections above them
> still describe the Swift stack.


Getting set up, working day to day, and what to build first.

---

## Requirements

| Thing | Version | Why |
| --- | --- | --- |
| macOS | 15.0+ | Deployment target |
| Xcode | 26.0+ | Swift 6.2 tools, bundled `swift-format` |
| XcodeGen | any recent | Generates `Janela.xcodeproj` |
| SwiftLint | any recent | Optional locally, required in CI |

## Setup

```bash
git clone <repo> janela && cd janela
make bootstrap
```

`bootstrap` verifies Xcode, installs XcodeGen via Homebrew if missing, resolves
package dependencies, and generates the Xcode project. It is safe to re-run.

Verify:

```bash
make test     # 6 tests, well under a second
make lint     # clean
```

---

## The loop

**Work in the package, not in Xcode.**

```bash
make build    # seconds
make test     # seconds
make lint     # before committing
make check    # lint + test, exactly what CI runs
```

`Packages/JanelaKit` builds without an Xcode project. `xcodebuild` is minutes
slower and you only need it when you want the actual `.app`:

```bash
make app-build
make app-run
```

When you need Xcode itself — SwiftUI previews, Instruments, the view debugger:

```bash
make open     # regenerates the project first, then opens it
```

### Two things that will bite you

1. **`make generate` after editing `project.yml`.** Otherwise Xcode is looking at
   a stale project. `make open` does it for you; running `xcodebuild` directly does
   not.
2. **Never commit `Janela.xcodeproj`.** It is generated and gitignored, and CI
   fails if one appears.

---

## Where things live

```text
App/Janela/JanelaAppMain.swift        The @main shim. One file. Keep it that way.
Packages/JanelaKit/Sources/           Every module. Your work is here.
Packages/JanelaKit/Tests/             Tests, one target per module.
docs/research/                        Primary-source research behind the design.
```

The modules divide into three groups, and which group a file belongs to decides
what it may import:

```text
shared    JanelaSupport  JanelaCore  JanelaProtocol
daemon    JanelaGit  JanelaPTY  JanelaPersistence  JanelaTerminal
          JanelaSession  JanelaDaemon  →  janelad
client    JanelaClient  JanelaDesign  JanelaTerminalUI  JanelaUI  JanelaApp
```

Read [`architecture.md`](architecture.md) for the module map and the layering rule
before adding a file, and `AGENTS.md` for the short version.

---

## Current state

The repository is **scaffolded, not implemented**. It builds, launches, and passes
its tests, but the behaviour is `TODO`.

What exists and works:

- The full module graph, with compiler-enforced layering.
- Domain types, with tests pinning the product rules.
- The database with its first migration, tested.
- The app target: builds, signs (ad-hoc), launches, shows an empty state.
- `make` targets and CI.

What is a stub: the PTY, the live terminal, git operations, project and session
persistence, and essentially all UI. Not yet present at all: `JanelaForge`,
automation, `.worktreeinclude`, notifications and the layout algebra — all of them
designed in [`domain-model.md`](domain-model.md), none of them written. Every
stub has a doc comment describing what belongs there.
`grep -rn "TODO:" Packages/` is a work queue.

---

## First tasks

Roughly dependency-ordered. Each is a reasonable PR.

### 1. `JanelaPTY` — make a process run

The foundation, and the highest-risk piece. `PseudoTerminal.init` currently throws.

Implement `openpty()` → `fork()` → child does `login_tty()`, `chdir`, `execve`.
**Read the doc comment first** — `posix_spawn` and `Foundation.Process` cannot give
a child a controlling terminal, and between `fork` and `exec` you may call only
async-signal-safe functions. Pre-marshal the `char **` arrays before forking.

Then `TerminalByteStream` over `DispatchIO`, with the water marks and the
one-successor-read rule from the doc comment.

Tests: spawn `/bin/echo`, read its output, assert exit code. Spawn `cat`, write,
read it back. Resize and assert `SIGWINCH`. Kill a process group with a
grandchild.

### 2. `JanelaGit` — worktree operations

`GitRunner.run`/`probe` over `Foundation.Process` (no PTY needed here), then
`WorktreeService`. Parse `git worktree list --porcelain -z` — use `-z`, because
worktree paths may contain newlines.

Tests use `GitFixture` against real repositories.

### 3. `JanelaPersistence` — records

GRDB records and queries for the tables in `v1-initial`: project, session,
terminal, launchProfile, automationCommand. Round-trip tests, plus the cascade
tests that encode product rules ([`testing.md`](testing.md) § Migrations).

### 4. `JanelaCore` — the layout algebra

Pure logic, no I/O, and the one piece of real complexity in the domain layer:
split, close-and-promote, focus traversal, depth and fraction validation, and
`Codable` round-tripping. Worth doing before the UI that consumes it, because every
layout rule is testable in milliseconds with no window server.

### 5. `JanelaTerminal` — the emulator seam

Implement `TerminalEmulating` over SwiftTerm. Expect to need
`@preconcurrency import SwiftTerm` — it is Swift 5 language mode. Wire
`LiveTerminal.start()` to the PTY and feed the emulator.

### 6. `JanelaSession` — lifecycle

`ProjectStore` and `SessionStore`: `load`, `createSession`, `removalPlan`,
`removeSession`. Also `ShellEnvironment` resolution — the login-shell `argv[0]`
trick is what stops "claude: command not found".

Tests with an in-memory database and a fake `WorktreeServing`.

### 7. `JanelaProtocol` + `JanelaDaemon` — the socket

Framing first, because it is pure and every bug in it is cheap to find now and
expensive to find later: length-prefixed frames, bounded, with a `Hello` handshake.
Then a listener that accepts a connection, checks `LOCAL_PEERCRED`, and answers.

Tests bind a real socket in a `TemporaryDirectory` — keep the path short, `sun_path`
is 104 bytes.

### 8. `JanelaClient` — the mirror

Connect, handshake, subscribe, and turn `DaemonMessage.state` into the `@Observable`
stores the UI reads. Then reconnect with backoff, which is where the interesting
bugs are.

### 9. `JanelaUI` — the actual app

Sidebar (collapsible projects, standalone sessions above them), tab strip, split
view, and an `NSViewRepresentable` wrapping the terminal view from
`JanelaTerminalUI`.

### 10. The repaint encoder

Damage tracking to minimal escape sequences, in `JanelaTerminal`. Deliberately last:
it is the hardest piece, and a correct-but-dumb full repaint every frame is a valid
placeholder that makes everything above it work first. Test it with two emulators
and assert the grids match ([`testing.md`](testing.md)).

### Then, in any order

These are independent of each other and each is a reasonable PR on its own:

- **`.worktreeinclude`** in `JanelaGit` — one `git ls-files` call plus a
  `clonefile` copy within the bounds in [`performance.md`](performance.md). Test
  against a real repository.
- **Automation** in `JanelaSession` — an `AutomationRunner` that creates terminals
  with `role: .automation`. Most of the work is ordering and the teardown timeout,
  not process handling, because the terminal already does that.
- **Attention policy** in `JanelaSession` plus a nine-line
  `AttentionDelivering` adapter in `JanelaApp`. The policy is pure and should be
  exhaustively tested; the adapter is not worth testing.
- **`JanelaForge`** — a new target beside `JanelaGit`, `gh`/`glab` behind
  `ForgeServing`. Start with the failure paths; they are the common ones.

---

## Debugging

```bash
# The daemon's log: one JSON record per line, newest last
tail -f ~/Library/Logs/sh.janela.Janela/janelad.log

# The app's log, from Tauri's log plugin, lands in the same directory
tail -f ~/Library/Logs/sh.janela.Janela/Janela.log

# Only the socket: connections, handshakes, refusals
grep '"category":"protocol"' ~/Library/Logs/sh.janela.Janela/janelad.log | tail -n 20

# Inspect the database (the daemon owns it; read-only is polite)
sqlite3 -readonly ~/Library/Application\ Support/sh.janela.Janela/janela.sqlite

# Start from a clean slate — with no daemon running
rm -rf ~/Library/Application\ Support/sh.janela.Janela ~/.janela ~/Library/Logs/sh.janela.Janela
```

A record is one line of JSON, `time` first:

```json
{"time":"2026-09-09T08:00:00.000Z","level":"info","category":"protocol","message":"listening"}
```

`level` is one of `debug`, `info`, `notice`, `warning`, `error`; `category` names
the subsystem; `fields` is present when the record carries any. The file rotates
at 4 MiB and one previous file is kept as `janelad.log.1`, so it costs at most
8 MiB however long the daemon runs — a log file is the classic place where
[AGENTS.md](../AGENTS.md) non-negotiable 9 gets forgotten.

A launchd daemon and one you started with `--foreground` write the same file, in
the same place; `--foreground` also mirrors every line to stderr, synchronously, so
a pipe shows a record when it happens rather than when the event loop next turns.
There is no `os_log` route and nothing to `log stream`: reaching the unified log
from Bun would need `bun:ffi`, which the layering gate keeps inside
`@janela/pty`, and the daemon opens its own file instead ([`apps/daemon/src/log-file.ts`](../apps/daemon/src/log-file.ts)).
That file is also why the LaunchAgent declares no `StandardErrorPath` — launchd
takes a literal path with no `~` expansion, and the plist is sealed into the
bundle for every user of the machine.

What never appears in it: terminal traffic, command output, file contents,
notification bodies, environment values (non-negotiable 11). A record is an id, a
count, an exit status, an error name. The sink enforces the shape — anything
carrying a control character or longer than 120 characters is written as
`<4096 characters elided>` — so if you find real content in there, that is a bug
worth filing.

### The daemon

The footgun of this architecture: **an old `janelad` staying resident while you
iterate on a new one.** Symptoms are a handshake refusal, or worse, behaviour from
code you edited ten minutes ago.

```bash
bun run daemon:status     # is one running, which binary, and who is connected
bun run daemon:restart    # SIGTERM: hangs up every terminal it holds and exits 0
lsof -U | grep janelad    # who is connected to the socket
```

An installed build registers a LaunchAgent, and a daemon that exits deliberately
stays down: the next client that fails to connect starts it again with
`launchctl kickstart gui/<uid>/sh.janela.janelad`. A dev build has no bundle, so
`SMAppService` reports `unsupported`, nothing is registered and the kickstart has
no service to start — in development the daemon is **yours** to run:

```bash
bun run desktop   # a daemon and the app together, in one terminal
bun run daemon    # the daemon alone: source, --foreground, your real HOME
```

`bun run desktop` is the two commands above in one place, and it is held to the same
rule you are: it **reuses** a `janelad` that is already listening rather than
killing it, because that daemon holds terminals and stopping them is the user's
call. The one it started itself is stopped on the way out, and it says so — an
orphan foreground daemon serving a checkout you have moved on from is the footgun
at the top of this section. Liveness is a connect, not a `stat`: the socket file
outlives a killed daemon, and the daemon's own bind takes that address over.

To run one that cannot touch your own sessions, move `HOME`: the socket, the
database and the log all derive from it.

```bash
bun run --cwd apps/daemon build          # the compiled sidecar; `bun run daemon:build` can hit turbo's cache and restore nothing
export ISO=/tmp/jdev && mkdir -p "$ISO"  # /tmp, never $TMPDIR: sun_path is 104 bytes
HOME=$ISO ./apps/daemon/janelad --foreground
HOME=$ISO bun run scripts/survival-probe.ts    # a second client, from another shell
tail -f $ISO/Library/Logs/sh.janela.Janela/janelad.log
```

`bun run web:isolated` is that recipe packaged for the browser client, so agents
working in parallel worktrees can each run the app without touching your daemon,
sessions or database. It derives everything from the checkout's path: `HOME` is
`/tmp/janela-iso/<id>`, `<id>` being the first eight hex digits of the sha256 of
the absolute checkout path, and the gateway's preferred port is `7412 +` the next
four hex digits modulo 1000 — stable across runs, never 7411, and the first free
port above it if that one is taken. Under that `HOME` it starts a daemon from
source, the gateway on the chosen port, and `vite build --watch` into
`apps/web/dist`, then prints the URL and every path. The isolated home gets
**symlinks** to your `.zshenv`, `.zprofile`, `.zshrc`, `.bashrc`, `.bash_profile`,
`.profile` and `.gitconfig`, so terminals in it have your shell; it deliberately
gets no `.ssh`, `.claude` or `.config` — nothing running under it can write into
your own state, and `claude` and `gh` inside it are logged out. A live socket
under that home is a previous isolated run of the same checkout and is reused;
the home persists across runs by design, and `rm -rf` after stopping is the clean
slate. The path is recorded in `.janela/isolated-home`, which is what
`.superset/teardown.sh` removes when the workspace is deleted. The gateway's
`launchctl kickstart` is inert here: a dev machine has no installed Janela to
register a service, and if one is installed it only fires while the isolated
daemon is down.

There is **no `--socket` flag, deliberately**: it would move the socket and leave
the database shared with the resident daemon, so two daemons would restore the same
sessions into two sets of terminals. `janelad` refuses any argument it does not
parse — exit 2, before it opens the database, binds the socket or creates the log
file — so nothing can be silently ignored again (#49).

The socket lives at `~/.janela/run/janelad.sock`, not in Application Support,
because `sockaddr_un.sun_path` is 104 bytes on macOS and the Application Support
path does not comfortably fit.

A daemon holding live terminals will not exit on its own, which is correct and
occasionally inconvenient. `bun run daemon:restart` terminates them deliberately;
that is the same cost a user pays after an app update, so it is worth feeling.

Profiling: see [`performance.md`](performance.md) § How to measure.

---

## Committing

`bun run check` must pass. Beyond that:

- Write commit messages that explain **why**. The diff shows what.
- Changing an architectural decision means writing it down in
  [`architecture.md`](architecture.md), in the same PR.
- Adding a user-visible concept means justifying it against
  [`product.md`](product.md) § Non-goals. The budget is four nouns: project,
  session, terminal, launch profile.
- Using the word "workspace" in code, copy or docs means you have not decided
  whether you mean a project or a session. Pick one.
- Changing the wire protocol means bumping its version and saying what an older
  peer does. "The user restarts the daemon" is an acceptable answer; silently
  killing their terminals is not.
