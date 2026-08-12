# Prior-Art Teardown: Orca, Superset, cmux

Primary-source teardown of three agentic-IDE / agent-orchestrator projects, read from their
repositories (source files, manifests, agent docs, CI config) and first-party docs sites. Every
non-obvious claim below cites a file path + URL. Nothing here comes from blog posts or third-party
write-ups.

Repos as read (default branch `main`):

| Project | Repo | Size on clone | License | Read via |
| --- | --- | --- | --- | --- |
| Orca | [stablyai/orca](https://github.com/stablyai/orca) | 504 MB | MIT | GitHub contents API + raw blobs |
| Superset | [superset-sh/superset](https://github.com/superset-sh/superset) | clonable | Elastic-2.0 | full local clone |
| cmux | [manaflow-ai/cmux](https://github.com/manaflow-ai/cmux) | 1375 MB | GPL | GitHub contents API + raw blobs |

---

## 1. cmux — native Swift/AppKit + libghostty

### 1.1 Tech stack

- **Native macOS app, no web layer.** README: *"Native macOS app — Built with Swift and AppKit, not
  Electron. Fast startup, low memory."* and *"GPU-accelerated — Powered by libghostty"*.
  ([README.md](https://github.com/manaflow-ai/cmux/blob/main/README.md))
- **Build system:** Xcode project (`cmux.xcodeproj`) + workspace (`cmux.xcworkspace`), not SwiftPM at
  the root. Pinned toolchain: [`.xcode-version`](https://github.com/manaflow-ai/cmux/blob/main/.xcode-version)
  contains `26.0`. Build verb is a wrapper script, never bare `xcodebuild`:
  `./scripts/reload.sh --tag <branch-slug> [--launch]`, which gives each build its own app name,
  bundle ID, control socket and DerivedData path so several agents can build concurrently
  ([CLAUDE.md § Build and reload](https://github.com/manaflow-ai/cmux/blob/main/CLAUDE.md)).
- **Terminal emulator + PTY:** libghostty, consumed as `GhosttyKit.xcframework`. The Ghostty fork is a
  git submodule (`ghostty` → `https://github.com/manaflow-ai/ghostty.git`,
  [.gitmodules](https://github.com/manaflow-ai/cmux/blob/main/.gitmodules)) and is rebuilt with Zig:
  `cd ghostty && zig build -Demit-xcframework=true -Dxcframework-target=universal -Doptimize=ReleaseFast`
  (CLAUDE.md). **There is no separate PTY layer**: libghostty owns the pty, the parser, the grid, and
  the Metal renderer. cmux only wraps surfaces
  (`Sources/GhosttyTerminalView.swift`, `Sources/GhosttyApp+ChildExitPolicy.swift`,
  `Sources/GhosttyNSView+IMEComposition.swift`, ~136 `Ghostty*` files in `Sources/`).
- **Split engine is vendored, not hand-rolled:** submodule `vendor/bonsplit` →
  `manaflow-ai/bonsplit` (.gitmodules); `Workspace.swift` imports `Bonsplit` and uses
  `bonsplitController` for layout snapshots.
- **Swift 6 / SwiftPM modules:** packages live under `Packages/{Shared,iOS,macOS}/<pkg>`. Example
  manifest: [`Packages/macOS/CMUXAgentLaunch/Package.swift`](https://github.com/manaflow-ai/cmux/blob/main/Packages/macOS/CMUXAgentLaunch/Package.swift)
  → `swift-tools-version: 6.0`, `platforms: [.macOS(.v14)]`.
- Distribution: DMG + Sparkle auto-update + Homebrew cask (README, submodule `homebrew-cmux`).

### 1.2 Domain model

Defined normatively in [`skills/cmux-workspace/SKILL.md`](https://github.com/manaflow-ai/cmux/blob/main/skills/cmux-workspace/SKILL.md):

```
Window    — a macOS cmux window
Workspace — a sidebar entry. The UI calls it a tab; CLI/socket APIs call it a workspace.
Pane      — a split region inside a workspace
Surface   — a tab inside a pane, terminal or browser
Panel     — internal content type inside a surface
```

Short refs are `workspace:1`, `pane:172`, `surface:240`. Ambient identity is injected into every
spawned process as `CMUX_WORKSPACE_ID`, `CMUX_SURFACE_ID`, `CMUX_SOCKET_PATH` (same file).

**There is no `worktree` noun in cmux's model.** A workspace is a directory + layout. Git branch, PR
number/status, listening ports and last notification are *sidebar metadata* rendered per workspace
(README feature table; packages `CmuxGit`, `CmuxSidebarGit`). `cmux ssh user@remote` creates a
workspace bound to a remote machine (README), which is the same noun as a local one.

Code location of the model: mostly the app-target god object `Sources/Workspace.swift`
(**618,613 bytes** —
[Workspace.swift](https://github.com/manaflow-ai/cmux/blob/main/Sources/Workspace.swift)), with types
lifted into `Packages/macOS/CmuxCore` and `Packages/macOS/CmuxWorkspaces`.

### 1.3 Git worktree handling

Essentially none, by design. The project's stated philosophy ([README § The Zen of cmux](https://github.com/manaflow-ai/cmux/blob/main/README.md)):

> *cmux is a primitive, not a solution. It gives you a terminal, a browser, notifications, workspaces,
> splits, tabs, and a CLI to control all of it. cmux doesn't force you into an opinionated way to use
> coding agents.*

Worktrees, if you want them, are something you create yourself in a terminal; cmux will show the
branch in the sidebar. This is the opposite pole from Orca.

### 1.4 Agent launch, supervision, resume, notification

- **Launch** goes through `Packages/macOS/CMUXAgentLaunch`, which is a *parser and policy* package,
  not a process supervisor. Files:
  `AgentLaunchInvocationClassifier.swift` (14,609 B),
  `AgentLaunchSanitizer.swift` (16,574 B) plus per-agent policy files
  (`AgentLaunchSanitizerCodexLaunch.swift`, `...ClaudeTeamsPolicy.swift`, `...GrokPolicy.swift`,
  `...KimiPolicy.swift`), `AgentLaunchEnvironmentPolicy.swift` (11,096 B),
  `AgentCwdNamespacing.swift`, `AgentRestorePlanner.swift` (12,373 B), `AgentForkArgv.swift`.
  ([dir listing](https://github.com/manaflow-ai/cmux/tree/main/Packages/macOS/CMUXAgentLaunch/Sources/CMUXAgentLaunch))
- **Process model:** the agent is just the child of a Ghostty surface's pty. There is no per-agent
  daemon. Child-exit behavior is a Ghostty policy (`Sources/GhosttyApp+ChildExitPolicy.swift`).
- **Resume** is modeled as a *surface resume binding* persisted per panel.
  `SurfaceResumeBindingSnapshot` in
  [`Sources/SessionPersistence.swift`](https://github.com/manaflow-ai/cmux/blob/main/Sources/SessionPersistence.swift)
  carries `command`, `cwd`, `checkpointId`, `source` (`"process-detected"` | `"agent-hook"` | `"cli"`),
  `environment`, `launchCommand`, `permissionMode`, `autoResume`, `approvalPolicy`
  (`manual|prompt|auto`), `launchFlavor` (`.local`/remote), `updatedAt`.
- **Resume is security-gated.** `SurfaceResumeApprovalRecord` is HMAC-signed
  (`signingPayloadData()` / `signed(secret:)` / `hasValidSignature(secret:)`), matched against a
  canonicalized argv prefix by `SurfaceResumeCommandCanonicalizer`. The generalizer explicitly
  **fails closed** rather than widening scope:

  > *"The generalized scope may only leave the session id itself unmatched. Arguments after the
  > session id (`codex resume <id> --yolo`) would be dropped from the scope and prefix matching would
  > re-authorize a different session with different options, so fail closed instead of widening the
  > policy."* (`SessionPersistence.swift`, `generalizedApprovalPrefix(forCommand:)`)

  Environment capture strips secrets by keyword (`API_KEY`, `TOKEN`, `SECRET`, `COOKIE`, …) via
  `isSensitiveEnvironmentKey` in the same file.
- **Notifications:** terminal escape sequences OSC 9 / 99 / 777 are ingested
  (`Sources/GhosttyDesktopNotificationIngress.swift`) plus a `cmux notify` CLI you wire into agent
  hooks; the pane gets a blue ring, the sidebar tab lights up, `Cmd+Shift+U` jumps to the most recent
  unread (README § Why cmux?). Sidebar status/progress/log are also pushable from an agent:
  `cmux set-status`, `cmux set-progress`, `cmux log` (cmux-workspace SKILL.md).

### 1.5 Persistence

Plain **Codable JSON snapshots**, no SQLite. From `Sources/SessionPersistence.swift`:

```swift
enum SessionSnapshotSchema { static let currentVersion = 1 }

enum SessionPersistencePolicy {
    static let autosaveInterval: TimeInterval = 8.0
    static let maxWindowsPerSnapshot: Int = 12
    static let maxWorkspacesPerWindow: Int = 128
    static let maxPanelsPerWorkspace: Int = 512
    static let maxScrollbackLinesPerTerminal: Int = 4000
    static let maxScrollbackCharactersPerTerminal: Int = 400_000
}
```

Two details worth stealing:

1. **Scrollback truncation is ANSI-aware.** `ansiSafeTruncationStart(in:initialStart:)` walks back to
   the last ESC, and if the cut lands inside a CSI sequence it advances past the terminator, "to avoid
   replaying malformed control bytes".
2. **Restore is suppressed under test/args.** `SessionRestorePolicy.shouldAttemptRestore` returns false
   for `CMUX_DISABLE_SESSION_RESTORE=1`, XCTest env markers, or *any* explicit launch argument
   (an argument is treated as explicit open intent).

Approval records are written with `JSONEncoder` (`.prettyPrinted, .sortedKeys`), `.atomic` write,
directory chmod `0o700`, file chmod `0o600`, and a `NotificationCenter` change post.

### 1.6 IPC / process architecture

- One app process. Terminal rendering, pty, and UI are in-process.
- **Unix-domain control socket** is the automation surface: `Packages/macOS/CmuxControlSocket`,
  default `/tmp/cmux.sock`, per-tag debug sockets `/tmp/cmux-debug-<tag>.sock`, with
  `CMUX_SOCKET_PASSWORD` and a capability model (`cmux capabilities --json`) that can be off,
  restricted to cmux-spawned processes, or open to all local processes (cmux-workspace SKILL.md).
- Remote/SSH is a separate package trio: `CmuxRemoteDaemon`, `CmuxRemoteSession`,
  `CmuxRemoteWorkspace`; the iOS companion rides `CmuxIrohTransport` (QUIC/iroh P2P).

### 1.7 Performance work — concrete evidence

CLAUDE.md § Pitfalls is a list of measured hazards, not vibes:

- *"Typing-latency-sensitive paths: `WindowTerminalHostView.hitTest()` in
  `TerminalWindowPortal.swift`, `TabItemView` in `ContentView.swift`, and
  `TerminalSurface.forceRefresh()` in `GhosttyTerminalView.swift` run on every keystroke."*
- *"**Do not add an app-level display link or manual `ghostty_surface_draw` loop.** Rely on Ghostty
  wakeups and its renderer, or typing lags."*
- *"SwiftUI list boundaries: no view below a `LazyVStack`/`LazyHStack`/`List`/`ForEach` boundary may
  hold an observable store reference, and no function called from `body` may write state. Violating
  either reintroduces the 100% CPU spin loop from
  [issue #2586](https://github.com/manaflow-ai/cmux/issues/2586)."*
- macOS-version behavior drift is treated as a first-class hazard:
  `URL(fileURLWithPath: "/").deletingLastPathComponent().path` returns `"/.."` on macOS 14/15 but
  `"/"` on macOS 26 ([issue #4529](https://github.com/manaflow-ai/cmux/issues/4529)).
- CI has a dedicated `.github/workflows/perf-activation.yml`, and the review-bot rule set encodes
  perf/concurrency invariants as files:
  `.github/review-bot-rules/{algorithmic-complexity,hot-path-allocating-formatting,swift-blocking-runtime,swift-expensive-sync-load,runtime-no-hacky-sleeps,swift-actor-isolation,swift-concurrency-modernization}.md`.

### 1.8 What cmux does well / what to avoid

**Well**

- Uses libghostty instead of writing a terminal. Zero terminal-emulation code to own; GPU renderer,
  IME, ligatures, Kitty graphics all come free, and it reads the user's existing
  `~/.config/ghostty/config` (README).
- `skills/cmux-architecture/SKILL.md` is the best written architecture contract of the three: a
  5-layer strict DAG (`Core → Services(actors) → Domain(@Observable @MainActor) → UI → Executable`),
  constructor injection only, **no `static let shared`, no namespace-enums, no free functions**, DocC
  required on public symbols, and an explicit Swift 6 forbidden list (`NSLock`, `DispatchQueue` as a
  mutex, Combine, `DispatchQueue.main.async`, completion-handler public APIs, `DispatchQueue.asyncAfter`,
  sleeping-as-synchronization) with named carve-outs.
- Tag-isolated dev builds (`reload.sh --tag`) so N concurrent agents can each build and launch the app
  without stealing focus or clobbering sockets. This is a genuinely good agentic-development
  affordance.
- Automation etiquette encoded in the CLI: `--focus false` on every creation/move verb, "never call
  `focus-pane`/`select-workspace` speculatively", build layout additively.

**Avoid**

- `Sources/Workspace.swift` at **618 KB** and `Sources/SessionPersistence.swift` at **82 KB**. The
  project's own CLAUDE.md names them: *"The god files (`ContentView.swift`, `Workspace.swift`,
  `TabManager.swift`, `cmuxApp.swift`) are what this rule exists to stop."* The architecture doc is
  aspirational; the app target is not there yet, and the doc admits it
  (*"Existing packages under `Packages/` predate this policy; do not use them as design references."*).
- Enormous surface creep for a terminal: iOS app + TestFlight pipeline, a ported browser automation
  engine, Cloud VM control plane, Stripe billing, Postgres backend, iroh relay minting, SDK publishing
  to npm/PyPI/crates/Go/Java, 21 translated READMEs, and a 205 KB CHANGELOG. `.github/workflows/`
  holds ~50 workflows.
- Test wiring is a manual pbxproj concern: *"a `.swift` file in `cmuxTests/` without a
  `PBXFileReference` + `PBXSourcesBuildPhase` entry is silently skipped, and both `xcodebuild test`
  and bot reviews pass with 'Executed 0 tests'"* (CLAUDE.md). That failure mode is a direct argument
  for a SwiftPM-first layout.

---

## 2. Superset — Electron + host-service + detached PTY daemon

### 2.1 Tech stack

From [`apps/desktop/package.json`](https://github.com/superset-sh/superset/blob/main/apps/desktop/package.json)
and the [root package.json](https://github.com/superset-sh/superset/blob/main/package.json):

- Electron `41.10.3`, `electron-vite 4.0.1`, `electron-builder 26.8.1`, React `19.2.3`,
  TypeScript `6.0.3`, Vite 7.
- Monorepo: **Bun 1.3.14** (pinned in `.bun-version`) + Turborepo 2.9, Biome 2.4 at root
  (*"Biome runs at root level (not per-package) for speed"* — AGENTS.md).
- Terminal: `@xterm/xterm 6.1.0-beta.289` + `addon-webgl 0.20.0-beta.297`, `addon-serialize`,
  `addon-unicode11`, `addon-ligatures`, `addon-image`, `addon-progress`, `@xterm/headless`.
- PTY: `node-pty 1.2.0-beta.14`, isolated in its own package
  [`packages/pty-daemon`](https://github.com/superset-sh/superset/blob/main/packages/pty-daemon/package.json)
  with `bin: { "pty-daemon": "./src/main.ts" }`, its own wire `protocol/`, `SessionStore`,
  `process-tree.ts`, and integration tests for `flow-control`, `handoff`, `signal-recovery`,
  `byte-fidelity`, `fd-lifecycle`, `kill-tree`.
- Editor: CodeMirror 6 (not Monaco). Diff: `@pierre/diffs`. State: Zustand + TanStack DB/Query/Router.
- Local storage: `better-sqlite3 12.11.1` + `drizzle-orm 0.45.2` (+ `libsql`).

### 2.2 Process / IPC architecture

Three tiers, and the boundary is enforced by a test
(`packages/host-service/src/no-electron-coupling.test.ts`):

```
Electron main  ──trpc-electron/IPC──▶  @superset/host-service (Hono + tRPC 11 + WS)
                                            │
                                            ├── spawn-or-adopt ─▶ pty-daemon (detached, own process)
                                            ├── off-loop worker tasks (git, etc.)
                                            └── connectRelay() ─▶ cloud relay (remote workspaces)
```

Evidence from [`packages/host-service/src/serve.ts`](https://github.com/superset-sh/superset/blob/main/packages/host-service/src/serve.ts):

- L26–30: *"Resolve the shell-env snapshot in the background — it must not block the server from
  listening (the login-shell probe can burn the full 8s budget)."*
- L32–38: *"Fire-and-track: kick off pty-daemon spawn-or-adopt without blocking host-service startup…
  Non-terminal requests (workspaces, git, chat) are unaffected if the daemon takes time to come up or
  fails entirely."*
- L72–75: *"Production keeps the daemon detached so PTYs survive host-service restarts."* Dev mode
  kills it on SIGINT/SIGTERM for clean iteration.
- L119–133: a permanent `upgrade` socket error listener, because a peer reset between Node's
  `'upgrade'` emit and ws adoption is *"an uncaught ECONNRESET at TCP.onStreamRead that takes down the
  whole process."*

Additional workers: `apps/desktop/src/main/git-task-worker.ts`, `apps/desktop/src/main/host-worker/`,
`packages/host-service/src/trpc/off-loop.ts`, and a supervisor/lock/respawn trio in the desktop main
(`lib/host-service-coordinator.ts` — 38 KB, `lib/host-service-lock.ts`, `lib/host-service-respawn.ts`).

### 2.3 Domain model

Two SQLite schemas exist simultaneously (mid-migration; see §2.7).

**Authoritative v2** — [`packages/host-service/src/db/schema.ts`](https://github.com/superset-sh/superset/blob/main/packages/host-service/src/db/schema.ts):

| Table | Key columns |
| --- | --- |
| `projects` | `repo_path`, `repo_owner/name/url`, `worktree_base_dir`, `branch_prefix_mode/custom`, `sparse_checkout_paths`, `naming_instructions` |
| `workspaces` | `project_id` (**nullable** → session workspace), `worktree_path`, `branch`, `head_sha`, `type ∈ {main, worktree, session}`, `pull_request_id`, `archived_at` + `archive_reason ∈ {merged, deleted}` |
| `terminal_sessions` | `origin_workspace_id`, `status`, `last_attached_at`, `dispose_requested_at` |
| `terminal_agent_bindings` | PK = `terminal_id`; `agent_id`, `agent_session_id`, `definition_id`, `last_event_type`, `ended_at`, `end_reason` |
| `host_agent_configs` | `preset_id`, `command`, `args_json`, `prompt_transport`, `prompt_args_json`, **`resume_args_json`**, `env_json` |
| `acp_sessions` | `acp_session_id`, `harness`, `cwd`, `last_stop_reason` |
| `host_settings` | single row `id = 1`: `worktree_base_dir`, `branch_prefix_mode/custom` |
| `pull_requests` | full PR mirror incl. `checks_json`, `merged_at` |
| `workspace_cloud_deletes` | tombstone queue for offline cloud sync |

Invariants encoded in SQL, not prose:
`uniqueIndex("workspaces_one_main_per_project").on(projectId).where(sql`type = 'main'`)`.

**Legacy v1** — [`packages/local-db/src/schema/schema.ts`](https://github.com/superset-sh/superset/blob/main/packages/local-db/src/schema/schema.ts):
`projects → worktrees → workspaces (type=worktree|branch) → workspace_sections`, plus a single-row
`settings` table with ~50 columns (terminal font/ligature/cursor/`terminal_parked_runtime_cap`,
editor font, notification volume, `worktree_base_dir`, …) and Electric-SQL-synced mirrors of cloud
`users`/`organizations`/`tasks`.

Top-level user nouns, in UI terms: **Project → Workspace (= a worktree, or the main checkout, or a
project-less "session") → Terminal / Agent / Pane**. AGENTS.md tells agents outright:
*"You're running inside a Superset workspace — an isolated git-worktree copy of this repo."*

### 2.4 Git worktree handling

[`packages/host-service/src/trpc/router/workspace-creation/shared/worktree-paths.ts`](https://github.com/superset-sh/superset/blob/main/packages/host-service/src/trpc/router/workspace-creation/shared/worktree-paths.ts):

```ts
// Kept outside the primary checkout so editors, file watchers, and
// ignore rules treat worktrees as separate trees, not nested ones.
export function defaultWorktreesRoot(): string {
  return join(homedir(), ".superset", "worktrees");
}
export function projectWorktreesRoot(projectId, worktreeBaseDir?) {
  return resolve(worktreeBaseDir ?? defaultWorktreesRoot(), projectId);
}
export function safeResolveWorktreePath(projectId, branchName, worktreeBaseDir?) {
  const projectRoot = projectWorktreesRoot(projectId, worktreeBaseDir);
  const worktreePath = resolve(projectRoot, branchName);
  if (worktreePath !== projectRoot && !worktreePath.startsWith(projectRoot + sep))
    throw new TRPCError({ code: "BAD_REQUEST",
      message: `Invalid branch name: path traversal detected (${branchName})` });
  return worktreePath;
}
```

- **Layout:** `~/.superset/worktrees/<projectId>/<branchName>`; base dir overridable host-wide
  (`host_settings.worktree_base_dir`) or per project. `normalizeWorktreeBaseDir` requires absolute or
  `~`-rooted paths.
- **Naming:** branch prefix mode is a first-class setting (`BRANCH_PREFIX_MODES`, host default in
  `host_settings`, per-project override —
  [`router/settings/branch-prefix.ts`](https://github.com/superset-sh/superset/blob/main/packages/host-service/src/trpc/router/settings/branch-prefix.ts)).
  Names come from (a) the typed name → `sanitizeBranchCandidate`, (b) an LLM title from the agent
  prompt (`generateWorkspaceNamesFromPrompt`), or (c) `generateFriendlyBranchName()` from
  `friendly-words`. Collisions go through `deduplicateBranchName`.
- **Adoption:** externally created worktrees are importable —
  `shared/adopt-existing-worktree.ts`, `procedures/adopt.ts`, `procedures/list-project-worktrees.ts`.
  (v1 schema kept `created_by_superset` boolean *"to prevent accidental deletion of user-created
  worktrees"*.)
- **Missing-on-disk is a normal state, not a 500:**
  [`router/git/utils/resolve-worktree.ts`](https://github.com/superset-sh/superset/blob/main/packages/host-service/src/trpc/router/git/utils/resolve-worktree.ts)
  raises `NOT_FOUND` with `cause: { kind: "WORKTREE_MISSING" }` — *"A worktree deleted outside the app
  is a routine lifecycle state, not a bug."*
- **Teardown before removal:**
  [`runtime/teardown/teardown.ts`](https://github.com/superset-sh/superset/blob/main/packages/host-service/src/runtime/teardown/teardown.ts)
  runs the project's `.superset/teardown.sh` (or configured `teardown` commands joined with `&&`)
  through *the same PTY primitive as user terminals* (`createTerminalSessionInternal(..., listed:false)`)
  so it inherits the login shell, PATH, nvm/rbenv. It keeps only a 4 KB output tail, has a
  `TEARDOWN_TIMEOUT_MS` plus a 2 s `KILL_GRACE_MS` hard stop *"so workspaceCleanup.destroy never hangs"*,
  and uses `exec bash -c '<cmd>'` because `$?` breaks under fish.
- **Deletion is a tombstone, not a delete:** `workspaces.archived_at` + `archive_reason`
  (`"merged"` when the linked PR merged at destroy time). Rows *"are kept forever and surface on the
  board's Merged/Deleted columns."*
- **Centrality: high but not absolute.** `type = 'session'` workspaces have `project_id = NULL` and are
  standalone git repos under `~/.superset/sessions/<name>`
  ([`procedures/create-session.ts`](https://github.com/superset-sh/superset/blob/main/packages/host-service/src/trpc/router/workspace-creation/procedures/create-session.ts)),
  and `type = 'main'` is the primary checkout.

### 2.5 Agent launch, supervision, resume, notification

- **Agents are configured rows**, not code: `host_agent_configs.command` + `args_json` +
  `prompt_transport` + `prompt_args_json` + `resume_args_json` (*"Args that resume a previous session;
  the session id is appended after them. Empty means the agent has no id-based resume."*).
- **Hook installation into the user's agent config** is generated code, one file per agent:
  `apps/desktop/src/main/lib/agent-setup/agent-wrappers-{claude-codex-opencode,cursor,copilot,gemini,amp,droid,grok,kimi,pi,vibe,mastra}.ts`,
  plus `managed-json-hooks.ts`, `managed-toml-block.ts`, `managed-skills.ts` and shell templates
  (`templates/notify-hook.template.sh` 7,884 B, `templates/opencode-plugin.template.js` 8,374 B,
  `templates/codex-wrapper-exec.template.sh`, `templates/pi-extension.template.ts`).
  `agent-wrappers.test.ts` is 63 KB.
- **Supervision** is a row per terminal in `terminal_agent_bindings`, updated on every hook event
  (`last_event_at`, `last_event_type`). The end-state distinction is exactly the one you need for
  resume:
  > *`"detached"` = the agent reported its own end (SessionEnd hook) — not resumable;
  > `"terminal-exited"` = the terminal died under it (kill, crash, reboot) — resume candidate.*
- **Reaper:** `startTerminalReaper(db)` is started after the server binds (serve.ts L106);
  `terminal_sessions.dispose_requested_at` is a *durable intent-to-kill* so a failed kill is retried
  *"regardless of workspace liveness (a one-shot renderer broadcast must not be the only chance to
  kill a session)."*
- **ACP path in parallel to PTY:** `@agentclientprotocol/claude-agent-acp 0.56.0`,
  `runtime/acp-sessions/acp-sessions.ts` (43,784 B) + `acp_sessions` table; offline rows are listed as
  `offline` and resurrected via the adapter's `session/load` — *"the journal itself is not persisted;
  transcript replay comes from the agent harness's own on-disk session store."*
- **Notifications:** `apps/desktop/src/main/lib/notifications/{server.ts,notification-manager.ts,map-event-type.ts,resolve-pane-id.ts}`
  — a local server receives hook callbacks, resolves them to a pane, and raises dock badge / chime.

### 2.6 Performance work — evidence

- Non-blocking startup (serve.ts, quoted above) and an explicit 8 s login-shell budget.
- Blocking is enforced by tests, not code review:
  `apps/desktop/src/no-main-process-blocking.test.ts` (6,486 B),
  `packages/host-service/src/no-main-loop-blocking.test.ts` (7,440 B),
  `packages/pty-daemon/src/no-daemon-loop-blocking.test.ts`,
  `packages/host-service/src/trpc/off-loop.test.ts`,
  `packages/pty-daemon/test/no-encoding-hops.test.ts` (byte-fidelity: no needless
  Buffer↔string conversions on the PTY hot path).
- Terminal flood profiling script: `apps/desktop/scripts/cdp-terminal-flood-profile.ts`
  (`bun run profile:terminal-flood`).
- Per-workspace port allocation to avoid dev-server collisions between many worktrees
  (`workspaces.port_base`, *"Each workspace gets a range of 10 ports starting from this base"*).
- `settings.terminal_parked_runtime_cap` — idle terminals are "parked" with a cap on live runtimes.
- `git-status-refresh-limiter.ts` (5,210 B, with a 9,876 B test) — rate-limits git status refresh.

### 2.7 What Superset does well / what to avoid

**Well**

- **The PTY daemon is a separate, detached process with its own wire protocol.** UI crash or
  host-service restart does not kill agents. This is the single most important structural decision in
  the repo, and it is tested (`test/handoff.test.ts`, `test/signal-recovery.test.ts`).
- **Electron-free service tier** with a test that forbids coupling — the same host-service runs
  headless for remote workspaces.
- Worktree path resolution is traversal-safe and lives in one small file.
- Workspace deletion is a tombstone plus a real teardown script run through the real terminal
  primitive.
- `end_reason` distinguishes "agent finished" from "terminal died", which is exactly the predicate
  resume/restore needs.

**Avoid**

- **Two live SQLite schemas** (`packages/local-db` v1 and `packages/host-service/src/db` v2) plus a
  `v1_migration_state` table, plus `workspaces.cloud_synced_at` and `workspace_cloud_deletes` marked
  *"Dual-write era only; the column and reconciler go away in R3."* Migration debt is visible in the
  domain model.
- **Cloud gravity in a local tool.** Building the desktop app locally requires Docker + Postgres +
  neon-proxy + Electric + Redis + Caddy with a trusted local CA
  ([DEVELOPMENT.md](https://github.com/superset-sh/superset/blob/main/DEVELOPMENT.md) §
  "What `setup.local.sh` does"). `apps/` contains `web, marketing, admin, api, desktop, docs, mobile`.
- **Agent hook installation writes into the user's global agent configs** (`~/.claude`, `~/.codex`,
  `opencode.json`, …). That is 11 wrapper generators and a 63 KB test file of accidental complexity
  that exists purely because CLI agents lack a uniform "notify my supervisor" contract.
- Renderer dependency sprawl: full CodeMirror language pack, TipTap (~35 packages), Mermaid, Shiki,
  Framer Motion, react-mosaic + react-dnd + dnd-kit + react-resizable-panels (three overlapping
  layout/DnD stacks) in one Electron renderer.

---

## 3. Orca — Electron, worktree-native, heavily instrumented

### 3.1 Tech stack

From [`package.json`](https://github.com/stablyai/orca/blob/main/package.json) (v1.4.178-rc.2):

- Electron `^43.1.0`, `electron-vite ^5.0.0`, `electron-builder ^26.15.3`, pnpm 10.24, Node 24,
  React `^19.2.7`, TypeScript `^7.0.2`, `vite: npm:rolldown-vite@7.3.1`, oxlint/oxfmt, Zustand 5,
  Monaco, TipTap, Tailwind 4, vitest 4, Playwright.
- Terminal: `@xterm/xterm 6.1.0-beta.287` + `addon-webgl 0.20.0-beta.286` + serialize / ligatures /
  search / unicode11 / fit / web-links, plus `@xterm/headless` in the main process.
- PTY: `node-pty ^1.1.0`.
- **All five terminal-critical deps are patched** (`pnpm.patchedDependencies`):
  `node-pty@1.1.0`, `@xterm/xterm@6.1.0-beta.287`, `@xterm/addon-webgl@0.20.0-beta.286`,
  `@xterm/addon-serialize`, `@xterm/addon-ligatures`. Patches live in `config/patches/`.
- Extras: `ssh2` (SSH worktrees), `@parcel/watcher`, `agent-browser ~0.27.0` (embedded Chromium
  automation), `sherpa-onnx` (on-device voice), `posthog-node`, `serve-sim`,
  `windows-native-registry`. Native macOS helpers are built separately
  (`build:computer-macos`, `build:notification-status-macos`).

### 3.2 Process architecture

Five build targets from one repo (package.json scripts + `bin`):

```
out/main/index.js       Electron main
out/cli/index.js        `orca` CLI (bin.orca)
relay                   build:relay → mobile/remote relay binary
renderer + preload      electron-vite
web                     build:web-from-renderer → browser client
```

Plus a **daemon**: `config/scripts/daemon-boot-smoke.mjs`,
`config/scripts/daemon-endpoint-handover-smoke.mjs`,
`tests/tools/benchmarks/daemon-coldstart-bench.mjs`,
`.github/workflows/daemon-relocation-spike.yml`, and `config/nsis/daemon-host-uninstall.nsh`.
Remote execution is modeled as an `ExecutionHostId` union: local, WSL distro, SSH target, or a remote
Orca server (`src/shared/execution-host.ts`, imported by persistence.ts).

### 3.3 Domain model

Types are in `src/shared/types.ts`; the import block at the top of
[`src/main/persistence.ts`](https://github.com/stablyai/orca/blob/main/src/main/persistence.ts)
enumerates them:

```
PersistedState, Project, ProjectGroup, ProjectHostSetup, Repo,
FolderWorkspace, WorktreeMeta, WorktreeLineage, WorkspaceLineage, WorkspaceKey,
OrcaWorkspaceLayout, TerminalPaneLayoutNode, TerminalLayoutSnapshot, TerminalTab,
WorkspaceSessionState / WorkspaceSessionPatch, SparsePreset,
GlobalSettings, NotificationSettings, OnboardingState, Automation / AutomationRun,
SshTarget, SshRemotePtyLease, ExecutionHostId
```

So: **ProjectGroup → Project → Repo → (Worktree | FolderWorkspace) → WorkspaceSession → TerminalTab /
pane layout**, with `Automation` as a scheduled producer of workspaces and `ExecutionHost` as an
orthogonal axis. `WorktreeLineage` / `WorkspaceLineage` model *worktrees created from worktrees*
(stacked work) — that lineage is what blows up the sidebar in §3.6.

AGENTS.md is explicit that worktree is not the only shape:
> *"**Folder Workspace Use Case** — All changes must consider folder workspaces as well as git
> worktrees. Don't assume every workspace is a git worktree."*

### 3.4 Git worktree handling — the most developed of the three

From the first-party docs ([onorca.dev/docs/model/worktrees](https://www.onorca.dev/docs/model/worktrees)):

> *"Orca is worktree-native. Instead of branching and stashing on one checkout, every task gets its
> own on-disk copy of the repo via `git worktree`."*

- **Model:** repo has a *base ref* (usually `origin/main`); each worktree has a *start-from ref*
  (base ref / another local branch / a commit SHA / a remote branch), its own branch, its own agent
  terminals. Base-ref resolution logic is
  [`src/main/worktree-create-base.ts`](https://github.com/stablyai/orca/blob/main/src/main/worktree-create-base.ts)
  (`resolveWorktreeCreateBase` — persisted repo base ref wins if still usable, otherwise fall back to
  the detected default).
- **Creation is asynchronous and cancellable:** *"Submitting the Create Worktree dialog closes it
  immediately — the `git fetch` and `git worktree add` work continues in the background… You can
  switch to other worktrees while a create is in flight, watch the progress, or cancel it."*
  Supporting files: `src/main/worktree-create-base-prefetch.ts`, `worktree-create-timing.ts`,
  `worktree-create-candidates.ts`, `worktree-root-preparation.ts`.
- **Naming:** branch derived from the workspace name, or from the linked GitHub PR / Linear issue /
  Jira issue / GitLab MR (Linear's own suggested branch name is used verbatim when available); explicit
  override in an Advanced drawer, hidden when the workspace is tied to a tracked work item *"to avoid a
  silently-ignored override"*. Emoji shortcodes in names are rewritten for the branch (`🚀 → rocket`).
- **The gitignored-state problem is solved three ways** (docs § Creation):
  1. per-repo *Worktree Shared Paths* (APFS clone-copy on macOS, else symlink);
  2. `orca.yaml → worktree.sharedDirectories` (repo-checked-in, symlink/share, must be gitignored
     directories — e.g. `node_modules`, `.cache`);
  3. `.worktreeinclude` at the repo root (gitignored files *copied* per worktree — `.env`,
     `.vscode/settings.json`; literal paths only, globs skipped with a warning).
- **Deletion is a rename, not an rm** —
  [`src/main/worktree-trash.ts`](https://github.com/stablyai/orca/blob/main/src/main/worktree-trash.ts),
  file header:
  > *"`git worktree remove` deletes the whole checkout (usually a multi-GB node_modules) inside the
  > remove IPC, so the UI sat on a spinner for 8-35s. Renaming the directory into a sibling trash root
  > is a metadata operation, and the recursive delete then runs after the IPC has already returned."*

  Implementation details worth copying: trash root is a **hidden sibling** `.orca-worktree-trash/`
  (same volume ⇒ rename always succeeds), entry names `wt-<epoch-ms>-<8 hex>` with a nonce for
  concurrent removals of same-named worktrees, `restoreWorktreeDirectoryFromTrash()` for rollback,
  a **serialized** background deletion queue (*"one background delete at a time keeps a burst of
  removals from saturating disk I/O while the user keeps working"*), a startup sweep for crash
  leftovers bounded by `TRASH_SWEEP_MAX_CONTAINERS = 200`, and a fallback to in-place delete when the
  rename is unavailable (cross-volume, Windows open handles).
- Related safety modules: `worktree-removal-safety.ts` (9,672 B, 17 KB test),
  `worktree-removal-authority.ts`, `worktree-removal-session-partition-fencing.ts`,
  `worktree-orphan-gitdir-proof.ts`, `worktree-lineage-pruning.ts`.
- **Centrality: total.** Worktree is *the* organizing noun; folder workspaces are the exception the
  codebase constantly has to special-case (`isFolderRepo()` appears throughout `persistence.ts` and
  `worktree-trash.ts`).

### 3.5 Persistence

**One JSON file.** From `src/main/persistence.ts`:

```ts
export function initDataPath(): void {
  const userDataDir = app.getPath('userData')
  _dataFile = join(userDataDir, 'orca-data.json')
}
// Why a sidecar: githubCache refreshes every poll and would rewrite the whole
// multi-MB orca-data.json each cycle.
function getGithubCacheFile(dataFile = getDataFile()) {
  return join(dirname(dataFile), 'orca-github-cache.json')
}
// Why: worktrees deleted outside Orca orphan their worktreeMeta, so the map grew
// monotonically (63% dead on a heavy install).
const WORKTREE_META_GC_GRACE_MS = 30 * 24 * 60 * 60 * 1000
```

Supporting machinery: `src/main/durable-file-write.ts` (`writeFileDurableSync`, `renameDurable`,
temp-file cleanup with `STALE_DURABLE_WRITE_TEMP_AGE_MS = 24h`), plus dedicated tests
`persistence-single-serialize.test.ts`, `persistence-async-write-syscalls.test.ts` (31 KB),
`persistence-protected-secret-{fail-closed,write-race}.test.ts`.

The costs of "one JSON blob" are all visible in the file itself: the multi-MB rewrite that forced a
sidecar, the manual GC with a 30-day grace period, a bespoke durable-write layer, and
`persistence.ts` at **299,455 bytes** with `persistence.test.ts` at **415,258 bytes**.

### 3.6 Performance work — the strongest evidence set of the three

[`docs/reference/renderer-agent-status-performance.md`](https://github.com/stablyai/orca/blob/main/docs/reference/renderer-agent-status-performance.md)
is a measured design doc. Its cost model:

```
burst work ~= status events x store listeners x selector work
```

**Measured baseline on `main` @ `077f5a11cd4` (macOS arm64, 16 CPUs, headless Electron):** 100
worktrees at lineage depth 99 with 100 seeded agent rows mounts 100 `WorktreeCard`s and
**9,279 Zustand store listeners**. 2,000 *no-op* store publications at 1 ms cadence:

| Measure | Median |
| --- | --- |
| Wall time for 2,000 publications | 12,325.7 ms (≈160 publications/s) |
| p50 / p95 scheduling drift | 5,150.3 ms / 9,802.9 ms |
| Renderer mean / p95 CPU | 18.25% / 32.59% |
| Idle control (0 publications) | 6.63% mean, 17.11% p95 |

⇒ *"Roughly 11.6 points of mean renderer CPU are attributable to publication fanout rather than to the
mounted fixture itself."* Zero long tasks were recorded — the cost shows up as drift and sustained
CPU, not discrete jank.

**After batching one IPC burst into a single store transaction:**

| Single 2,000-update burst | Sequential | Batched |
| --- | ---: | ---: |
| Status-state publications | 2,000 | 1 |
| Store action time | 3,692.0 ms | 188.7 ms |
| Update throughput | 541.7/s | 10,598.8/s |
| Renderer mean CPU | 36.2% | 2.9% |
| Renderer p95 CPU | 107.3% | 8.2% |
| p95 long task | 4,653 ms | 216 ms |

Root cause named explicitly: *"Virtualizing the root row does not virtualize its descendants, so a
100-worktree lineage can mount 100 `WorktreeCard` instances at once"* and *"Zustand synchronously
visits every listener for every publication."*

Institutionalized perf infrastructure (package.json scripts + `.github/workflows/`):

- Benchmarks: `bench:startup`, `bench:idle-cpu`, `bench:daemon-coldstart`, `bench:main-thread-jank`,
  `bench:worktree-deletion`, `bench:zustand-selector-fanout`, `bench:worktree-refresh-churn`,
  `bench:multi-workspace-typing`, `bench:cold-park-reveal`, `bench:cold-park-resource`,
  `bench:hang-watchdog-memory`, `bench:compare`.
- E2E perf gates: `.github/workflows/terminal-perf.yml`,
  `test:e2e:terminal-perf` (typing latency, foreground redraw freeze, output scheduler, hidden-TUI
  visual restore, artificial OpenCode load), `test:e2e:terminal-perf:scale`,
  `config/scripts/check-terminal-perf-report-budgets.mjs`, `test:e2e:source-control-scale`.
- Lint-level perf rules: `config/oxlint-plugins/quadratic-buffer-concat.mjs`,
  `config/oxlint-plugins/app-store-performance.mjs`, `check:zustand-selector-fanout`,
  `config/max-lines-baseline.txt` ratchet, `config/reliability-gates.jsonc`.
- Memory leak harnesses: `hibernation-output-epoch-leak-benchmark.mjs`,
  `happy-dom-mutation-observer-retention.ts`, `legacy-worker-recovery-persistence-benchmark.mjs`.

### 3.7 What Orca does well / what to avoid

**Well**

- The worktree lifecycle is the most complete design in the space: background create with cancel,
  start-from picker, gitignored-state materialization (three complementary mechanisms), trash-rename
  deletion, orphan sweeps, lineage pruning.
- Perf is a first-class artifact: a written design doc with a reproducible harness, a stated baseline,
  and CI budget gates. `config/scripts/compare-benchmark-artifacts.mjs` makes before/after
  comparisons a routine.
- `worktree-trash.ts` is a small, self-contained, copy-worthy module.
- Deliberate cross-cutting constraints in AGENTS.md (git binary ≥2.25 baseline with
  `GitCapabilityCache` per execution host; remote wire compatibility rules; glibc 2.31 floor).

**Avoid**

- `src/main/persistence.ts` opens with
  `/* eslint-disable max-lines -- Why: persistence keeps schema defaults, migration, and load/save/flush
  in one file so the storage contract reviews as a unit. */` — in a repo whose own AGENTS.md says
  **"NEVER add a `max-lines` disable."** A 300 KB file with a self-justifying suppression is the
  canonical sign of a missing storage abstraction.
- `src/main/` is a **flat** directory of thousands of sibling `.ts`/`.test.ts` files
  (repo tree reports 13,649 entries; `src/main` listing alone is 276 KB of JSON). Naming discipline
  (`worktree-removal-session-partition-fencing.test.ts`) is doing the job a module boundary should do.
- A single JSON state blob that grew to multi-MB, needed a cache sidecar, a bespoke durable-write
  layer, and a monotonic-growth GC. Any of the three would have been avoided by SQLite.
- Combinatorial platform matrix: macOS × Windows × Linux × WSL × SSH × remote Orca server × folder
  workspace × relay/mobile, on top of GitHub/GitLab/Bitbucket/Azure DevOps/Linear/Jira integrations,
  i18n in 7 languages, computer-use, embedded browser, on-device voice.

---

## 4. Comparison

| Dimension | **Orca** | **Superset** | **cmux** |
| --- | --- | --- | --- |
| Shell | Electron 43 + electron-vite 5 | Electron 41 + electron-vite 4 | Native Swift/AppKit + SwiftUI |
| UI | React 19, Zustand, Monaco, Tailwind 4 | React 19, TanStack DB/Router, CodeMirror 6 | SwiftUI + AppKit, `@Observable` |
| Terminal | xterm.js 6 + WebGL (5 forked/patched deps) | xterm.js 6 + WebGL | **libghostty** (GhosttyKit.xcframework, Metal) |
| PTY | `node-pty` 1.1 (patched), in main process | `node-pty` 1.2, in a **detached daemon** | owned by libghostty, in-process |
| Build/pkg | pnpm 10 + electron-builder, Node 24 | bun 1.3 + turbo + electron-builder | Xcode 26 project + SwiftPM packages |
| Processes | main, renderer, preload, CLI, relay, daemon, native helpers | Electron main, host-service (Hono/tRPC/WS), pty-daemon, git worker, relay | one app process + control socket + remote daemons |
| IPC | Electron IPC + relay wire protocol (versioned, capability-negotiated) | tRPC over IPC/HTTP/WS + daemon socket protocol | UNIX socket, password + capability gated |
| Persistence | **one `orca-data.json`** (multi-MB) + github cache sidecar | **SQLite ×2** (Drizzle): host-service v2 + legacy local-db v1 | **Codable JSON snapshots**, schema v1, 8 s autosave |
| Top nouns | ProjectGroup → Project → Repo → Worktree\|FolderWorkspace → Session → TerminalTab | Project → Workspace(`main`\|`worktree`\|`session`) → TerminalSession → AgentBinding | Window → Workspace → Pane → Surface → Panel |
| Worktree path | per-repo container under a workspace root | `~/.superset/worktrees/<projectId>/<branch>` | n/a |
| Worktree centrality | **total** ("worktree-native") | high, but `main`/`session` types exist | **none** — it's a terminal |
| Worktree delete | rename → `.orca-worktree-trash/wt-<ts>-<nonce>`, serialized bg delete, startup sweep | teardown script in hidden PTY → `archived_at` tombstone (rows kept forever) | n/a |
| Agent launch | CLI agent in a pty tab; hooks + `orca` CLI | DB-configured argv (`command`+`args_json`+`resume_args_json`); generated hooks per agent | argv classifier/sanitizer package; agent is a Ghostty child |
| Agent finish signal | agent hooks → main → renderer status events | hook → notifications server → dock badge/chime; `end_reason` in DB | OSC 9/99/777 + `cmux notify` CLI → pane ring + sidebar |
| Resume/attach | session/PTY leases, `SshRemotePtyLease`, hibernation/park | `terminal_agent_bindings.end_reason` decides resumability; ACP `session/load` | signed `SurfaceResumeApprovalRecord` + resume binding |
| Perf artifacts | design doc + 12 benchmarks + CI budget gates + perf lint plugins | anti-blocking unit tests, off-loop workers, CDP flood profiler | hot-path list in CLAUDE.md, perf CI, review-bot rules |
| Biggest smell | 299 KB `persistence.ts` w/ self-granted `max-lines` waiver | two live SQLite schemas + Docker/Postgres/Electric to build locally | 618 KB `Workspace.swift`; SaaS/iOS/browser scope creep |

---

## 5. Implications for Janela

Opinionated, concrete, and scoped to a native Swift 6.3 / macOS 26 SDK / arm64 app.

### 5.1 Terminal: take libghostty, do not take xterm.js and do not write an emulator

cmux proves libghostty is viable as an embedded framework and that the integration cost is mostly
AppKit plumbing (`Ghostty*` files) rather than emulation. Orca's five patched terminal dependencies
(`config/patches/@xterm__*`, `node-pty@1.1.0.patch`) and Superset's beta-pinned xterm stack are the
price of the web path. Concretely:

- Vendor Ghostty as a submodule and build `GhosttyKit.xcframework` with
  `zig build -Demit-xcframework=true -Dxcframework-target=universal -Doptimize=ReleaseFast`; cache the
  artifact in CI (cmux has a dedicated `build-ghosttykit.yml`).
- Copy cmux's hard rule verbatim: **no app-level `CVDisplayLink` and no manual `ghostty_surface_draw`
  loop.** Drive redraw from Ghostty wakeups only.
- Ghostty owns the PTY. Do not add a second PTY layer. Do not add a "PTY daemon" in v1 (see §5.4).

### 5.2 Domain model: workspace-centric, worktree-aware — encode it in the schema

Use Superset's v2 shape, minus the cloud, and adopt its `type` discriminator so worktree-ness is a
property rather than an identity:

```
Project   (repoPath, defaultBaseRef, worktreeBaseDir?, branchPrefix policy)
Workspace (projectId?, path, branch?, kind: .main | .worktree | .folder | .scratch,
           archivedAt?, archiveReason?)
Session   (workspaceId, surfaceId, agentKind?, agentSessionId?, startedAt,
           endedAt?, endReason: .agentReported | .processExited | .killed)
Surface / Pane / Tab  (layout only)
```

Two invariants worth enforcing in SQL rather than in Swift, as Superset does:
`UNIQUE(projectId) WHERE kind = 'main'`, and a foreign key from `Session.workspaceId` with
`ON DELETE SET NULL` so a dead workspace never orphans a live pty row.

Do **not** copy cmux's naming split where the UI says "tab" and the API says "workspace" — that
mismatch shows up in its own agent docs as a required clarification.

### 5.3 Persistence: SQLite via GRDB, not a JSON blob, not Codable snapshots

Orca's `orca-data.json` is the counterexample: multi-MB rewrites forced a cache sidecar, a bespoke
durable-write module, a manual 30-day GC for orphaned `worktreeMeta` (*"63% dead on a heavy install"*),
and a 299 KB persistence file. cmux's Codable snapshot avoids that only by capping itself
(12 windows, 128 workspaces, 512 panels, 4,000 scrollback lines) — caps that directly contradict
Janela's "many concurrent sessions" goal.

- Use GRDB with versioned migrations. One `janela.sqlite` in
  `~/Library/Application Support/Janela/`. WAL mode. All writes on a single writer queue behind an
  `actor`.
- **Scrollback does not belong in the state store.** Keep per-surface scrollback in separate
  append-only files (or let Ghostty own it), referenced by id. Steal cmux's ANSI-safe truncation
  (`ansiSafeTruncationStart`) if you ever trim a saved buffer — a cut inside a CSI sequence replays
  garbage.
- Steal cmux's `SessionRestorePolicy.shouldAttemptRestore`: skip restore under any explicit launch
  argument, any XCTest env marker, and an explicit `JANELA_DISABLE_SESSION_RESTORE=1`.
- Autosave on a debounce, not a timer, and never on the main actor. cmux's 8 s fixed interval is a
  reasonable ceiling, not a target.

### 5.4 Process model: single process first; earn a daemon with a measurement

Superset's detached `pty-daemon` is the right end state (agents survive a UI crash or update) but it
costs a wire protocol, a supervisor, a lock file, a respawn path, a reaper, and ~10 integration test
files. For v1:

1. Single app process, Ghostty-owned ptys.
2. Persist enough to *restart* an agent (`command`, `cwd`, `env` minus secrets, `agentSessionId`,
   resume argv) rather than to *reattach* to it — Superset's `resume_args_json` model, where resume is
   "append the session id to a configured argv", is cheap and covers Claude Code / Codex / OpenCode.
3. Only if measurement shows crash-loss is real, add a detached pty broker, and copy Superset's
   startup discipline: spawn-or-adopt off the critical path, requests that do not need the daemon
   never wait for it.

Whatever you build, expose a **UNIX control socket** from day one (cmux's `CmuxControlSocket` +
`CMUX_WORKSPACE_ID`/`CMUX_SURFACE_ID`/`CMUX_SOCKET_PATH` env injection). It is what makes agents able
to drive the IDE, and it is far cheaper in a native app than Electron IPC. Copy the capability gate
(off / cmux-spawned-only / all-local) and the `--focus false` convention on every mutating verb.

### 5.5 Agent completion signalling: OSC first, hooks as an optional upgrade

Superset generates and installs wrappers/hooks into eleven different agents' global configs
(`agent-wrappers-*.ts` + a 63 KB test). That is a maintenance treadmill tied to other people's config
formats. cmux's approach — ingest OSC 9 / 99 / 777 from the terminal stream, plus a `cmux notify` CLI
users can wire into hooks themselves — gets 80% of the value at ~2% of the cost, and works with any
agent that emits a bell/notification.

For Janela: ingest OSC 777/99/9 in the Ghostty notification callback; ship a `janela notify` CLI;
document the hook snippets rather than writing them into `~/.claude`. Persist a per-session
`endReason` distinction (`agentReported` vs `processExited`) — Superset's comment is the clearest
statement of why it matters: only `terminal-exited` is a resume candidate.

If you do implement automatic resume, copy cmux's **signed approval record** design
(`SurfaceResumeApprovalRecord` + `SurfaceResumeCommandCanonicalizer`): canonicalize argv, match a
prefix, HMAC-sign the record, and **fail closed** when the generalized prefix would also authorize a
different command. Auto-relaunching a persisted shell string is otherwise a local code-execution
primitive.

### 5.6 Worktrees: adopt Orca's mechanics, reject Orca's centrality

Janela is worktree-*aware*. Implement the worktree as an optional workspace kind, with these
borrowed mechanics:

- **Path layout:** Superset's `<baseDir>/<projectId>/<branchSlug>` with an explicit traversal guard
  (`safeResolveWorktreePath`). Keep worktrees *outside* the primary checkout — Superset's comment
  explains why (file watchers, ignore rules, editor indexing).
- **Deletion:** Orca's `worktree-trash.ts` design, essentially verbatim — rename into a hidden sibling
  `.janela-worktree-trash/wt-<epochMs>-<nonce>`, return from the API immediately, delete on a
  serialized background queue, sweep leftovers at launch (bounded), and keep a restore path for a
  failed registration. On APFS the rename is O(1) and this converts an 8–35 s spinner into a no-op.
- **Creation is async and cancellable**, with live status in the workspace's own tab (Orca docs).
  Never block the UI on `git fetch` + `git worktree add`.
- **Gitignored state:** support a repo-level include list (`.worktreeinclude`-style copies for `.env`)
  and a shared-directory list (clonefile/`APFS` copy or symlink for `node_modules`). On macOS 26 use
  `clonefile(2)` — Orca already documents APFS clone-copy as the preferred mechanism.
- **Missing on disk is normal.** Model it as a workspace state, not an error (Superset's
  `WORKTREE_MISSING`). Archive with a tombstone rather than deleting rows.
- Skip lineage/stacked-worktree trees in v1. Orca's 100-deep lineage is precisely what produced the
  9,279-listener renderer pathology.

### 5.7 Performance: set the budgets before the code exists

Both Electron projects converge on the same three hot paths — keystroke→glyph latency, output flood
handling, and per-session fanout at scale. Native removes the second and third *only if the
architecture cooperates*.

- **Adopt cmux's SwiftUI rule as a hard invariant:** no view below a
  `LazyVStack`/`LazyHStack`/`List`/`ForEach` boundary may hold an observable store reference, and no
  function called from `body` may write state. cmux's issue #2586 (100% CPU spin) is the failure mode;
  the fix pattern is a value-typed action struct passed down (`IndexSectionActions` in
  `Sources/SessionIndexView.swift`).
- **Orca's cost model generalizes:** `burst work ≈ events × observers × selector work`. In SwiftUI the
  `observers` term is "how many views observe the same `@Observable`". Design the sidebar so a status
  update for session *N* touches exactly one row: per-session `@Observable` leaf models, never a global
  store that every row reads.
- **Batch agent-status bursts.** Orca's measured win — 2,000 publications → 1, store time
  3,692 ms → 189 ms, renderer mean CPU 36.2% → 2.9% — is the single highest-leverage optimization in
  the whole corpus. Coalesce on a ~33 ms window, apply in event order, run side effects *after* the
  commit.
- **Write the benchmarks in week one**, following Orca's harness shape: cold start, idle CPU with N
  idle sessions, typing latency under flood, worktree create/delete wall time, memory RSS at N=50
  sessions. Emit a JSON artifact and add a `compare-benchmark-artifacts` step so regressions are a CI
  diff, not a vibe. Orca's `--zustand-publications 0` idle control is a good pattern: always measure a
  control run at the same fixture scale so you can attribute CPU.
- **Idle sessions must be cheap.** Both Electron apps invented "parking"/"hibernation"
  (`settings.terminal_parked_runtime_cap`, `bench:cold-park-reveal`,
  `hibernation-output-epoch-leak-benchmark.mjs`). Design for it up front: an unfocused surface should
  hold a pty + a ring buffer and *zero* renderer/observer cost.

### 5.8 Codebase discipline: take cmux's architecture doc, not cmux's codebase

`skills/cmux-architecture/SKILL.md` is directly applicable to Janela and mostly free to adopt on day
one, when there is no legacy: strict 5-layer DAG, `actor` services with `AsyncStream` observation,
`@MainActor @Observable` domain models, constructor injection with the app target as the single
composition root, no `static let shared`, no namespace-enums, no free functions, one major type per
file, DocC on every public symbol, and the Swift 6 forbidden-primitive list (locks, `DispatchQueue`
as a mutex, Combine, `DispatchQueue.main.async`, `DispatchQueue.asyncAfter`, sleep-as-synchronization)
with named carve-outs for `DispatchSource` file/socket watching and one-shot compare-and-set locks in
synchronous `Process` callbacks.

Two structural choices that follow from what went wrong in all three repos:

1. **SwiftPM-first, thin app target.** cmux is migrating *out of* a monolithic Xcode target and pays
   for it with pbxproj group-membership scripts, workspace-mirroring checks
   (`scripts/check-workspace-package-groups.py`), and silently-skipped tests. Start with
   `Packages/` + a `Package.swift` per module and a shell app target.
2. **A hard file-size ceiling with no waiver mechanism.** Orca has a max-lines lint rule, a
   `config/max-lines-baseline.txt` ratchet, an AGENTS.md prohibition on disables — and a 299 KB
   persistence file with a disable comment at line 1. cmux names its own god files in CLAUDE.md and
   has a 618 KB `Workspace.swift`. Enforce the limit in CI with no escape hatch, from commit 1.

### 5.9 Explicit non-goals for v1, learned from the corpus

Everything below is present in at least one of the three and is a measurable drag on all of them:
embedded browser/Chromium automation, mobile companion app, cloud sync / auth / billing, remote-host
execution (SSH/WSL/relay), on-device voice, computer-use, issue-tracker integrations beyond a link
field, i18n, and a plugin system. Each is defensible eventually; none of them is why a terminal-first
native IDE would win, and each multiplies the platform matrix that both Electron projects are visibly
struggling with.

---

## Source index

**cmux** — [README.md](https://github.com/manaflow-ai/cmux/blob/main/README.md) ·
[CLAUDE.md](https://github.com/manaflow-ai/cmux/blob/main/CLAUDE.md) ·
[skills/cmux-architecture/SKILL.md](https://github.com/manaflow-ai/cmux/blob/main/skills/cmux-architecture/SKILL.md) ·
[skills/cmux-workspace/SKILL.md](https://github.com/manaflow-ai/cmux/blob/main/skills/cmux-workspace/SKILL.md) ·
[Sources/SessionPersistence.swift](https://github.com/manaflow-ai/cmux/blob/main/Sources/SessionPersistence.swift) ·
[Sources/Workspace.swift](https://github.com/manaflow-ai/cmux/blob/main/Sources/Workspace.swift) ·
[.gitmodules](https://github.com/manaflow-ai/cmux/blob/main/.gitmodules) ·
[.xcode-version](https://github.com/manaflow-ai/cmux/blob/main/.xcode-version) ·
[Packages/macOS/CMUXAgentLaunch/](https://github.com/manaflow-ai/cmux/tree/main/Packages/macOS/CMUXAgentLaunch) ·
issues [#2586](https://github.com/manaflow-ai/cmux/issues/2586), [#4529](https://github.com/manaflow-ai/cmux/issues/4529)

**Superset** — [root package.json](https://github.com/superset-sh/superset/blob/main/package.json) ·
[apps/desktop/package.json](https://github.com/superset-sh/superset/blob/main/apps/desktop/package.json) ·
[packages/pty-daemon/package.json](https://github.com/superset-sh/superset/blob/main/packages/pty-daemon/package.json) ·
[packages/host-service/src/serve.ts](https://github.com/superset-sh/superset/blob/main/packages/host-service/src/serve.ts) ·
[packages/host-service/src/db/schema.ts](https://github.com/superset-sh/superset/blob/main/packages/host-service/src/db/schema.ts) ·
[packages/local-db/src/schema/schema.ts](https://github.com/superset-sh/superset/blob/main/packages/local-db/src/schema/schema.ts) ·
[.../workspace-creation/shared/worktree-paths.ts](https://github.com/superset-sh/superset/blob/main/packages/host-service/src/trpc/router/workspace-creation/shared/worktree-paths.ts) ·
[.../workspace-creation/procedures/create-session.ts](https://github.com/superset-sh/superset/blob/main/packages/host-service/src/trpc/router/workspace-creation/procedures/create-session.ts) ·
[.../router/git/utils/resolve-worktree.ts](https://github.com/superset-sh/superset/blob/main/packages/host-service/src/trpc/router/git/utils/resolve-worktree.ts) ·
[runtime/teardown/teardown.ts](https://github.com/superset-sh/superset/blob/main/packages/host-service/src/runtime/teardown/teardown.ts) ·
[AGENTS.md](https://github.com/superset-sh/superset/blob/main/AGENTS.md) ·
[DEVELOPMENT.md](https://github.com/superset-sh/superset/blob/main/DEVELOPMENT.md)

**Orca** — [package.json](https://github.com/stablyai/orca/blob/main/package.json) ·
[AGENTS.md](https://github.com/stablyai/orca/blob/main/AGENTS.md) ·
[src/main/persistence.ts](https://github.com/stablyai/orca/blob/main/src/main/persistence.ts) ·
[src/main/worktree-trash.ts](https://github.com/stablyai/orca/blob/main/src/main/worktree-trash.ts) ·
[src/main/worktree-create-base.ts](https://github.com/stablyai/orca/blob/main/src/main/worktree-create-base.ts) ·
[docs/reference/renderer-agent-status-performance.md](https://github.com/stablyai/orca/blob/main/docs/reference/renderer-agent-status-performance.md) ·
[docs/reference/git-compatibility.md](https://github.com/stablyai/orca/blob/main/docs/reference/git-compatibility.md) ·
[onorca.dev/docs/model/worktrees](https://www.onorca.dev/docs/model/worktrees)

---

## Gaps

- **Orca `src/main` internals beyond named files.** The repo is 504 MB and could not be cloned within
  this run; findings for Orca come from targeted raw-blob reads plus the contents API. Not read:
  `src/main/ipc/worktree-logic.ts` (the actual `git worktree add` invocation and path/naming
  computation) and `src/main/host-tree-removal.ts`. Next step: shallow-clone with
  `--filter=blob:none` and grep for `worktree add` / `computeWorkspaceRoot`.
- **cmux session-snapshot file location.** `SessionPersistence.swift` defines the Codable shapes and
  the policy caps, but the on-disk path for the window/workspace snapshot is written by a different
  type (approval records go to a `cmux.json` settings file). Not located in this pass.
- **cmux `cmuxd`.** CLAUDE.md references a "cmuxd socket" scrubbed from the agent environment; its
  role (background helper vs. legacy) was not established.
- **Superset pty-daemon wire protocol.** `packages/pty-daemon/src/protocol/` and
  `packages/host-service/src/terminal/terminal.ts` (79,920 B) were not read; flow control, seq
  catch-up, and snapshot-on-attach semantics are named only by their test files. This is the highest-
  value remaining read if Janela ever adopts a detached pty broker.
- **Quantified startup/memory comparisons.** None of the three publishes cross-project startup or RSS
  numbers. Orca's `bench:startup` and `bench:idle-cpu` artifacts are the only reproducible harness;
  running it locally against a cmux build is out of scope here.
