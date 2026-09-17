# `scripts/`

Workspace tooling. Each script is a `bun run` entry point; none is imported by
shipped code. The layering gate (`check-layers.ts`) and the module graph
(`layers.ts`) are described in [`architecture.md`](architecture.md) § Packages.

## `dev.ts` — `bun run desktop`, `bun run web`, `bun run web:isolated`

`bun run desktop:only` is `tauri dev`, and nothing in it starts `janelad`. An installed
build does not need it to: the app registers a LaunchAgent, launchd owns the
daemon's lifecycle, and a client that cannot connect runs `launchctl kickstart`
and retries. A development build has no `.app` bundle, so `SMAppService` reports
`unsupported`, no agent is ever registered, and the kickstart has no service to
start. The app then renders its last known state and retries forever — correct
behaviour (AGENTS.md § Non-negotiables 8) and a confusing first five minutes.

The rules it is held to:

- **It never stops a daemon it did not start.** A resident `janelad` holds the
  user's terminals, and terminating them is their explicit choice with a stated
  cost (non-negotiable 7). Two clients on one daemon is the design, so a live
  socket means *reuse* — and the provenance is printed, because "the app behaves
  like code I did not write" is the footgun of this architecture.
- **The daemon it did start is stopped on the way out**, and it says what that
  cost. An orphan foreground daemon serving a checkout you have moved on from is
  that same footgun, invisible in a fresh shell.
- **Liveness is a connect, not a `stat`.** A stale socket file outlives a killed
  daemon; testing for the file would refuse to start a daemon forever. The
  daemon's own bind path takes over a dead incumbent's address.
- **It starts nothing else.** No watcher restarts the daemon on a source change:
  that would hang up the terminals it holds every time you save.

- `socketPathUnder(home)` is the same path `@janela/daemon`'s `defaultSocketPath()`
  computes, spelled out rather than imported: a script is held to the layering
  rule too, and this one is a client's neighbour, not a daemon package.
- `daemonIsListening` closes the connection immediately without a handshake, which
  the daemon treats as any other client hanging up — so a run leaves one `peer
  left during handshake` record in the log it probed. That is the whole cost of
  asking, and it is the only honest way to ask.
- The daemon is started **from source, in the foreground, against the real
  `HOME`**: the same daemon `bun run daemon` starts, so there is one
  dev daemon and not a second flavour of it. No compile step, so an edit costs a
  restart rather than a build. Its entry point is absolute so the checkout it came
  from is visible in `ps`: a daemon run from source has no `janelad` in its command
  line, and `.superset/teardown.sh` has to recognise its own orphan without killing
  somebody else's.
- `residentDaemons` uses `pgrep` with two spellings, for the same reason
  `daemon-status.ts` does.
- The app is spawned with inherited stdio: `tauri dev` is the thing you are
  watching, and the terminal delivers Ctrl-C to the whole process group.
- A daemon that dies under the app is reported and the app is left alone: it
  renders its last known state and reconnects, which is exactly what a user's
  client does when launchd's daemon goes away. Restarting it here would also race
  the bind of whatever killed it.
- Shutdown removes the signal handlers, sets an exit code and lets the loop drain
  rather than calling `process.exit()`, which in a signal handler drops output that
  has not reached the file descriptor — and the dropped message is the one that
  matters: that a daemon was stopped, and terminals with it. An unref'd timer is
  the belt, so a handle nobody expected cannot hang the terminal.
- `lineSplitter` splits a byte stream into lines across chunk boundaries. A pipe
  hands over whatever the kernel had, which cuts a JSON record in half far more
  often than it looks like it should, and a half-record prefixed and printed is
  unreadable exactly when the daemon is telling you why it died. `MAX_LINE_LENGTH`
  is the bound a producer that never emits a newline is held to (non-negotiable 9);
  the sink already bounds a record at 120 characters, so it is slack rather than a
  limit anybody should reach.
- `dev.test.ts` puts its socket in `/tmp`, never `$TMPDIR`: `sun_path` is 104 bytes
  and macOS hands out `/var/folders/…` paths long enough to spend most of that
  before a filename. It asserts liveness with a connect rather than an
  `existsSync`, for the reason above.

`--web` (`bun run web`) swaps `desktop:only` for `web:only` — the gateway and the
browser client's Vite server;
`--isolated` (`bun run web:isolated`) runs the web client under a private `HOME`
so parallel worktrees never share a daemon, a database or a port:

- The home is `/tmp/janela-iso/<id>`, in `/tmp` for the `sun_path` reason above.
  `<id>` and the preferred gateway port both come from the sha256 of the resolved
  checkout path, so two worktrees never share a home or a preferred port, and the
  URL of one worktree is the same on every run. The port search walks upward
  from the preferred one; `PORT_ATTEMPTS` bounds it.
- The daemon and the gateway are spawned with the moved `HOME`; every address
  they use derives from it (`defaultSocketPath`, `defaultDatabasePath`,
  `defaultLogPath`). The web build keeps the real environment: it only writes
  `apps/web/dist`.
- The page is served from `apps/web/dist` through `vite build --watch` rather
  than the Vite dev server, so one port carries the page and `/ws` — the browser
  client connects to `ws://<location.host>/ws` — and the gateway's production
  `staticResponse` path is what gets exercised. Until the first build lands the
  gateway answers 503; the script waits for `dist/index.html` before printing the
  banner and warns instead of failing if it takes too long.
- The gateway's entry point is absolute for the same reason the daemon's is:
  `.superset/teardown.sh` finds its orphans by grepping `ps` for the workspace
  path.
- `seedDotfiles` links the shell rc files and `.gitconfig` from the real home and
  nothing else — no directories, so `.ssh`, `.claude` and `.config` stay out of
  reach — and never replaces an entry already in the isolated home.
- The gateway takes the app's place in the shutdown logic; the web build is a
  companion: it is stopped on the way out, and its exiting on its own is
  announced but does not end the run, because the gateway keeps serving the last
  build.

## `daemon-restart.ts` — `bun run daemon:restart`

The footgun of the two-process design is an old daemon staying resident while you iterate on a
new one: the app then talks to code you edited ten minutes ago, or refuses the
handshake outright (`development.md` § The daemon). It prints the cost rather than
hiding it — stopping the daemon closes the terminals it was holding, the same cost
a user pays after an app update, which is worth feeling.

## `daemon-status.ts` — `bun run daemon:status`

Two clients sharing one daemon is by design; a daemon built from a *different* checkout serving your app is
not, and it is the thing to check first when the app behaves like code you have not
written. It matches two spellings, because there are two ways to start one: the
compiled sidecar, whose command line contains `janelad`, and the source entry point
behind `bun run desktop`, which never mentions the word.

## `survival-probe.ts`

[`survival-proof.md`](survival-proof.md) needs a client whose viewport a human
chooses, so that step 5 — two clients on one terminal, the PTY sized to the
smaller — can be exercised against the running app rather than only in a test. The
app's own window cannot do it: its viewport is whatever the window measures.

It is deliberately the smallest client that can exist: a Unix socket,
`@janela/protocol`'s framing, and nothing else. It uses no `@janela/client`, so
what it proves is the protocol rather than our client library. A future `janela`
CLI is this, grown up.

```
bun run scripts/survival-probe.ts                       # what is running
bun run scripts/survival-probe.ts --attach <id> --columns 40 --rows 12
bun run scripts/survival-probe.ts --attach <id> --send 'stty size\n'
bun run scripts/survival-probe.ts --attach <id> --protocol-version 9
```

- The last form stages version skew, and the number has to be past
  `PROTOCOL_VERSION` to do it — 9 is the shipped version, so 6 is now *refused*
  from below as well. Anything outside the daemon's range is refused.
- It never creates, starts, stops or removes anything. The most it does is attach a
  viewport, which the daemon undoes when the socket closes. It never starts a
  terminal either: starting a process is the app's or the user's decision, and a
  probe that spawns a shell would be a poor guest.
- `SOCKET_PATH` is spelled out rather than imported, for the same layering reason as
  in `dev.ts`.
- `--send 'x\n'` translates the two characters into a newline, because `\n` typed at
  a shell is the Return key and requiring a literal newline inside a shell argument
  would be worse.
- The first repaint is copied at the point of decode: the payload is a view valid
  only until the next push.

## `scaffold.ts`

One-shot scaffolder for the workspace's `package.json` and `tsconfig.json` files,
driven by `layers.ts` so the dependency edges in the manifest and the ones in
`package.json` cannot disagree on the day they are written. The graph is generated
from the graph. It is not part of `check` and is not expected to be run again —
later edits are made by hand, and `check:layers` is what keeps them honest.

## `layers.test.ts`

`check-layers.ts` verifies that the *code* obeys the manifest. These tests verify
that the manifest still describes the architecture `architecture.md` claims — the
properties that would make the gate pass while the design was wrong. The expected
package list is the count derived from [`MIGRATION_MAP.md`](MIGRATION_MAP.md), so a
package going missing fails a test rather than a review.

## `turbo-outputs.test.ts`

The daemon's build does not write to `dist/`. `bun build --compile --outfile
janelad` writes the sidecar beside `package.json`, so the root `build` task's
`outputs: ["dist/**"]` caches nothing: a cache *hit* replays the logs, restores no
binary, and `apps/desktop/scripts/sidecar.ts` then fails at `copyFileSync` with
`ENOENT` (issue #48). `apps/daemon/turbo.json` declares the real output; these tests
ask turbo what it resolved, so the config and the build script cannot drift apart
silently. A root-level `@janela/janelad#build` entry would overwrite the base task
rather than extend it, dropping `dependsOn` and letting the daemon build race the
native library and the generated Prisma client.

The dry-run payload is parsed with a schema rather than asserted, because it is
turbo's output and not ours.
