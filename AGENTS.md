# AGENTS.md

Instructions for coding agents and human contributors working in this repository.
Read this before your first change. It is short on purpose.

---

## What Janela is

A native macOS **terminal session manager**: you spawn and arrange terminal
sessions, and the app makes switching between them cost nothing.

The one-sentence model: **a session is a directory with terminals in it, and a
project is where sessions come from.**

The one-sentence architecture: **a daemon owns the sessions; the app is one of its
clients.**

```text
Project          collapsible in the sidebar — a repository or folder you added
  └─ Session     a button — one working directory, one or more terminals
       └─ Terminal   a shell, an agent, a dev server; split and tabbed
```

A session may stand alone, with no project at all. A session inside a project may
run in the project's own directory (*simple*) or in a git worktree Janela created
for it (*worktree-backed*). Worktrees are one way a session's directory comes to
exist — not the point of the app.

Terminals run inside `janelad`, a per-user daemon, so they survive the window
closing. The app renders; the daemon runs things. A future CLI and a future browser
client are more clients of the same protocol.

If you are about to write code that contradicts that, stop and read
[`docs/product.md`](docs/product.md) first.

---

## Commands

Everything is a `bun run` script. Do not invent new invocations.

| Command | What it does | When |
| --- | --- | --- |
| `bun run bootstrap` | Install, generate the database client, build the native library | Once, first time |
| `bun run check` | `lint` + `typecheck` + `test` — exactly what CI runs | Before pushing |
| `bun run typecheck` | `tsc --build` across the workspace | Constantly — takes seconds |
| `bun test` | Run all tests | After every change |
| `bun run lint` | Oxlint, format check, **the layering gate and the FSD gate**, non-mutating | Before committing |
| `bun run format` | Fix formatting in place | When `lint` complains |
| `bun run check:layers` | The layering gate alone | When you touched a dependency edge |
| `bun run check:fsd` | The FSD structure gate alone (Steiger, inside `@janela/ui`) | When you moved a file inside `@janela/ui` |
| `bun run generate` | Regenerate the Prisma client | After touching `schema.prisma` |
| `bun run desktop` | A `janelad` **and** the Tauri app, in one terminal | When you need to see the window |
| `bun run desktop:only` | The Tauri app alone — `tauri dev`, and it starts no daemon | When a daemon is already running |
| `bun run desktop:build` | `tauri build` — the signed bundle | To make a release |
| `bun run web` | A `janelad`, the gateway **and** the browser client's Vite server, in one terminal | When you want the window in a browser at `http://localhost:1421` |
| `bun run web:only` | The gateway and the Vite server alone — no daemon | When a daemon is already running |
| `bun run web:isolated` | A `janelad`, the gateway **and** a watching web build under a private `HOME` in `/tmp/janela-iso/<id>` and a private port — never touches your own daemon | In an agent worktree, or whenever another checkout may be running |
| `bun run web:build` | Build the browser client into `apps/web/dist` | Before `bun run gateway` |
| `bun run gateway` | The gateway alone, serving `apps/web/dist` and `/ws` on `127.0.0.1:7411` | To reach the window from another device: `tailscale serve --bg 7411` |
| `bun run daemon` | `janelad` alone, from source, in the foreground, against your real `HOME` | When you want the daemon without a client |
| `bun run daemon:build` | Compile the `janelad` sidecar | Before `desktop:build`, or to run the compiled one by hand |
| `bun run daemon:restart` | Stop `janelad` so the next connection starts your build | When the app behaves like code you did not write |
| `bun run daemon:status` | Which `janelad` is resident, from where, and who is connected | When two checkouts might be fighting |

The grammar: the noun is the `apps/<dir>` it runs; bare runs it with a daemon,
`:only` runs the client alone, `:build` builds it, `:isolated` runs it under a
private `HOME`.

**Prefer `bun run check` over building the app.** It covers everything except the
Tauri shell and finishes in seconds; `bun run desktop` drives cargo and takes minutes.

Four things that will bite you once each:

- **Nothing in the app starts the daemon.** An installed build does not need it to:
  launchd owns `janelad`, and a client that cannot connect runs `launchctl
  kickstart`. A development build has no bundle, so it registers nothing and there
  is no service to start — `bun run desktop` starts one for you, and
  `bun run desktop:only` leaves you looking at a window that reconnects forever.
- **A resident `janelad` from another checkout will serve your app.** That is by
  design — it holds the user's terminals — but during development it means you are
  testing code you did not build. `bun run daemon:status` says who is running, and
  `bun run desktop` reuses whatever is listening rather than fighting it.
- **Prisma's CLI needs Node, not Bun**, and rejects unsupported versions. The pinned
  one is in `.node-version`. Nothing we ship uses it.
- **`bun run daemon:restart` is `pkill -x janelad`**, and stops the **user's
  installed** daemon from whichever worktree you run it in. It never reaches a
  `bun run web:isolated` daemon — for an isolated run, Ctrl-C is the stop.

---

## Branches

`dev` is the default branch and where work lands. `main` is the released state.

- **Branch off `dev`, and open every pull request against `dev`.** It is the
  repository default, so `gh pr create` already targets it and a fresh clone
  starts there.
- **Neither branch takes a direct push.** Both require a pull request, and the
  four CI checks must be green: `Lint, typecheck & test`, `Build the PTY
  library`, `Compile the daemon sidecar`, `Bundle and verify the app`. No
  approval is required — GitHub forbids approving your own pull request, and a
  one-maintainer repository that demanded one would merge nothing.
- **`main` moves when a version ships**, through a pull request from `dev`.
  Nothing else writes to it.
- **A `v*` tag is immutable.** Once pushed it cannot be moved or deleted, so a
  released version always means the same commit.
- Neither branch can be deleted or force-pushed by anyone, including an admin.
  The escape hatch is deliberate friction: disable the ruleset in **Settings →
  Rules**, act, enable it again. It leaves an audit-log entry, which is the
  point.

Required checks are not `strict`: a pull request does not have to be rebased
onto the tip of `dev` to merge. That keeps a queue of open pull requests from
re-running the macOS matrix on every merge, and costs the case where two
independently green branches break once combined — which the push run on `dev`
then reports.

---

## Repository layout

```text
apps/desktop/          The Tauri app. src-tauri/ is a THIN Rust shell; src/ is React.
apps/desktop/src/      The FSD `app` layer: entry, the object graph, adapters/ for the ports.
apps/daemon/           janelad. Process plumbing only — nothing testable.
apps/gateway/          The browser's shell: serves apps/web/dist, relays each WebSocket onto the socket.
apps/web/              The browser client. Same window, a WebSocket transport, no macOS ports.
packages/              All logic, as layered packages. Your work goes here.
packages/ui/src/       Feature-Sliced: pages/{main-window,settings}/ + shared/{model,config,ui,lib}/.
scripts/layers.ts      The module graph, as data. The architecture, enforced.
docs/                  Architecture, conventions, domain model. Read before designing.
docs/MIGRATION_MAP.md  Where everything went when the stack changed.
```

Inside `@janela/ui` imports point downward, `pages → shared`, and cross a slice or
a shared segment only through its `index.ts` — enforced by `steiger`
(`bun run check:fsd`). See
[`architecture.md`](docs/architecture.md) § Inside `@janela/ui`.

---

## The layering rule

Packages depend **downward only**. This used to be enforced by a compiler. It is now
enforced by `bun run check:layers`, which reads `scripts/layers.ts` — because
TypeScript does not check a module graph, and Bun's hoisting means an *undeclared*
import resolves and runs.

```text
                @janela/support     logging, errors, timing, bounded buffers
                       ↓            (+ /process — subprocess, daemon-only)
                @janela/core        domain types. Pure. No I/O.
                       ↓
                @janela/protocol    frames, messages, handshake, transport seam
                  ↙          ↘
    ==== daemon ====           ==== client ====
    git   pty   db   forge     client        connection, mirror, attention policy
    integrations
         ↓                        ↓
    terminal                   design        tokens and reusable controls
         ↓                        ↓
    session                    terminal-ui   the renderer surface
         ↓                        ↓
    daemon                     ui            views
         ↓                        ↓
    apps/daemon → janelad      apps/desktop  Tauri shell + composition root
    apps/gateway → the         apps/web      the browser client: same views,
      browser's shell                        a WebSocket transport, no macOS ports
```

**If you need an upward reference, you need an interface in the lower package
instead.** Adding a dependency edge that points sideways or upward is a design
change: write it down in [`docs/architecture.md`](docs/architecture.md) first,
then change `scripts/layers.ts`.

Four rules that catch most mistakes:

- **No client package may import a daemon package, or vice versa.** They meet only at
  `@janela/core` and `@janela/protocol`. This is what makes a CLI possible without a
  refactor, and why `@janela/ui` cannot spawn a process even by accident.
- Only `@janela/terminal` (daemon, headless) and `@janela/terminal-ui` (client, the
  view) may name a terminal library. Two seams, one rule.
- Nothing in `@janela/session` or below may import a view layer. The daemon detects
  attention, the client decides, the app delivers.
- `@janela/git` and `@janela/forge` are peers and must never import each other.
  Shared subprocess plumbing lives in `@janela/support/process`.

The gate also holds a table of **gated modules** — `bun:ffi` only in `@janela/pty`,
`bun:sqlite` and `@prisma/client` only in `@janela/db`, `node:child_process` only in
`@janela/support`, `@tauri-apps/*` only in `apps/desktop`. Each entry carries its
reason.

---

## Non-negotiables

These come from the product thesis. Violating one is not a style disagreement, it
is a change of direction, and belongs in [`docs/product.md`](docs/product.md)
before it belongs in code.

1. **Worktree-aware, not worktree-centric.** There is one `Session` type and one
   creation entry point. Do not add a parallel "worktree" list, screen, or type.
2. **Two levels, and no more.** Projects contain sessions; sessions contain
   terminals. No nested projects, no session groups, no folders, no tags.
3. **Never reimplement the user's tools.** Janela starts `claude`, it does not wrap
   it, parse its output, or model its tasks. Same for git beyond worktree
   plumbing, for `gh`/`glab` beyond reading state, and for the shell.
   The one sanctioned way to know what an agent is doing is the hook it runs
   itself, installed on request into its own configuration — see
   [`docs/packages/integrations.md`](docs/packages/integrations.md).
4. **The terminal owns the keyboard.** Do not add key bindings that shadow what a
   TUI expects. `Ctrl-anything` belongs to the running program — including split
   and tab navigation, which uses `⌘`-based chords only.
5. **Laziness is a feature.** A configured terminal that has not been started costs
   nothing. Do not eagerly spawn processes, read files, build emulators, or refresh
   forge state.
6. **The daemon is the source of truth; clients render a mirror.** A client never
   computes state it could ask for, and never writes state it did not receive. The
   app has no privileged path — if the CLI could not do it through the protocol,
   neither may the app.
7. **Never kill a user's terminals to make our lives easier.** Not on version skew,
   not on a failed handshake, not on app quit. Terminating them is always an
   explicit user choice with a stated cost.
8. **Nothing blocks across the socket.** The client renders its last known state
   when the daemon is slow or gone; the daemon never waits on a client. Both
   directions have bounded queues.
9. **No unbounded buffers.** Terminal output is effectively infinite. Anything
   accumulating it in memory needs a documented bound — scrollback, per-client
   output queues, `.worktreeinclude` copies, automation output, and any frame
   length read off a socket.
10. **Errors are either shown or logged, never both raw.** User-facing text goes
    through `UserFacingError`. Raw stderr never lands in a dialog headline. A
    missing or logged-out `gh` is silence, not an error banner.
11. **Never log terminal traffic**, command output, file contents, notification
    bodies, or environment values. It is the user's private data — and the daemon
    writes to the same system log the app does.
12. **Automation is visible.** Project commands run in a real terminal the user can
    watch and scroll back through. Nothing run on the user's behalf happens in a
    hidden process.

---

## Vocabulary

The words are load-bearing; UI copy and code use the same ones.

| Say | Not |
| --- | --- |
| project | repository, workspace, group, folder |
| session | workspace, worktree, tab, window |
| terminal | pane, shell, tab, session |
| automation script | hook, command, task, job |
| daemon, `janelad` | server, backend, service, agent |
| client | frontend, UI (when you mean the process) |
| attach / detach | connect, open, subscribe (when you mean one terminal) |

**"Workspace" is retired.** It used to be this app's central noun; it is now a
synonym for nothing. If a sentence wants it, that sentence has not decided whether
it means a project or a session. Full table in
[`docs/domain-model.md`](docs/domain-model.md) § Vocabulary.

---

## Conventions that matter

- **Strict TypeScript, and every strictness flag is on.** `noUncheckedIndexedAccess`
  and `exactOptionalPropertyTypes` included. They are not negotiable per-file.
- **No `any`, no non-null `!`.** Both are promises to the compiler with no evidence
  behind them, and the daemon is the wrong place to be optimistic. The linter
  enforces this.
- **No `console.log`.** Use the `log` categories in `@janela/support`. Never log
  terminal traffic, command output, file contents, notification bodies, or
  environment values — log the *shape*: an id, a count, an exit status.
- **Imports carry their `.ts` extension**, and `import type` is required for
  type-only imports.
- **Inside `@janela/ui`, a file lives in a slice or a shared segment.** Layers are
  `pages/` and `shared/`; segments are `ui`, `model`, `config`, `lib` and nothing
  else; every slice and every shared segment has one `index.ts`, and that is the
  only way in. Name files after the domain — no `types.ts`, `utils.ts` or
  `helpers.ts`. Do not add `features/` or `entities/` until a second consumer
  exists; `bun run check:fsd` will say so if you do.
- **Domain values are plain and JSON-shaped.** Timestamps are ISO strings, paths are
  strings. Everything in `@janela/core` crosses a socket.
- **Dependency injection through parameters.** There is no service locator and no
  module-level mutable state. The composition roots are `liveEnvironment()` in the
  app and `daemonEnvironment()` in the daemon.
- **No comments in TypeScript.** The only ones the linter leaves alone are
  `SAFETY:` (a real invariant the type system cannot state, naming the evidence
  that established it), `@ts-expect-error`, tooling directives (`oxlint-`,
  `eslint-`, `c8 `, `istanbul `), triple-slash references, and shebangs. Intent
  is carried by names, types, schemas and structure; durable rationale lives in
  `docs/`, per package in [`docs/packages/<name>.md`](docs/packages/). A
  `SAFETY:` spanning more than one line must be a single `/* … */` block — each
  `//` line is its own comment and only the first would be exempt.
- **Effect v4 at the seams, not as the runtime.** `Schema` at every untrusted
  boundary — control frames, persisted JSON, config, IPC — instead of `typeof`,
  `in` and `as`. `Schema.TaggedError` or `Data.TaggedError` for closed failure
  sets, matched with `Match.tag` / `Effect.catchTag` / `Predicate.isTagged` and
  never by reading `_tag`. `Match` instead of `switch`. `Effect.try`,
  `Effect.tryPromise`, `Effect.acquireRelease` instead of `try`/`catch`/
  `finally`. Never on the terminal byte path, never in a React render path, and
  never where it would introduce an unbounded buffer. See
  [`docs/architecture.md`](docs/architecture.md) § Effect at the seams.
- **argv is always an array**, with one named exception. Git invocations and PTY
  spawns take no shell, so the quoting bug class does not exist there. The exception
  is `AutomationScript.script` — a lifecycle script *is* the user's shell logic, and
  Janela hands it verbatim to their login shell with `-c`. It is the one string a
  shell ever interprets, it is authored by the user in an editor labelled as such,
  and it never contains anything Janela composed.

Full details: [`docs/conventions.md`](docs/conventions.md).

---

## Testing

- Tests use **`bun test`** (`describe`, `test`, `expect`), colocated as `*.test.ts`.
- In `@janela/ui` a test sits **inside the slice or segment it tests**, and obeys
  the same boundaries the code does: Steiger lints test files, so a test imports a
  segment's `index.ts` rather than a file behind it. Fakes live in
  `shared/lib/test-fakes`.
- `bun test` runs files **in sequence, in one process** — leftovers outlive the
  file that made them, and `--parallel` must stay possible. Never write to a fixed
  path; use `temporaryDirectory` and `gitFixture` from `@janela/test-support`.
- Git behaviour is tested against **real repositories** in temp directories. We do
  not mock git — a mock would only prove our assumptions. The same goes for
  `.worktreeinclude`, which is tested by creating a real worktree and looking at what
  landed in it, and for **PTYs**, where the interesting behaviour is exactly what a
  fake would paper over.
- Automation, attention policy and forge state are tested with **fakes**, because the
  logic under test is the decision, not the subprocess.
- The repaint encoder is tested by **round-tripping two emulators**: feed bytes to
  one, encode the damage, feed the result to a second, assert the grids match.

Full details: [`docs/testing.md`](docs/testing.md).

---

## Before you finish

Run `bun run check`. It must pass. Then confirm:

- [ ] Did you add a dependency edge? It must point downward, must not cross the
      daemon/client line except through `@janela/core` or `@janela/protocol`, and must
      be in **both** `scripts/layers.ts` and the package's `package.json`.
- [ ] Did you add a third-party import? Declare it in that package's
      `package.json` at the version already in `bun.lock`. `bun run check:layers`
      fails on an undeclared one — Bun's hoisting would otherwise resolve it.
- [ ] Did you add a file to `@janela/ui`? It goes in a slice or a shared segment,
      reached through that boundary's `index.ts`, and `bun run check:fsd` must pass.
- [ ] Did you write a comment? Only `SAFETY:`, `@ts-expect-error`, tooling
      directives, triple-slash references and shebangs survive the linter. Put
      the rationale in `docs/packages/<name>.md` and let names and types carry
      the intent.
- [ ] Did you change the wire protocol? Version it, and say what an older peer does.
- [ ] Did you add a concept a user has to learn? Justify it against
      [`docs/product.md`](docs/product.md) § Non-goals — the budget is three nouns.
- [ ] Did you use the word "workspace"? Replace it with project or session.
- [ ] Did you change an architectural decision? Write the reason down in
      [`docs/architecture.md`](docs/architecture.md).
- [ ] Does anything you added allocate per-byte or per-frame on the terminal path?
      Check the budgets in [`docs/performance.md`](docs/performance.md).
- [ ] Did you reach for Effect? It belongs at a seam — a boundary you are
      parsing, a closed failure set, a discriminant, an I/O lifetime — not on
      the terminal byte path or in a render path, and never where it adds an
      unbounded buffer.

---

## Current state

The repository is **implemented**. Every seam the scaffold left has a body, and the
central bet is proven end to end: `docs/survival-proof.md` records a run against an
installed, signed bundle where the app was quit and its terminals kept running. Read
that document before you change the daemon, the transport or the app lifecycle — it
also lists what could *not* be tested, and why.

What is not built is the **CLI**. Daemon ownership is justified partly on it, and
`@janela/protocol` was shaped to serve it, but `apps/` holds only `daemon` and
`desktop`. If you add it, it must go through the protocol like any other client.

The stack changed from Swift to Tauri and TypeScript. If you know the previous
codebase, or you are reading a document that mentions Swift, start with
[`docs/MIGRATION_MAP.md`](docs/MIGRATION_MAP.md) — every module, type and seam has a
row.

---

## Agent skills

### Issue tracker

GitHub Issues for `suiramdev/janela`. See `docs/agents/issue-tracker.md`.

### Domain docs

The domain model and its vocabulary live in
[`docs/domain-model.md`](docs/domain-model.md). See `docs/agents/domain.md`.
