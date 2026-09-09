# Migration map

Where everything went when Janela moved from Swift to Tauri and TypeScript.

This is the lookup table for anyone holding knowledge of the previous codebase, or
reading a document that predates the migration. It records every module, every type,
every `TODO:` seam, and what was deliberately dropped.

**The repository was scaffolded, not implemented.** Roughly 4,300 lines of Swift with
26 seams; only the layout algebra's shape, the handshake, the PTY design notes and
the database migrations had real substance. So "migrated" means *the interface, the
reasoning and the seam were carried across* — not that a body was translated.

Read [`decisions/0023-macos-first-portable.md`](decisions/0023-macos-first-portable.md)
first for why the migration happened, and
[`decisions/README.md`](decisions/README.md) § On the six supersessions for how the
ADRs handle it.

---

## Modules → packages

| Was | Is | Layer | Side | Notes |
| --- | --- | --- | --- | --- |
| `JanelaSupport` | `@janela/support` | 0 | shared | Split: the subprocess runner moved to the `@janela/support/process` subpath, which the layering gate marks daemon-only, so the rest stays linkable into a WebView |
| `JanelaCore` | `@janela/core` | 1 | shared | |
| `JanelaProtocol` | `@janela/protocol` | 2 | shared | |
| `JanelaGit` | `@janela/git` | 3 | daemon | |
| `JanelaPTY` | `@janela/pty` | 3 | daemon | Gained `native/`, a Rust cdylib. The only `bun:ffi` importer |
| `JanelaPersistence` | `@janela/db` | 3 | daemon | Renamed. GRDB → Prisma over `bun:sqlite` |
| `JanelaForge` *(planned)* | `@janela/forge` | 3 | daemon | Was never written in Swift; implemented here over the user's own `gh` and `glab` (#33) |
| `JanelaTerminal` | `@janela/terminal` | 4 | daemon | SwiftTerm → `@xterm/headless` |
| `JanelaSession` | `@janela/session` | 5 | daemon | |
| `JanelaDaemon` | `@janela/daemon` | 6 | daemon | Gained `frame-loop.ts`, which was implicit before |
| `janelad` | `apps/daemon` | 7 | daemon | Now one compiled binary |
| `JanelaClient` | `@janela/client` | 6 | client | |
| `JanelaDesign` | `@janela/design` | 7 | client | Asset catalog → CSS custom properties |
| `JanelaTerminalUI` | `@janela/terminal-ui` | 8 | client | SwiftTerm → `@xterm/xterm`. Layer moved from 7 to 8; it depends on `@janela/design`, so they cannot be peers |
| `JanelaUI` | `@janela/ui` | 9 | client | |
| `JanelaApp` + `App/Janela/` | `apps/desktop` | 10 | client | The Xcode app target and its one Swift file became a Tauri app: `src-tauri/` (Rust shell) plus `src/` (React) |
| `JanelaTestSupport` | `@janela/test-support` | 0 | tool | **Layer moved from 2 to 0** and its dependencies dropped to none: every package's tests link it, including `@janela/support`'s own, so a first-party dependency would be a cycle |

---

## Types → their new homes

### `@janela/core`

| Was | Is | Notes |
| --- | --- | --- |
| `Identifier<Subject>` | `Identifier<Subject>` | Phantom type → branded string. Erased at runtime, so ids encode as themselves |
| `ProjectID`, `SessionID`, `TerminalID`, `LaunchProfileID`, `AutomationID` | unchanged | |
| — | `AbsolutePath` | **New.** `URL` carried "this is absolute" for free; a bare string would lose it |
| — | `Instant` | **New.** ISO 8601 string, not `Date`. Every value here crosses a socket as JSON, and a `Date` needs a revival pass that one missed call site turns into a lie |
| `Accent` | `Accent` | Enum → string union |
| `Project`, `GitDescriptor`, `Forge`, `ProjectSettings`, `WorktreeRoot` | unchanged | |
| `AutomationCommand`, `AutomationEvent` | unchanged | |
| `Session`, `Session.Backing`, `WorktreeBinding`, `WorktreeBinding.Ownership` | `Session`, `Backing`, `WorktreeBinding`, `WorktreeOwnership` | Nested enums → discriminated unions on `kind` |
| `Session.worktree`, `.isStandalone`, `.ownsItsDirectory` | `worktreeOf()`, `isStandalone()`, `ownsItsDirectory()` | Computed properties → functions |
| — | `backingViolations()` | **New.** The invariant table in `domain-model.md` was enforced by `SessionBackingTests`; it is now also a function, because a row can arrive from the database half-populated |
| `TerminalDescriptor`, `TerminalRole`, `TerminalState` | unchanged | |
| `SessionLayout`, `.Tab`, `.Pane`, `.Axis` | `SessionLayout`, `LayoutTab`, `Pane`, `Axis` | Flattened out of the namespace |
| `Pane.maximumDepth`, `.fractionRange` | `MAXIMUM_PANE_DEPTH`, `FRACTION_RANGE` | |
| `LaunchProfile` | `LaunchProfile` | `symbolName` → `iconName`: SF Symbols are not available to a WebView, so it names a Lucide icon. Presentational either way, and an unknown name falls back rather than rendering nothing |
| `LaunchProfile.builtIns` | `BUILT_IN_PROFILES` | Now `Omit<LaunchProfile, "id">`: ids are assigned at seed time, because a hardcoded id would collide with a user's own copy |
| `GridSize` | `GridSize` | Was in `JanelaProtocol`; moved to `@janela/core`, where the other domain values live |

### `@janela/protocol`

| Was | Is | Notes |
| --- | --- | --- |
| `Frame`, `Frame.Kind` | `Frame`, `FrameKind` | |
| `Frame.maximumPayloadLength`, `.headerLength` | `MAXIMUM_PAYLOAD_LENGTH`, `FRAME_HEADER_LENGTH` | |
| `FrameError` | `FrameError` + `FrameErrorKind` | Class carries a discriminated detail |
| — | `FrameDecoder` | **New.** Was implicit. A socket delivers arbitrary chunk boundaries and a reader that assumes otherwise works until it does not |
| `Hello`, `Credential`, `ProtocolVersion`, `HandshakeRefusal` | `Hello`, `Credential`, `PROTOCOL_VERSION` / `MINIMUM_SUPPORTED_VERSION`, `HandshakeRefusal` | |
| `ClientMessage`, `DaemonMessage` | unchanged | Enums → discriminated unions on `type` |
| `ClientMessage.input`, `DaemonMessage.output` | `TerminalInput`, `TerminalOutput` | **Deliberately removed from the unions.** They are raw frames, and keeping them out is what stops someone routing them through the JSON path "just for now" |
| `RequestID`, `SubscriptionScope`, `StateUpdate`, `SessionCreationIntent`, `UserFacingFailure`, `AttentionSignal` | unchanged | |
| `MessageTransport` | `MessageTransport` | `AsyncThrowingStream` → `AsyncIterable` |
| `MessageCoder` | free functions in `message-coder.ts` | |

### `@janela/support`

| Was | Is | Notes |
| --- | --- | --- |
| `Log` (OSLog categories) | `log(category)` + `setLogSink` | The sink is injected: the daemon writes JSON lines to a rotated file under `~/Library/Logs/sh.janela.Janela/`, a client through Tauri's log plugin, a browser to the console |
| `Signpost` (OSSignposter) | `begin(name)` | `performance.mark`/`measure`. Same budgets, different instrument |
| `UserFacingError` | `UserFacingError` | Protocol → abstract class, so `instanceof` works |
| `UnexpectedFailure` | `UnexpectedFailure` | |
| — | `isUserFacing()` | **New.** `catch` gives `unknown`; the shown-or-logged rule needs a way to ask |
| — | `BoundedQueue`, `WaterMarks` | **New.** Non-negotiable #9 was a rule with no shared implementation |
| `ProcessRunning` *(implied)* | `ProcessRunning` in `/process` | Now explicit, and daemon-gated |

### Daemon packages

| Was | Is | Notes |
| --- | --- | --- |
| `GitRunning`, `GitOutcome`, `GitFailure`, `GitRunner` | unchanged | |
| `GitWorktree`, `WorktreeServing`, `WorktreeService`, `WorktreeRemovalSafety` | unchanged | |
| *(inside ADR 0013 only)* | `WorktreeIncluding` | **New file.** `.worktreeinclude` had no type; it was a documented behaviour |
| `TerminalSize`, `PseudoTerminal`, `PseudoTerminal.Configuration`, `.Failure` | `TerminalSize`, `PseudoTerminal`, `PseudoTerminalConfiguration`, `PseudoTerminalFailure` | Actor → an object over the native library |
| `TerminalByteStream` | `byte-stream.ts` constants + `PseudoTerminal.drain()` | The `DispatchIO` machinery became a Rust reader thread; the water marks and the never-drop rule are unchanged |
| `TerminalBytes` (`ContiguousArray<UInt8>`) | `TerminalBytes` (`Uint8Array`) | A view into a reusable buffer, valid only until the next drain |
| `JanelaDatabase`, `JanelaDatabase.migrator` | `JanelaDatabase`, `prisma/schema.prisma` + `prisma/migrations/` | Hand-written `DatabaseMigrator` → generated ordered SQL |
| — | `ProjectRepository`, `SessionRepository`, `LaunchProfileRepository` | **New.** GRDB record types were implied; the repositories make the core-values-only boundary explicit |
| — | `adapter.ts` | **New.** Prisma needs a driver adapter; ours, not a dependency |
| `TerminalEmulating`, `TerminalEventSink`, `TerminalNotification`, `PromptMark` | unchanged | `eventSink` → `events`; delegate methods → `onTitle`/`onAttention`/… |
| `LiveTerminal`, `TerminalRegistry`, `GridDimensions` | `LiveTerminal`, `TerminalRegistry`, `GridSize` | `GridDimensions` merged into `@janela/core`'s `GridSize` — two names for one thing was one too many |
| `SessionService`, `SessionCreationRequest`, `SessionRemovalPlan`, `StateObserving` | unchanged | |
| `ProjectService` | `ProjectService` | |
| `ShellEnvironment`, `janelaVariables` | unchanged | |
| — | `AutomationRunning`, `AutomationReport` | **New file.** The ordering lived inside `createSession`'s TODO; splitting it out is the one structural change to the brain, because "run these visibly, in order, blocking only for teardown" is a testable unit and the flow around it is not |
| `DaemonEndpoint`, `SocketPathTooLong` | `endpoint.ts`, `SocketPathTooLong` | |
| — | `PeerCredential`, `isAuthorized()` | **New.** The peer check needs a `getsockopt`, and `bun:ffi` is gated to `@janela/pty`, so the credential is passed in rather than fetched here |
| `DaemonServer`, `ConnectionListening` | `DaemonServer`, `ConnectionListening`, `AcceptedConnection` | |
| — | `FrameLoop` | **New.** "Coalesce once per frame per attached client" was a rule in ADR 0003 with no home |

### Client packages

| Was | Is | Notes |
| --- | --- | --- |
| `DaemonConnection`, `.Status` | `DaemonConnection`, `ConnectionStatus` | |
| `ProjectStore`, `SessionStore` | `ProjectStore`, `SessionStore` | `@MainActor @Observable` → observable stores. The isolation rule is gone; the ownership rule it protected is not |
| — | `MirrorApplying` | **New.** `apply` was internal; separating it names the one write path |
| `AttentionPolicy`, `.Context`, `AttentionDelivering` | `AttentionPolicy`, `AttentionContext`, `AttentionDelivering` | |
| `Metrics`, `Palette`, `Font.terminal` | `GRID_UNIT`/`SIDEBAR_WIDTH`/`CORNER_RADIUS`/`TERMINAL_INSETS`, `COLOR`, `TERMINAL_FONT_STACK` | Asset catalog colours → CSS custom properties, resolved by `prefers-color-scheme` and `prefers-contrast` |
| — | `MOTION` | **New.** `prefers-reduced-motion` needs durations to reduce |
| `TerminalRendering` | `TerminalRendering` | |
| `MainWindow`, `Sidebar`, `SessionDetail`, `ConnectionBanner` | unchanged | SwiftUI views → React components |
| `JanelaCommands` (SwiftUI `Commands`) | `COMMANDS` table in `@janela/ui` | Data, not a view: the native menu bar is built from it in the Rust shell, so the menu and the in-app palette cannot drift apart |
| `SettingsWindow` | *(not yet carried)* | Four tabs of `EmptyView`. Nothing was lost; a settings surface is a UI worker's task |
| `JanelaMain`, `AppEnvironment`, `PlaceholderTransport` | `apps/desktop/src/environment.ts`, `transport.ts` | `PlaceholderTransport` is gone: the real transport is a bridge to the Rust shell, and a placeholder that silently drops frames is worse than a connection that reports itself down |
| `JanelaAppMain.swift` | `apps/desktop/src/main.tsx` + `src-tauri/src/main.rs` | |

### Test support

| Was | Is |
| --- | --- |
| `TemporaryDirectory` | `temporaryDirectory()`, `AsyncDisposable` |
| `GitFixture`, `GitFixtureError` | `gitFixture()` |
| — | `recordingLogSink()`, `fakeProcessRunner()` — **new**, for the things we do fake |

---

## The 26 seams

Every `TODO:` in the Swift tree, and where it now lives. None was dropped.

| # | Was | Is | Seam |
| --- | --- | --- | --- |
| 1 | `JanelaCore/SessionLayout.swift:101` | `packages/core/src/session-layout.ts` | The layout algebra: split, close with sibling promotion, focus traversal |
| 2 | `JanelaProtocol/MessageTransport.swift:58` | `packages/protocol/src/message-coder.ts` | The raw-frame header for `input`/`output`, so both sides agree in one place |
| 3 | `JanelaGit/WorktreeService.swift:87` | `packages/git/src/worktree-service.ts` | `git worktree list --porcelain -z`, NUL-delimited |
| 4 | `JanelaGit/WorktreeService.swift:98` | `packages/git/src/worktree-service.ts` | `git worktree add`, then re-read so the result is git's view |
| 5 | `JanelaGit/WorktreeService.swift:104` | `packages/git/src/worktree-service.ts` | Removal safety: status, unpushed commits, lock state |
| 6 | `JanelaGit/WorktreeService.swift:114` | `packages/git/src/worktree-service.ts` | `git worktree remove` |
| 7 | `JanelaTerminal/LiveTerminal.swift:96` | `packages/terminal/src/live-terminal.ts` | The authoritative grid: damage tracking and the two repaint encoders |
| 8 | `JanelaSession/SessionService.swift:69` | `packages/session/src/session-service.ts` | Session creation ordering: worktree → copy → automation → terminals |
| 9 | `JanelaSession/ProjectService.swift:53` | `packages/session/src/project-service.ts` | Add a project, announce first, refresh git in the background |
| 10 | `JanelaDaemon/DaemonEndpoint.swift:42` | `packages/daemon/src/endpoint.ts` | Peer-uid verification via `LOCAL_PEERCRED` |
| 11 | `JanelaDaemon/DaemonServer.swift:45` | `packages/daemon/src/server.ts` | The accept loop; one bad connection must not take down the daemon |
| 12 | `JanelaDaemon/DaemonServer.swift:56` | `packages/daemon/src/server.ts` | Fan-out to subscribers, each with a bounded queue |
| 13 | `janelad/main.swift:17` | `apps/daemon/src/main.ts` | SIGTERM/SIGINT: hang up PTYs before exiting; ignore SIGPIPE |
| 14 | `janelad/main.swift:26` | `apps/daemon/src/main.ts` | Socket activation via `launch_activate_socket` — **now harder**, see note below |
| 15 | `janelad/main.swift:36` | `apps/daemon/src/main.ts` | Idle exit after a grace period, never while terminals are live |
| 16 | `janelad/main.swift:43` | `apps/daemon/src/main.ts` | Build the object graph, migrate, restore sessions idle, serve |
| 17 | `JanelaClient/DaemonConnection.swift:59` | `packages/client/src/connection.ts` | Connect, handshake, subscribe, pump frames, reconnect with backoff |
| 18 | `JanelaClient/ClientStores.swift:31` | `packages/client/src/stores.ts` | `ProjectStore` partial-update merge by id, preserving order |
| 19 | `JanelaClient/ClientStores.swift:80` | `packages/client/src/stores.ts` | `SessionStore` partial-update merge, keeping selection |
| 20 | `JanelaClient/AttentionPolicy.swift:87` | `packages/client/src/attention-policy.ts` | Expire delivered entries; clear a removed session's |
| 21 | `JanelaTerminalUI/TerminalSurface.swift:56` | `packages/terminal-ui/src/index.ts` | The terminal surface component; must not own a PTY or interpret input |
| 22 | `JanelaUI/MainWindow.swift:86` | `packages/ui/src/main-window.tsx` | The sidebar: standalone sessions, then collapsible projects |
| 23 | `JanelaUI/MainWindow.swift:103` | `packages/ui/src/main-window.tsx` | Tab strip, recursive pane view, a surface per pane |
| 24 | `JanelaUI/MainWindow.swift:127` | `packages/ui/src/connection-banner.tsx` | The reconnecting strip: thin and quiet |
| 25 | `JanelaUI/MainWindow.swift:132` | `packages/ui/src/connection-banner.tsx` | The version-skew banner; never restart the daemon automatically |
| 26 | `JanelaApp/JanelaMain.swift:89` | `apps/desktop/src/environment.ts` | Build the transport; register the launch agent, handling approval |

Seams **added** by the migration, which are not in the 26 and are marked as new where
they live: the PTY's native `lib.rs`, the `bun:ffi` bindings, the Prisma driver
adapter, the reusable controls in `@janela/design`, the automation runner, the frame
loop, the Tauri IPC transport, the Rust shell's window/menu/bridge/sidecar, and
`@janela/forge`'s CLI reader — the forge package was planned and empty in Swift, so
there was nothing to carry across.

### Seam 14 is the one that got harder

`launch_activate_socket` is a C function, and `bun:ffi` is deliberately gated to
`@janela/pty` so Janela has exactly one FFI surface. The expected resolution is one
more export on that existing library — already built, signed and located. The
alternative, binding the path ourselves, would trade away socket activation and with
it "a user who never opens Janela never has a process running", which
[ADR 0017](decisions/0017-daemon-lifecycle.md) chose deliberately. **Do not take that
route silently.** Both options are written into the `TODO`.

---

## Commands

Every `make` target has an equivalent. The rule is unchanged: everything a
contributor needs to do is one command, and inventing new invocations is how a
workflow becomes tribal knowledge.

| Was | Is | Notes |
| --- | --- | --- |
| `make bootstrap` | `bun run bootstrap` | Install, generate the Prisma client, build the native library |
| `make build` | `bun run typecheck` | The fast path. `tsc --build`, incremental, seconds |
| `make test` | `bun test` | Parallel, as before |
| `make lint` | `bun run lint` | Oxlint + `oxfmt --check` + **the layering gate**, which is new and non-optional |
| `make format` | `bun run format` | `oxfmt` + `oxlint --fix` |
| `make check` | `bun run check` | `lint` + `typecheck` + `test`. Exactly what CI runs |
| `make generate` | `bun run generate` | Was XcodeGen; now the Prisma client |
| `make app-build` | `bun run app:build` | `tauri build` — the signed bundle |
| `make app-run` | `bun run app` | `tauri dev` — builds and opens the window |
| `make daemon-restart` | `bun run daemon:restart` | Unchanged in purpose, including printing what it costs |
| `make daemon-status` | `bun run daemon:status` | |
| `make clean` | `bun run clean` | |
| `make open` | *(dropped)* | There is no Xcode project to open |
| — | `bun run check:layers` | **New.** The gate alone, for when you touched a dependency edge |
| — | `bun run build:native` | **New.** The PTY's Rust library |
| — | `bun run daemon:build` | **New.** Compile the sidecar |

Two notes worth carrying:

- `bun run build` exists and bundles the frontend; it is not the fast path.
  **`bun run check` is what to run constantly**, and it covers everything except the
  Tauri shell.
- `bun run generate` must run before anything typechecks on a fresh checkout, because
  the Prisma client is generated and gitignored. `bun run bootstrap` does it.

---

## Deliberately dropped

| Dropped | Why |
| --- | --- |
| `App/Janela/` — `Info.plist`, entitlements, asset catalog, `JanelaAppMain.swift` | Replaced by `tauri.conf.json` and `src-tauri/`. Entitlements and signing are unchanged in substance ([ADR 0008](decisions/0008-sandboxing-and-distribution.md)) |
| `project.yml`, `Janela.xcodeproj`, XcodeGen | No Xcode project. [ADR 0001](decisions/0001-project-generation.md)'s two problems — a file that does not merge and that agents corrupt — are gone rather than solved |
| `Makefile`, `scripts/*.sh` | Replaced by `bun run` scripts. Parity table above |
| `.swift-format`, `.swiftlint.yml` | Replaced by `.oxfmtrc.json` and `.oxlintrc.json`. The rules a machine can check were carried over; see [ADR 0025](decisions/0025-monorepo-tooling.md) |
| SwiftTerm, GRDB, swift-argument-parser | Replaced per [ADR 0018](decisions/0018-terminal-engine.md) and [ADR 0019](decisions/0019-prisma-sql-layer.md). `swift-argument-parser` was resolved but unused |
| `PlaceholderTransport` | A transport that silently drops frames is worse than a connection that honestly reports itself down, which the UI must handle anyway |
| `GridDimensions` | Merged into `GridSize`. Two names for a terminal's size in cells was one too many |
| `Sources/JanelaDesign/Resources/*.xcassets` | Colours are CSS custom properties. Same semantic names, same adaptation to appearance and contrast, no code branching |
| `SettingsWindow` | Four tabs of `EmptyView`. Not carried because there was nothing to carry; the settings surface is a UI task |
| Swift 6 strict concurrency | Not available. The isolation *rules* survive in [ADR 0020](decisions/0020-bun-daemon-runtime.md); compile-time data-race checking does not, and that ADR says so plainly |
| `ExistentialAny`, `MemberImportVisibility` | Language features with no TypeScript equivalent. The nearest analogues — `verbatimModuleSyntax`, explicit `.ts` extensions — are on |

---

## What a later worker should read

- **Building a package?** Its `src/index.ts` is the contract, and the doc comments
  carry the reasoning. The `TODO:` blocks name the traps.
- **Adding a dependency edge?** `scripts/layers.ts` is the graph, and it is enforced.
  Adding an edge is a design change: write it down in `decisions/` first.
- **Touching the terminal path?** [ADR 0018](decisions/0018-terminal-engine.md) and
  [ADR 0021](decisions/0021-pty-native-layer.md) carry the measurements, including the
  ones that are counter-intuitive — feed chunk size governs emulator throughput by a
  factor of twenty.
- **Reading a document that mentions Swift?** It predates this migration. The ADRs it
  belongs to are marked superseded, and the superseding one points back.
