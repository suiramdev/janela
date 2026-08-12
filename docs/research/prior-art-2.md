# Prior-art teardown: orca, superset, cmux

Primary sources only. Every claim below is anchored to a file in the upstream repo (raw.githubusercontent / GitHub API tree at `main`) or to the locally cloned checkout of superset at `/tmp/pi-github-repos/superset-sh/superset`. Where I could not verify something from source, it is marked **UNVERIFIED**.

Repos examined:

- `stablyai/orca` — <https://github.com/stablyai/orca> (504 MB; API-only inspection, no clone)
- `superset-sh/superset` — <https://github.com/superset-sh/superset> (cloned locally, file reads)
- `manaflow-ai/cmux` — <https://github.com/manaflow-ai/cmux> (1.375 GB; API-only inspection, no clone)

---

## 1. manaflow-ai/cmux — native Swift/AppKit + libghostty

The only native-macOS member of the set, and therefore the highest-signal prior art for Janela.

### 1.1 Tech stack

| Layer | Choice | Evidence |
| --- | --- | --- |
| App shell | Swift + AppKit + SwiftUI, `.xcodeproj` checked in | `cmux.xcodeproj/` in root tree (<https://api.github.com/repos/manaflow-ai/cmux/contents/>); `.xcode-version` at root |
| Terminal | **libghostty** via a `GhosttyKit.xcframework` built from a vendored `ghostty` git submodule (fork `manaflow-ai/ghostty`) | `skills/cmux-ghostty/SKILL.md`: `cd ghostty && zig build -Demit-xcframework=true -Dxcframework-target=universal -Doptimize=ReleaseFast`; `.gitmodules` present at root |
| PTY | Owned by libghostty's surface (no node-pty, no separate daemon for local terminals) | `skills/cmux-debugging/SKILL.md`: "Do not add an app-level display link or manual `ghostty_surface_draw` loop. Rely on Ghostty wakeups and its renderer, or typing lags." |
| Code organisation | SwiftPM packages under `Packages/{Shared,iOS,macOS}/<pkg>`, wired into the `.xcodeproj` by hand-maintained pbxproj entries | `skills/cmux-architecture/SKILL.md`, "Package architecture" |
| Control plane | Unix-domain socket server (`CmuxControlSocket`) + a Swift CLI target (`CLI/`) | `Packages/macOS/CmuxControlSocket/README.md` |
| Git | Custom Swift Git-metadata parser, **not** a subprocess, for hot-path sidebar metadata | `Packages/macOS/CmuxGit/README.md` |
| Extras | Rust TUI (`cmux-tui`), iOS companion app, WebKit browser panes, iroh P2P transport, PostHog flags, Sentry, Sparkle updates | `.github/workflows/cmux-tui*.yml`, `Packages/Shared/CmuxIrohTransport`, `Packages/Shared/CmuxSentryTelemetry` |

README states the positioning explicitly: "Native macOS app — Built with Swift and AppKit, not Electron. Fast startup, low memory." and "I tried a few coding orchestrators but most of them were Electron/Tauri apps and the performance bugged me."

### 1.2 Domain model and top-level nouns

Defined normatively in `skills/cmux-workspace/SKILL.md`:

- **Window** — a macOS cmux window.
- **Workspace** — a sidebar entry. "The UI calls it a tab; CLI/socket APIs call it a workspace."
- **Pane** — a split region inside a workspace.
- **Surface** — a tab inside a pane; terminal **or** browser.
- **Panel** — internal content type inside a surface.

Identity is exported to child processes as environment variables `CMUX_WORKSPACE_ID`, `CMUX_SURFACE_ID`, `CMUX_SOCKET_PATH`, and short refs `workspace:1`, `surface:240`, `pane:172` are the CLI addressing scheme (same skill file). The god types named in `CLAUDE.md` are `ContentView.swift`, `Workspace.swift`, `TabManager.swift`, `cmuxApp.swift` — i.e. the model still lives largely in the app target, with domain packages being extracted incrementally (`Packages/macOS/CMUXProjectModel`, `CmuxPanes`, `CmuxSidebar`, `CmuxSidebarGit`, `CmuxRemoteWorkspace`).

**Worktrees are not a top-level noun in cmux.** A recursive scan of the repo tree (`https://api.github.com/repos/manaflow-ai/cmux/git/trees/main?recursive=1`) finds no `*Worktree*.swift` file at all; the only worktree-named source is an *extension example*, `Examples/CmuxExtensionSidebarExamples/Sources/CmuxExtensionSidebarExamples/ProjectWorktreeSidebar.swift`. Worktrees surface only as (a) git metadata cmux must parse correctly (`CmuxGit` handles "`.git` files for worktrees/submodules and the shared `commondir`") and (b) a sidebar decoration. cmux is workspace-centric with a plain `cwd`; worktrees are the user's business.

### 1.3 Agent launch and supervision

- `Packages/macOS/CMUXAgentLaunch` "owns launch, restore, and environment policy for coding agents" (`Packages/macOS/CMUXAgentLaunch/README.md`). Files include `AgentForkArgv.swift` (7.1 KB), `AgentLaunchEnvironmentPolicy.swift` (11.1 KB), `AgentLaunchCaptureTrust.swift` (7.8 KB), `AgentCwdNamespacing.swift`, `AgentLaunchInvocationClassifier.swift`, `ClaudeTeamsRespawnEnvironmentTransport` (tree `d548a2c4e72a1e15649d097b2915958dcc718144`).
- Environment policy is a **value-level, testable** API: "New value-level policy APIs accept captured inputs directly, while executable targets keep process mutation at their own seams… tests can also prove that credentials and process identity fail closed at the transport boundary."
- Agents run as ordinary shell processes inside a Ghostty surface. There is no JSON-stream agent protocol adapter in the macOS app; supervision is via terminal escape sequences plus CLI hooks.
- **Finish notifications**: OSC 9 / 99 / 777 parsed out of the terminal stream, plus a `cmux notify` CLI wired into agent hooks (README "Why cmux?"). Hook plumbing lives in the Swift CLI target: `CLI/AgentHookNotificationPolicy.swift` (10.3 KB), `CLI/CMUXCLI+ClaudeHookAck.swift`, `CLI/CMUXCLI+ClaudeHookWorkspaceRouting.swift` (7.3 KB), `CLI/CMUXCLI+ClaudePushNotificationHook.swift`, `CLI/CMUXCLI+CodexFireAndForgetHooks.swift`, `CLI/AgentHookFailureStage.swift`, `CLI/AgentSurfaceResumeBindingClearOutcome.swift`.
- Notification UX: pane gets a blue ring, sidebar tab lights up, `Cmd+Shift+U` jumps to most recent unread (README).
- Sidebar state is *pushed by the agent*: `cmux set-status`, `cmux set-progress`, `cmux log`, `cmux sidebar-state --json` (`skills/cmux-workspace/SKILL.md`). This is a much cheaper design than screen-scraping agent output.

### 1.4 Persistence

- No SQLite in the macOS app path that I could find. Persistence precedents named in the architecture skill are `JSONConfigStore` and `UserDefaultsSettingsStore`, behind a **Repository** actor abstraction (`skills/cmux-architecture/SKILL.md`, "Repository: `actor` mediating one persistence source of truth (file, defaults, web API)").
- User config is Ghostty-compatible: cmux "Reads your existing `~/.config/ghostty/config` for themes, fonts, and colors" (README), plus `~/.config/cmux/cmux.json` for keyboard shortcuts (`CLAUDE.md` → "Shortcut policy").
- Auth/session caches are small typed stores: `Packages/Shared/CMUXAuthCore/Sources/CMUXAuthCore/Persistence/{CMUXAuthIdentityStore,CMUXAuthKeyValueStore,CMUXAuthSessionCache,CMUXAuthTeamSelectionStore}.swift`.
- Terminal scrollback persistence across restarts: **UNVERIFIED** from source (README claims tab/session state; I did not locate the store).

### 1.5 IPC / process architecture

`Packages/macOS/CmuxControlSocket/README.md` is unusually explicit and worth copying wholesale:

- `SocketControlServer` — listener state machine: "startup path reservation, `start`/`stop`, generation-counted accept source with failure backoff and rearm, the socket-path monitor, and synchronous reads (`isRunning`, `activeSocketPath`, `listenerHealth`)."
- `SocketTransport` — stateless syscall layer: path identity, liveness probe, **advisory lock-file arbitration**, bind, accepted-client configuration, **peer PID/UID/ancestry checks**, `writeAll`, one-shot `probeCommand` client.
- `SocketListenerPolicy` — pure decision functions: accept-failure classification/recovery, unlink rules, bind-failure fallback from stable default path → user-scoped path.
- `SocketFastPathState` — per-surface dedupe for high-frequency `report_*` telemetry.
- Access modes: `off` / `cmuxOnly` / open-to-all-local, live-reconfigurable via `reconfigure(accessMode:)` without rebinding.
- Honest debt admission: "Client command handling (the per-connection read loop, auth, v1/v2 dispatch) still lives in the app and is planned to move here."

Threading/focus policy for socket commands (`skills/cmux-socket-policy/SKILL.md`):

- No `DispatchQueue.main.sync` for high-frequency telemetry (`report_*`, `ports_kick`, status/progress/log).
- Parse, validate, dedupe, coalesce **off-main**; schedule minimal model mutation with `main.async`.
- **Socket/CLI commands must not steal macOS app focus.** Only explicitly focus-intent commands (`window.focus`, `workspace.select`, `surface.focus`, `pane.focus`) may mutate focus. This is the single most under-appreciated requirement for an agent-driven IDE.

### 1.6 Concrete performance work and problems

From `CLAUDE.md` ("Pitfalls") and `skills/cmux-debugging/SKILL.md`, all with named files:

1. **Typing-latency hot paths, enumerated**: `WindowTerminalHostView.hitTest()` in `Sources/TerminalWindowPortal.swift` "runs on every event including keyboard. Add no work outside the `isPointerEvent` guard."; `TabItemView` in `Sources/ContentView.swift` uses `Equatable` + `.equatable()` to skip body re-evaluation while typing; `TerminalSurface.forceRefresh()` in `Sources/GhosttyTerminalView.swift` runs on every keystroke — "No allocations, file I/O, or formatting."
2. **SwiftUI list boundary rule** born from a real 100% CPU spin: "no view below a `LazyVStack`/`LazyHStack`/`List`/`ForEach` boundary may hold an observable store reference, and no function called from `body` may write state. Violating either reintroduces the 100% CPU spin loop from <https://github.com/manaflow-ai/cmux/issues/2586>."
3. **Do not add an app-level display link or manual `ghostty_surface_draw` loop** — rely on Ghostty's own wakeups or typing lags.
4. **Portal layering**: terminal views are AppKit-portal-hosted and "can sit above SwiftUI during split/workspace churn", so the find overlay must mount from `GhosttySurfaceScrollView`, not from a SwiftUI panel container.
5. **OS-version semantics drift**: `URL(fileURLWithPath: "/").deletingLastPathComponent().path` returns `"/.."` on macOS 14/15 but `"/"` on macOS 26 (issue 4529). Their CI runs macOS 15.7.4 while reporters were on 26.
6. Review-bot rules encode perf as policy: `.github/review-bot-rules/{algorithmic-complexity,hot-path-allocating-formatting,swift-blocking-runtime,swift-expensive-sync-load,runtime-no-hacky-sleeps}.md`, plus `.github/swift-warning-budget.tsv` (16 KB ratchet) and `.github/workflows/perf-activation.yml`.

### 1.7 What cmux does well

- **Concurrency doctrine written down and enforced.** `skills/cmux-architecture/SKILL.md` forbids, without written justification: `NSLock`/`os_unfair_lock`/`Mutex`/`DispatchSemaphore`-as-lock, KVO subclassing, `DispatchQueue` as a synchronisation primitive, Combine `@Published`/`ObservableObject`, completion-handler public APIs, `DispatchQueue.main.async`, `DispatchQueue.asyncAfter` (banned outright), sleep-as-synchronisation, and "a single-method `actor` used as a mutex". Carve-outs are enumerated with justification requirements (`DispatchSource.makeFileSystemObjectSource` for file watching, `makeReadSource`/`makeWriteSource` for socket I/O, injected-`Clock` bounded sleeps, one lock for a synchronous compare-and-set racing `withCheckedContinuation` resumes).
- **Five-layer DAG** (Core values → actor Services → `@MainActor @Observable` Domain/Coordinators → UI → thin executable composition root) with constructor injection only: "no global container, no singleton, no `static let shared`."
- **Testability as an architectural constraint**: `UserDefaults`, `FileManager`, paths, env vars and clocks arrive through `init`; no static test hooks; observation surfaced as `AsyncStream` so tests assert a yielded sequence. "If a design is hard to test, it is wrong."
- **Git metadata without subprocesses** (see §4.1).
- **Build isolation for parallel agents**: `./scripts/reload.sh --tag <tag>` gives each agent build its own app name, bundle ID, socket, and DerivedData path — "Never run bare `xcodebuild` or `open` an untagged `cmux DEV.app`."
- **Pbxproj test-wiring lint**: "a `.swift` file in `cmuxTests/` without a `PBXFileReference` + `PBXSourcesBuildPhase` entry is silently skipped, and both `xcodebuild test` and bot reviews pass with 'Executed 0 tests'." Guarded by `./scripts/lint-pbxproj-test-wiring.sh`.

### 1.8 Accidental complexity in cmux to avoid

- **Hand-maintained `.xcodeproj` + a mirrored `.xcworkspace` group structure.** Adding a package requires pbxproj entries in *two* targets, plus `python3 scripts/check-workspace-package-groups.py --write`, plus a pbxproj normalisation pre-commit hook, plus a CI drift check. This is pure toil that XcodeGen exists to delete.
- **Package explosion.** 37+ packages under `Packages/macOS` alone (`CmuxCanvas`, `CmuxCanvasUI`, `CmuxLiveEval`, `CmuxDiffComments`, `CmuxFeedback`, `CmuxExtensionKit`, `CmuxRemoteDaemon`, `CmuxRemoteSession`, `CmuxRemoteWorkspace`…). Their own skill admits: "Existing packages under `Packages/` predate this policy; do not use them as design references."
- **Scope sprawl**: iOS companion app with a mandatory sign-in gate baked into the dev loop, Rust TUI with its own release/SDK pipelines in 6 languages, Cloud VM control plane on Vercel + Aurora Postgres with Effect-TS (`skills/cmux-backend/SKILL.md`), an embedded WebKit browser with an agent-automation API, a P2P iroh transport, a billing stack. The macOS terminal is now a minority of the repo.
- **A forked Ghostty submodule** that must be rebuilt with `zig build … -Doptimize=ReleaseFast` and kept merged against upstream, with documented fork-conflict notes (`docs/ghostty-fork.md`).
- **PostHog remote flags as the mandatory feature-flag mechanism** — "Unless the user explicitly asks for a compile-time flag… implement a feature flag through `CmuxFeatureFlags` with a PostHog key." A network dependency for local behaviour.

---

## 2. superset-sh/superset — Electron, worktree-centric, cloud-coupled

### 2.1 Tech stack

From `apps/desktop/package.json` (local clone) and root `package.json`:

| Concern | Choice |
| --- | --- |
| Shell | Electron `41.10.3`, `electron-vite 4.0.1`, `electron-builder 26.8.1` |
| UI | React 19.2.3, TanStack Router/Query/DB/Virtual, Zustand 5, Tailwind 4, Radix, TipTap, CodeMirror 6, Monaco-free |
| Terminal | `@xterm/xterm 6.1.0-beta.289` + addons (`webgl`, `serialize`, `ligatures`, `image`, `search`, `unicode11`, `progress`, `clipboard`), plus `@xterm/headless` |
| PTY | `node-pty 1.2.0-beta.14` inside a dedicated `@superset/pty-daemon` process |
| Local persistence | `better-sqlite3 12.11.1` + `drizzle-orm 0.45.2` via `@superset/local-db`; also `libsql`, `dexie`, `lowdb`, `idb-keyval` |
| Sync | Electric SQL (`@electric-sql/client`, `@tanstack/electric-db-collection`), tRPC 11 over `trpc-electron`, Hono, better-auth, Stripe |
| Repo | Bun 1.3.14 + Turbo monorepo, `apps/{desktop,web,api,admin,docs,marketing,mobile}` + `packages/*` |
| Licence | Elastic-2.0 (not OSI open source) |

### 2.2 Domain model (authoritative, in code)

`packages/local-db/src/schema/schema.ts` (local clone) is the single source of truth for local state:

- `projects` (L27–61): `mainRepoPath`, `name`, `color`, `tabOrder`, `defaultBranch`, `workspaceBaseBranch`, `githubOwner`, `branchPrefixMode`, `branchPrefixCustom`, **`worktreeBaseDir`**, `neonProjectId`, `defaultApp`.
- `worktrees` (L69–96): `projectId`, `path`, `branch`, `baseBranch`, `gitStatus` (JSON), `githubStatus` (JSON), and **`createdBySuperset: boolean NOT NULL DEFAULT true`** — "Used to prevent accidental deletion of user-created worktrees" (L86–90).
- `workspaces` (L104–154): `projectId`, nullable `worktreeId`, `type: "worktree" | "branch"`, `branch`, `name`, `tabOrder`, `isUnread`, `isUnnamed`, **`deletingAt`** (soft-delete tombstone; "Workspaces with `deletingAt` set should be filtered out from queries"), **`portBase`** ("Each workspace gets a range of 10 ports"), `sectionId`.
- `workspaceSections` (L162–180) — user-created sidebar groups.
- `settings` (L185–258) — a single-row table with ~50 columns, including `terminalFontFamily/Size/LineHeight/LetterSpacing/FontWeight/Ligatures/MinimumContrast/CursorStyle/CursorBlink`, `terminalParkedRuntimeCap`, `terminalPersistence`, `agentPresetOverrides` (JSON), `agentCustomDefinitions` (JSON), `disabledAgentHooks` (JSON), `worktreeBaseDir`, `deleteLocalBranch`.
- Cloud-mirrored tables written directly by Electric with snake_case columns: `users`, `organizations`, `organizationMembers`, `tasks`, plus `browserHistory` and a `v1MigrationState` table.

Note the honest schema comment at L147–152: the "one branch workspace per project" invariant is a **partial unique index** created only by migration 0006 because "Drizzle's schema DSL doesn't support partial/filtered indexes".

### 2.3 Worktrees: creation, naming, cleanup

- Path policy, `apps/desktop/src/lib/trpc/routers/workspaces/utils/resolve-worktree-path.ts` (whole file, 22 lines): `project.worktreeBaseDir` → global `settings.worktreeBaseDir` → default `join(homedir(), SUPERSET_DIR_NAME, WORKTREES_DIR_NAME)`; final path is always `join(baseDir, project.name, branch)`. So the default layout is `~/.superset/worktrees/<project>/<branch>` — outside the repo, keyed by branch name.
- Working directory resolution, `apps/desktop/src/lib/trpc/routers/workspaces/utils/worktree.ts`: `getWorkspacePath()` returns `project.mainRepoPath` for `type === "branch"` and the worktree row's `path` for `type === "worktree"`. **This is the correct shape for "worktree-aware, not worktree-centric": one workspace abstraction, two backing modes.**
- Branch naming is agent/LLM-assisted: `.../workspaces/procedures/generate-branch-name.ts`; prefix policy comes from `branchPrefixMode`/`branchPrefixCustom` at both project and settings scope.
- Import of externally created worktrees is a first-class flow: `.../workspaces/procedures/external-worktree-import.test.ts`, `.../utils/select-external-worktrees-for-import.ts` (+ unit and integration tests), renderer `ImportWorktreesDialog`, `ExternalWorktreesBanner`, `useImportAllWorktrees`, `useImportExternalWorktrees`, `useOpenExternalWorktree`, `useOpenTrackedWorktree`.
- Deletion is a 14.9 KB procedure (`.../workspaces/procedures/delete.ts`) plus a `deletingAt` tombstone plus a `deleteLocalBranch` setting plus a `WorkspaceMissingWorktreeState` renderer state for the drifted case. Agents can drive it: `.../AgentHooks/hooks/useCommandWatcher/tools/create-worktree.ts` and `.../tools/delete-workspace.ts`.

### 2.4 Agent launch and supervision

- Agents are ordinary CLI processes in terminals; presets are data (`settings.agentPresetOverrides`, `settings.agentCustomDefinitions`). README: "Superset works with any CLI-based coding agent" with per-agent icons in `packages/ui/src/assets/icons/preset-icons/`.
- Monitoring is hook-driven and rendered in the sidebar: `apps/desktop/src/renderer/routes/_authenticated/components/AgentHooks/**` with a `useCommandWatcher` that exposes *tools* to the agent (`create-worktree.ts`, `delete-workspace.ts`) — i.e. the agent can restructure the IDE. `settings.disabledAgentHooks` gates them. `HOOKS_INVESTIGATION.md` sits at repo root.
- Notifications: "working indicators, completion chimes, and dock badges" (README); `settings.selectedRingtoneId`, `notificationSoundsMuted`, `notificationVolume`.
- `@agentclientprotocol/claude-agent-acp 0.56.0` and `@ai-sdk/*` are direct deps, so there is also a non-terminal ACP path alongside the PTY path.

### 2.5 Process architecture — the pty-daemon (the best idea in this repo)

`packages/pty-daemon/README.md`, verbatim highlights:

- "Long-lived PTY-owning process for the v2 desktop terminal. host-service is a client over a Unix socket; routine host-service upgrades don't touch shells."
- Phase 1 = daemon owns PTYs across host-service restarts; Phase 2 = **fd-handoff so sessions survive daemon-binary upgrades too**.
- Standalone package: "it does not import from `@superset/host-service` or any other workspace package. Host-service consumes only the protocol types via `@superset/pty-daemon/protocol`."
- Wire protocol: length-prefixed framing, 4-byte BE prefix (`protocol/framing.ts`), versioned `hello`/`hello-ack` handshake picking the highest mutually supported version.
- `SessionStore/` = in-memory map + **64 KB ring buffer per session**. "Buffer is in-memory only… never persisted to disk. No SQLite, no scrollback files. v1's `HistoryManager` is explicitly out of scope."
- "Auth boundary = Unix socket file mode 0600. No in-band tokens."
- Runtime constraint discovered the hard way: "verified during development that node-pty 1.2's master fd handling is incompatible with Bun 1.3 (`tty.ReadStream` closes immediately, alternate `fs.createReadStream(null, { fd })` returns EAGAIN with no recovery)."
- FD-leak bug documented: node-pty "`1.1.0` leaked the temporary `/dev/ptmx` descriptor opened by its macOS `posix_spawn` path once per PTY spawn"; pinned to `1.2.0-beta.14`, "do not downgrade without rerunning the process-wide real-FD churn test."
- Test suite is a checklist of exactly the failure modes a terminal host hits: `byte-fidelity.test.ts` (random non-UTF-8 bytes daemon→host byte-perfect, live and replay), `fd-lifecycle.test.ts` (real master fds close idempotently under churn), `signal-recovery.test.ts` (SIGKILL mid-handoff), `handoff.test.ts` (same shell PIDs survive a daemon binary swap), and `no-encoding-hops.test.ts` — a source-level grep that "fails the moment anyone reintroduces a base64 hop or per-chunk `chunk.toString('utf8')` on the data path."
- Known gap they chose not to close: no "since byte N" replay cursor, so bytes produced during a disconnect window are dropped on reconnect.

### 2.6 Accidental complexity in superset to avoid

- **A local desktop IDE that requires a cloud identity and a Postgres/Electric sync plane.** `DEVELOPMENT.md` requires Docker + Caddy + Postgres + neon-proxy + Electric + Redis just to run the app, plus `caddy trust` (sudo) "Without it Chromium rejects `https://localhost:*`". Local rows and cloud rows live in the same SQLite file with different naming conventions (camelCase vs snake_case) because "Electric data writes directly".
- **Cache-first rendering hazard** they had to write a rule for (`AGENTS.md` rule 9): "`useLiveQuery` can return persisted rows in `data` while the collection is still not `isReady`… Never hide, blank, or replace existing `data` just because `isReady` is false."
- **Dependency mass**: `apps/desktop/package.json` lists ~200 runtime deps including two DB engines (`better-sqlite3` *and* `libsql`), `dexie`, `lowdb`, `idb-keyval`, Mastra, three AI SDKs, `react-mosaic-component` + `react-resizable-panels` + `@dnd-kit` + `react-dnd` (two drag systems), `@parcel/watcher`, `native-keymap`, `koffi`, `sharp`.
- Per-workspace port allocation baked into the schema (`portBase`, 10 ports/workspace) — solves a real multi-worktree dev-server collision, but it is app-level infrastructure that leaks into persistence.

---

## 3. stablyai/orca — Electron, maximal scope, heavily forked terminal

### 3.1 Tech stack

Root `package.json` (raw):

- Electron `^43.1.0`, `electron-vite ^5`, `vite: npm:rolldown-vite@7.3.1`, React 19.2.7, Zustand 5, TS 7, oxlint/oxfmt, pnpm 10.24, **`engines.node: 24`**.
- Terminal: `@xterm/xterm 6.1.0-beta.287` + `addon-webgl`, `addon-serialize`, `addon-ligatures`, `addon-search`, `addon-unicode11`, `@xterm/headless`.
- PTY: `node-pty ^1.1.0`, **patched**.
- Other: `ssh2`, `ws`, `agent-browser ~0.27.0`, `sherpa-onnx` (on-device speech-to-text), `@linear/sdk`, `monaco-editor`, `@parcel/watcher`, `posthog-node`, `i18next` + 20 locales, a mobile app, a `relay` binary, macOS "computer use" native helpers.
- **No `better-sqlite3`.** SQLite access is via Node 24's built-in `node:sqlite`, wrapped by `src/main/sqlite/sync-database.ts`.

**Patched dependencies (`pnpm.patchedDependencies`) are the headline finding:**

| Patch file | Size |
| --- | --- |
| `config/patches/@xterm__xterm@6.1.0-beta.287.patch` | **7,335,264 bytes** |
| `config/patches/@xterm__addon-webgl@0.20.0-beta.286.patch` | **1,055,794 bytes** |
| `config/patches/@xterm__addon-serialize@0.15.0-beta.287.patch` | 83,041 bytes |
| `config/patches/node-pty@1.1.0.patch` | 14,396 bytes |
| `config/patches/@xterm__addon-ligatures@0.11.0-beta.287.patch` | 703 bytes |

(sizes from `https://api.github.com/repos/stablyai/orca/git/trees/main?recursive=1`). A 7 MB patch against xterm.js is a de-facto hard fork carried as a patch file. This is what "Ghostty-class terminals with WebGL rendering" costs on top of a DOM terminal.

### 3.2 Domain model and worktree stance

- README: "Run Codex, ClaudeCode, OpenCode or Pi side-by-side — each in its own worktree, tracked in one place", "Parallel Worktrees", "SSH Worktrees", and a CLI with `orca worktree create`, `snapshot`, `click`, `fill`.
- But `AGENTS.md` contains an explicit **anti-worktree-centrism** rule: "**Folder Workspace Use Case** — All changes must consider folder workspaces as well as git worktrees. Don't assume every workspace is a git worktree." And "**Worktree Safety** — Always use the primary working directory (the worktree) for all file reads and edits. Never follow absolute paths from subagent results that point to the main repo."
- I could not locate a single canonical domain-model module from the API-only view (`src/main/workspaces`, `src/main/state`, `workspaces.json` all return no match in the recursive tree). Orca's main-process code is organised by capability (`src/main/pty/`, `src/main/ai-vault/`, `src/main/ssh/`, `src/main/speech/`, `src/main/sqlite/`). **Domain-model location: UNVERIFIED.**

### 3.3 Agent supervision

- `src/main/ai-vault/**` reverse-engineers agent state from the agents' own on-disk stores rather than only from the terminal: `session-scanner-opencode-sqlite.ts` (12.4 KB) plus `-discovery`, `-list`, `-paths`, `-bounds`, `-coexistence`, and a **dedicated worker process** (`session-scanner-opencode-sqlite-worker-{client,entry,protocol,spawn}.ts`) so that reading another product's SQLite file cannot block or crash the main process. `session-scanner-opencode-sqlite-worker-client.ts` is 11.8 KB.
- `src/main/pty/omp-sqlite-overlay.ts` and `omp-shell-wrapper.ts` show a shell-wrapper injection layer around agent invocations.
- The `sync-database.ts` adapter is worth reading for its comments alone:
  - `STATEMENT_CACHE_LIMIT = 256` — "dynamic `IN (?,?,…)` clauses mint a new SQL string per arity, so the cache must stay bounded."
  - Wildcard `SELECT *` and `PRAGMA` are excluded from the statement cache — "node:sqlite builds the first post-schema-change row from stale column names, so a reused wildcard SELECT can drop a freshly added column."
  - `exec()` clears the statement cache when the SQL matches `ALTER|CREATE|DROP|REINDEX|VACUUM|ATTACH|DETACH`.
  - `loadDatabaseSync()` uses `process.getBuiltinModule('node:sqlite')` lazily "because SSH companions target Node 18 and import this adapter without opening SQLite."

### 3.4 Evidence of performance work (this is orca's strongest signal)

Named npm scripts in root `package.json`:

- `bench:startup`, `bench:daemon-coldstart`, `bench:idle-cpu`, `bench:main-thread-jank`, `bench:hang-watchdog-memory`, `bench:worktree-deletion`, `bench:worktree-refresh-churn`, `bench:zustand-selector-fanout` (+ a `--check` gate in `lint`), `bench:multi-workspace-typing`, `bench:ai-vault-typing`, `bench:cold-park-reveal`, `bench:cold-park-resource`, `bench:compare`.
- `test:e2e:terminal-perf` runs `terminal-typing-latency.spec.ts`, `terminal-foreground-redraw-freeze.spec.ts`, `terminal-output-scheduler.spec.ts`, `terminal-hidden-tui-visual-restore.spec.ts`, `artificial-opencode-terminal-load.spec.ts`; `test:e2e:terminal-perf:scale` + `:check-report` + `:html-report` enforce budgets (`config/scripts/check-terminal-perf-report-budgets.mjs`).
- `test:e2e:terminal-rendering-golden` includes `terminal-webgl-atlas-budget.spec.ts` — a WebGL glyph-atlas budget test.
- Repro scripts for real freezes: `repro:live-remote-bulk-open-freeze`, `repro:live-remote-realistic-freeze`, `test:e2e:remote-bulk-open-freeze`, `test:e2e:ssh-docker-bulk-open-freeze`, `test:e2e:source-control-scale`.
- Custom lint plugins encoding perf invariants: `config/oxlint-plugins/quadratic-buffer-concat.mjs` (7.2 KB), `app-store-performance.mjs`, `renderer-scrollbar-style.mjs`.
- `config/max-lines-baseline.txt` (17.6 KB ratchet) and `config/reliability-gates.jsonc` (**876 KB**) — the latter is itself a symptom.
- Idle CPU is measured, not assumed: `config/scripts/idle-cpu-process-sampling.mjs`, `idle-cpu-renderer-scale-fixture.mjs`, `idle-cpu-renderer-timing-probe.mjs`, `idle-cpu-synthetic-spinners.mjs`.

The existence of `hibernation-output-epoch-leak-benchmark.mjs`, `legacy-worker-recovery-persistence-benchmark.mjs`, `hydrate-worktree-lookup-benchmark.mjs`, and `hang-watchdog-*` is direct evidence that Electron + xterm.js + many concurrent sessions has cost them real engineering: terminal hibernation/parking, hang watchdogs, output epochs, worker recovery.

### 3.5 Accidental complexity in orca to avoid

- 7.3 MB of vendored xterm.js patches maintained by hand across beta bumps.
- A 876 KB `reliability-gates.jsonc` and a 17.5 KB max-lines baseline file — governance artefacts that grow because the codebase does.
- Cross-platform tax written into `AGENTS.md`: Windows `.cmd` runner rules ("never launch a `.cmd` runner with a bare `cmd.exe /c` from a Git Bash pane (MSYS rewrites the `/c`)"), Linux glibc 2.31 floor for native modules, WSL/SSH/relay host isolation for git capability caches (`GitCapabilityCache`), and a remote wire-compatibility protocol ("a new stream opcode must be capability-negotiated because decoders drop unknown opcodes silently").
- Git version compatibility policy: "Treat Git 2.25 as the core-workflow baseline", with a `GitCapabilityCache` scoped per host (native / WSL distro / SSH provider / relay) and CI running against representative Git releases. Real, but only because they shell out to *the user's arbitrary* git on arbitrary hosts.
- Scope: on-device STT (`sherpa-onnx`, 5 platform binaries), computer-use native helpers, embedded Chromium design mode, mobile iOS+Android apps, Linear/GitHub/GitLab integrations, 20 locales with a localisation-coverage audit gate.

---

## 4. Cross-cutting findings that matter most for Janela

### 4.1 Git metadata: parse, don't fork (cmux) vs shell out (orca/superset)

`Packages/macOS/CmuxGit/README.md` is the single most directly actionable document I found:

> "Sidebar metadata is parsed directly from the on-disk repository **without a subprocess**; mobile workspace changes use non-locking `/usr/bin/git` commands so committed, staged, unstaged, untracked, rename, and binary semantics match Git itself."

Specifics:

- `GitMetadataService` "resolves the repository enclosing a directory (handling `.git` files for worktrees/submodules and the shared `commondir`) and parses `HEAD`, the binary `index` (v2/v3/v4), and `config` (following `include`/`includeIf`)."
- It derives `workspaceMetadata(for:)` (branch, dirty, change signatures), `watchedPaths(for:)` (exact paths a filesystem watcher must observe, including submodule gitlinks), and `repositorySlugs(forDirectory:)` (ordered `upstream`, `origin`, rest).
- "Dirty detection mirrors git's stat-based check (size/mode/mtime per tracked entry, plus submodule-commit comparison for gitlinks), and excludes assume-unchanged and skip-worktree entries."
- Layering: "a Layer-2 service package: `Sendable` value facades over filesystem and process boundaries, with actor isolation only for bounded caches. Its reads are plain `nonisolated async` methods, which run on the global concurrent executor (SE-0338) — off the caller's actor and in parallel."
- The expensive path (`WorkspaceChangesService`) *does* use `/usr/bin/git`, resolves the default branch and merge base, and caches summaries in an actor "expir[ing] entries after 15 seconds by repository root."
- Testing: metadata tests build fixtures (`GitRepositoryFixture`, `GitIndexFixture` writing binary index v2 and v4 with path prefix-compression) with **no git process**; behavior tests run real git in temp repos "with a scratch `HOME` and system/global config disabled."

Corroborating evidence that the subprocess path is expensive at scale: orca ships `bench:worktree-refresh-churn`, `hydrate-worktree-lookup-benchmark.mjs`, `git-diff-blob-concurrency-benchmark.mjs`, `branch-compare-head-benchmark.mjs`, and `test:e2e:source-control-scale`; superset keeps `worktree-status-caches.ts` and `status-cache.ts` under `apps/desktop/src/lib/trpc/routers/changes/utils/` plus a `changes/workers/` directory.

### 4.2 Terminal-state ownership: the PTY should outlive the UI

superset's pty-daemon (§2.5) and orca's `bench:daemon-coldstart` / `daemon-relocation-spike.yml` / `daemon-boot-smoke.mjs` / `daemon-endpoint-handover-smoke.mjs` both converge on: a separate long-lived process owning PTY master fds, with fd handoff across upgrades. cmux does **not** do this — libghostty owns the PTY in-process, and cmux instead invests in "terminal parking" equivalents (`terminalParkedRuntimeCap` is superset's; orca has `bench:cold-park-reveal` / `bench:cold-park-resource`).

### 4.3 Comparison table

| Dimension | cmux | superset | orca |
| --- | --- | --- | --- |
| Shell | Swift/AppKit/SwiftUI native | Electron 41 | Electron 43 |
| Terminal engine | libghostty (forked submodule, `GhosttyKit.xcframework`) | xterm.js 6.1-beta + webgl addon | xterm.js 6.1-beta, **7.3 MB local patch** + 1 MB webgl patch |
| PTY owner | libghostty in-process | standalone `pty-daemon`, Unix socket, fd handoff | node-pty (patched) in main process + daemon-relocation work |
| Local persistence | JSON stores + `UserDefaults` behind Repository actors; `~/.config/cmux/cmux.json` | SQLite (better-sqlite3) + Drizzle; 6 local tables + Electric-synced cloud tables | `node:sqlite` (built-in) via `src/main/sqlite/sync-database.ts`; own model store UNVERIFIED |
| Top-level nouns | Window → Workspace → Pane → Surface → Panel | Project → Worktree → Workspace(worktree\|branch) → Section | Workspace (worktree **or** folder), agent session, tab |
| Worktree centrality | **Low** — no worktree type in the codebase; a sidebar decoration | **High** — a dedicated table, base-dir settings, import/delete flows, `createdBySuperset` flag | Medium-high in UX; explicitly bounded by "don't assume every workspace is a git worktree" |
| Worktree path scheme | n/a | `<baseDir>/<projectName>/<branch>`, default `~/.superset/worktrees` | UNVERIFIED (CLI `orca worktree create` exists) |
| Agent launch | `CMUXAgentLaunch` package: argv construction, env policy, capture trust, cwd namespacing | terminal presets + `agentPresetOverrides`/`agentCustomDefinitions` in settings; ACP path via `claude-agent-acp` | terminal + `src/main/pty/omp-shell-wrapper.ts`; state scraped from agent SQLite stores in a worker |
| Finish notification | OSC 9/99/777 + `cmux notify` CLI + hook policy files in `CLI/` | agent hooks + chimes + dock badges (`selectedRingtoneId`, `notificationVolume`) | notification-status macOS native helper, mobile push |
| Control API | Unix socket (`CmuxControlSocket`), access modes off/cmuxOnly/all, peer PID/UID/ancestry checks, focus-preserving policy | CLI + SDK + MCP + relay | `orca` CLI + relay + remote wire-compat protocol |
| IPC in-app | AppKit/SwiftUI direct + actors | tRPC over `trpc-electron` + TanStack DB live queries | Electron IPC + Zustand; `zustand-selector-fanout` benchmark gate |
| Documented perf discipline | hot-path list, SwiftUI list-boundary rule, no display-link rule, warning budget, review-bot rules | `no-encoding-hops` grep test, byte-fidelity test, fd-lifecycle churn test | 13 named benchmarks + terminal perf budget gates + custom perf lint plugins |
| Biggest accidental complexity | pbxproj/workspace hand-wiring; 37+ packages; iOS/Rust/cloud sprawl | cloud+Electric coupling for a local IDE; ~200 desktop deps | 7 MB xterm fork; 876 KB reliability-gates; 3-OS + WSL + SSH matrix |

---

## 5. Implications for Janela

### 5.1 Validated by the evidence (keep)

1. **Native Swift/AppKit+SwiftUI is the right call for "many concurrent sessions".** cmux's README states the motivation directly, and orca's benchmark inventory (`bench:idle-cpu`, `bench:main-thread-jank`, `bench:multi-workspace-typing`, hang watchdogs, terminal parking/hibernation) is a catalogue of costs Janela simply does not incur.
2. **Workspace-centric, not worktree-centric, is the correct model** — and both non-native competitors agree in writing. superset's `getWorkspacePath()` (one workspace type, two backing modes) and orca's `AGENTS.md` "Folder Workspace Use Case" rule are the two independent confirmations. Model it as `Workspace { root: URL, provenance: .repoRoot | .worktree(base:branch:) | .folder }` and never make `Worktree` a required parent.
3. **All logic in an SPM package** — cmux's pbxproj toil (two-target manual wiring, a normalisation pre-commit hook, `check-workspace-package-groups.py --check` in CI, and a `lint-pbxproj-test-wiring.sh` guard against silently-skipped test files) is a direct argument for XcodeGen + a thin app target. Keep the generated project out of source control if possible.
4. **Unsandboxed + hardened runtime** is consistent with what these apps actually need (arbitrary user shells, `/usr/bin/git`, arbitrary agent binaries, Unix control sockets in `/tmp`, socket peer-credential checks).
5. **SQLite for metadata is fine and is what both Electron apps use** — superset via better-sqlite3+Drizzle, orca via built-in `node:sqlite`. GRDB is the strictly better Swift equivalent. Steal orca's two hard-won lessons: bound the prepared-statement cache, and invalidate it on DDL.

### 5.2 Contradicted or complicated by the evidence (change or plan for)

1. **CONTRADICTION — "shelling out to `/usr/bin/git`" as the general strategy.** cmux's `CmuxGit` explicitly does *not* use a subprocess for the per-workspace metadata that renders in the sidebar (branch, dirty flag, change signatures, watch paths, remotes), and instead parses `HEAD`, the binary index (v2/v3/v4), and `config` with `include`/`includeIf` resolution, in a `Sendable` `nonisolated async` service. With N concurrent sessions each polling status, `posix_spawn` + `git status` per workspace per refresh is exactly the cost orca benchmarks (`bench:worktree-refresh-churn`, `hydrate-worktree-lookup-benchmark`) and superset caches around (`worktree-status-caches.ts`). **Recommendation: split the git layer in two from day one.** `GitMetadataReader` = pure Swift parser over `.git` (HEAD, index stat-check dirty detection, config, `commondir` resolution for worktrees), driven by an FSEvents/`DispatchSource` watcher over `watchedPaths`. `GitCommandRunner` = `/usr/bin/git` for diffs, merge-base, blob fetch, and all mutations, behind an actor cache with a short TTL (cmux uses 15 s per repo root). Do not let the subprocess path run on any per-frame or per-tab-render path. Note the parser is a real cost: index v2/v3/v4 including v4 path prefix-compression, gitlinks, assume-unchanged and skip-worktree bits.
2. **CONTRADICTION (partial) — SwiftTerm behind a swappable protocol.** The protocol seam is right and matches cmux's own doctrine (lower packages publish protocols; `any Protocol` at the boundary). But every serious competitor concluded that a *stock* terminal component is not enough: cmux forked Ghostty and vendors a `GhosttyKit.xcframework`; orca carries a 7.3 MB xterm.js patch. SwiftTerm is a pure-Swift emulator with no GPU-atlas renderer of libghostty's class, and orca's `terminal-webgl-atlas-budget.spec.ts` and `terminal-typing-latency.spec.ts` show where the pain lands. **Recommendation: keep SwiftTerm as v0 behind the protocol, but design the protocol assuming the second implementation is libghostty** — i.e. the protocol must express: raw byte-in/byte-out (no per-chunk `String` conversion — see superset's `no-encoding-hops.test.ts`), damage/wakeup-driven redraw rather than a caller-owned draw loop (cmux: "Do not add an app-level display link or manual `ghostty_surface_draw` loop"), resize with dim validation, scrollback ownership, and OSC passthrough. Also plan the interop cost: linking libghostty means a Zig toolchain and an xcframework build step in CI.
3. **GAP — PTY lifetime is not in the stated stack.** superset's pty-daemon exists specifically so that "routine host-service upgrades don't touch shells", with Phase-2 fd handoff so sessions survive a daemon binary swap; orca has `daemon-relocation-spike.yml` and `bench:daemon-coldstart`. A native app can defer this (the app *is* the daemon), but decide explicitly: if Janela auto-updates or crashes, do agent sessions die? If the answer must be "no", the PTY-owning layer must be a separate process from day one, because retrofitting fd ownership is the hard part. Cheap middle ground: keep PTYs in-process but make the session store a value type that can be reconstructed, and adopt superset's 64 KB-per-session in-memory ring buffer rather than persisting scrollback.
4. **GAP — control socket + focus policy.** Janela is "designed to host CLI coding agents", which means agents *will* want to drive the IDE. Adopt cmux's `CmuxControlSocket` design directly: advisory lock-file arbitration for the socket path, liveness probe + stale-socket unlink policy, generation-counted accept source with backoff/rearm, peer PID/UID/ancestry verification, three access modes, `0600` file-mode as the auth boundary (superset's pty-daemon: "No in-band tokens"), and per-surface dedupe for high-frequency telemetry commands. Most importantly, adopt the **focus policy**: only explicitly focus-intent commands may change focus or activate the app. An agent finishing in workspace 7 must never steal the cursor from workspace 2.
5. **GAP — agent finish detection.** Both native and Electron converge on OSC 9/99/777 + an explicit CLI hook (`cmux notify`). Terminal-sequence parsing alone is insufficient (README: Claude Code's notification body is always "Claude is waiting for your input" with no context). Ship a `janela notify` / `janela set-status` / `janela set-progress` CLI on the control socket in v1 and document the Claude Code / Codex / OpenCode hook wiring; that is what makes the sidebar useful.
6. **Concurrency doctrine: copy cmux's, wholesale, into `AGENTS.md` on day 1.** Swift 6.3 strict concurrency plus their forbidden-primitives list (no locks/semaphores as mutexes, no `DispatchQueue` as a synchronisation primitive, no Combine `@Published`/`ObservableObject`, no `DispatchQueue.main.async`, `DispatchQueue.asyncAfter` banned outright, no sleeps as synchronisation) and their four carve-outs (`DispatchSource` file/socket sources, injected-`Clock` bounded sleeps, one lock for a synchronous compare-and-set racing a `withCheckedContinuation`, `NSKeyValueObservation` at a KVO seam) is the highest-value document in all three repos. Note their explicit anti-pattern: "a single-method `actor` used as a mutex" forces synchronous `Process`-termination and `DispatchSource` callbacks through `Task { await … }`, adding suspension points and reentrancy surface.
7. **SwiftUI rendering rules to enforce before the first list ships.** (a) No view below a `LazyVStack`/`List`/`ForEach` boundary may hold an observable store reference; pass immutable snapshots + closures. (b) No function called from `body` may write state. (c) Sidebar row views get `Equatable` + `.equatable()`. cmux paid for these with a 100% CPU spin (issue 2586).
8. **Persistence shape.** Superset's schema is a good starting point but over-normalised for Janela: `projects` + `worktrees` + `workspaces` + `sections` + a 50-column singleton `settings` row. Recommend: `workspaces` (id, root path, provenance enum, branch, display name, order, section, last_opened_at, unread, deleting_at) and `sessions` (id, workspace_id, agent kind, argv/env fingerprint, cwd, started_at, exit info, resume token) in GRDB; keep user *preferences* in a versioned JSON/`UserDefaults` store rather than 50 SQL columns, so schema migrations are reserved for real relational data. Steal two specifics: a `created_by_janela` flag on any worktree Janela creates so cleanup never deletes a user's own worktree, and a `deleting_at` tombstone so deletion is async and idempotent.
9. **Scope discipline is the differentiator.** All three repos are drowning in adjacent products (mobile apps, cloud VMs, embedded browsers, STT, billing, P2P transports, Rust TUIs, 20 locales). cmux's own README states the correct principle — "cmux is a primitive, not a solution" — and then ships an iOS app with a mandatory sign-in gate in the dev loop. For Janela: terminal + workspaces + sessions + git status + control socket + notifications. Nothing else in v1.
10. **Deployment-target note.** cmux hit a real macOS-26-vs-15 Foundation behaviour change (`URL.deletingLastPathComponent()` on `/`, issue 4529) that their CI (macOS 15.7.4) could not see. With a macOS 15 deployment target and a macOS 26 SDK, Janela needs at least one CI leg on the *older* OS, or the same class of bug is inevitable.

---

## 6. Confidence and gaps

- **High confidence**: cmux architecture/concurrency/socket/git/agent-launch doctrine (their skill files and package READMEs are unusually precise and were read in full); superset's persistence schema, worktree path policy, and pty-daemon design (read from source in a local clone); orca's dependency set, patch sizes, and benchmark inventory (read from `package.json` and the git tree with byte sizes).
- **UNVERIFIED / gaps**:
  - orca's own domain-model and workspace-persistence modules — I could not locate them from the API-only view (repo is 504 MB; `src/main/workspaces`, `src/main/state`, `workspaces.json` all absent from the recursive tree). Its `src/main/sqlite/` adapter is generic and its confirmed consumer is the OpenCode session scanner.
  - orca's worktree naming/cleanup implementation (only the CLI surface `orca worktree create` and `bench:worktree-deletion` are confirmed).
  - cmux's terminal scrollback/session restore-across-restart mechanism.
  - superset's agent process supervision internals (`packages/host-service` source was not read; only the pty-daemon contract it consumes).
  - Next step if these matter: clone orca with `forceClone: true` and read `src/main/pty/`, `src/main/git/`, and the renderer Zustand stores; clone-read `packages/host-service/src/` in superset.
