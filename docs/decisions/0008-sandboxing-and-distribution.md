# 0008. Unsandboxed, hardened, notarized, outside the App Store

- **Status:** Accepted
- **Date:** 2026-08-12
- **Amended:** 2026-08-21 by [0024](0024-tauri-client-shell.md) — the bundle is
  assembled by Tauri's bundler rather than Xcode, and the daemon is a compiled Bun
  binary shipped as a sidecar. **The decision is unchanged and applies to both
  binaries**: unsandboxed, hardened runtime, Developer ID signed, notarized, stapled,
  direct download, not the Mac App Store. Two notes. First,
  `com.apple.security.cs.disable-library-validation` is now load-bearing for a second
  reason — the daemon `dlopen`s its embedded PTY library
  ([0021](0021-pty-native-layer.md)) as well as loading the user's unsigned tooling.
  Second, it is still exactly two executables: the daemon compiles to one file with
  everything embedded, so nothing else needs signing beside it.
- **Amended:** 2026-08-26 by [0015](0015-daemon-owned-sessions.md) — the bundle now
  ships a second executable and a LaunchAgent. Unsandboxed, hardened, notarized,
  outside the App Store is unchanged, and applies to both binaries.
- **Amended:** 2026-09-08 by #39 (the sidecar bundle) — unchanged in substance, three
  corrections of fact now that the bundle exists. **The daemon is at
  `Contents/MacOS/janelad`**, not `Contents/Resources/janelad`: Tauri's bundler copies
  `externalBin` into `Contents/MacOS` and signs what is there, and Apple treats a
  Mach-O under `Resources` as data rather than code. **The entitlements are exactly
  two**, in `apps/desktop/src-tauri/Entitlements.plist`, shared by both executables
  because the bundler signs every Mach-O with one entitlements file:
  `com.apple.security.cs.allow-jit` — measured, not assumed: under the hardened
  runtime without it JSC drops to the interpreter and a compute-bound script goes
  58 ms → 2692 ms — and `com.apple.security.cs.disable-library-validation`, without
  which the daemon's `dlopen` of its embedded PTY dylib fails outright (also
  measured). App Sandbox is off by the absence of the key, which is what the gate
  asserts. **The gate is `apps/desktop/scripts/verify-bundle.ts`**, not `make
  app-build`: it runs at the end of `bun run --cwd apps/desktop bundle`, in CI on
  every push against an ad-hoc signature, and demands a Developer ID authority, a
  secure timestamp, a stapled ticket and Gatekeeper acceptance when release
  credentials are present.

## Context

Janela's purpose is to run the user's own tools — their login shell, their
compilers, their coding agents, their `git`, their `gh` — in directories the user
chooses, with the user's own environment. It also creates directories the user did
not pick in an open panel: a git worktree is a new path, and the files
`.worktreeinclude` copies into it are more of the same.

The App Sandbox cannot express that. It is designed to constrain an app to
declared resources, and Janela's declared resource is "any executable, any path".
The available workarounds each break something:

- **Security-scoped bookmarks per repository.** Would work for paths the user picks
  in an open panel, but a `cd ..` in a terminal, a build writing to a sibling
  directory, or an agent reading `~/.config` all fall outside. The terminal would
  be constrained in ways a terminal never is.
- **A privileged helper.** Moves the unsandboxed code somewhere else without
  removing it, and adds an XPC boundary on the hot path.
- **`com.apple.security.inherit` on children.** Sandboxes the child too, which is
  precisely wrong: the user's compiler needs to write to the user's disk.

The security argument for sandboxing is also weaker than usual here. A sandbox
protects the user from the *app*. Janela's child processes are the user's own
tools, running with the user's authority, which they could equally start from
Terminal.app — which is itself not sandboxed.

## Decision

- **App Sandbox: off**, for the app *and* for `janelad`. The daemon is the one that
  actually spawns the user's tools now, so if either binary could be sandboxed it
  would be the app — and it cannot, because it must talk to a socket the sandbox
  would deny it.
- **Hardened Runtime: on** (required for notarization), with
  `com.apple.security.cs.disable-library-validation` so we can spawn and load the
  user's unsigned tooling.
- **Distribution:** Developer ID signed, notarized, stapled, direct download.
  **Not** the Mac App Store — the sandbox is mandatory there, so this decision
  forecloses that channel. The MAS also disallows the `SMAppService` agent layout
  [0017](0017-daemon-lifecycle.md) depends on, which makes that door doubly shut.
- **Two executables, one signature story.** `Contents/MacOS/Janela` and
  `Contents/MacOS/janelad` (`Contents/Resources/janelad` as first written; corrected
  by the 2026-09-08 amendment) are both Developer ID signed with the hardened
  runtime and notarized as one bundle. The LaunchAgent plist ships at
  `Contents/Library/LaunchAgents/`, sealed by the app's signature. Signing the app
  but not the daemon produces a bundle that notarizes and then fails at registration
  — a failure that appears at install time on a user's machine rather than in CI, so
  `bun run --cwd apps/desktop bundle` verifies both binaries' signatures before it
  exits.
- **No network entitlement is requested.** Janela does not phone home. Forge
  integration reaches the network only through the user's `gh`/`glab` child
  processes, which are their own — this app never opens a socket
  ([0012](0012-forge-integration.md)).
- **Notifications need authorization, not an entitlement.**
  `UNUserNotificationCenter` works in an unsandboxed, Developer ID-signed app, and
  we request permission lazily on first delivery rather than at launch
  ([0011](0011-notifications.md)).

## Consequences

**Good.** Terminals behave like terminals. No permission prompts mid-session, no
mysterious failures when a build touches a path outside a bookmark.

**Good.** Direct distribution means we control release cadence and there is no
review process to design around.

**Bad.** No Mac App Store. Accepted deliberately, and it is the hardest part of
this decision to reverse.

**Bad.** We must run notarization ourselves, including signing credentials in CI.
Those live outside the repository; `.gitignore` covers `*.p12` and
`notarization-credentials.json`, and `DEVELOPMENT_TEAM` belongs in a local,
gitignored `Secrets.xcconfig`.

**Bad, and now sharper.** TCC prompts. Users still see them for
Desktop/Documents/Downloads, triggered by
*child* processes but attributed to Janela. `Info.plist` usage strings say so
honestly rather than pretending Janela wants the access itself.

Since [0015](0015-daemon-owned-sessions.md) the file access happens in `janelad`,
which is its own responsible process — so the prompt names an unfamiliar background
binary instead of the app the user just clicked. That is materially worse, and it is
mitigated by a rule rather than an API: **the app owns the open panel, the daemon is
handed paths.** See [0017](0017-daemon-lifecycle.md) § TCC attribution.

**Note.** Some agents run their own sandboxing — Codex defaults to a Seatbelt
`workspace-write` profile
([`../research/agents-and-git.md`](../research/agents-and-git.md) § 746). That is
the agent's business and we neither add to nor subtract from it. It is also the
right layer for that control: per-tool, user-configured, not imposed by the
terminal.

## Alternatives considered

**Sandboxed with security-scoped bookmarks.** Rejected above: it constrains the
terminal in ways that break ordinary developer work, and the failures are confusing
rather than explicit.

**Sandboxed app + unsandboxed privileged helper.** Rejected: the same code runs
unsandboxed either way, and we would pay an XPC hop plus a much more complex
install and update story for a security boundary that mostly protects nothing.

## Revisit when

- Apple provides an entitlement that expresses "developer tool that runs user
  processes" — there has been movement in this area for other categories.
- Mac App Store distribution becomes a business requirement, at which point this
  ADR is superseded and a large amount of work follows.
