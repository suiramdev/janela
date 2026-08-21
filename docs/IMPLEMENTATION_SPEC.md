# Janela Implementation Specification

Complete implementation specification derived from all Architecture Decision Records (ADRs) and development documentation. This document captures what must be built, in dependency order, with all constraints and requirements.

---

## Executive Summary

Janela is a native macOS terminal session manager with a daemon architecture. Sessions survive the app closing. The daemon owns PTYs and emulators; the app renders a mirror over a Unix socket. Worktrees are first-class but not central. The terminal owns the keyboard.

**Core architecture thesis**: A session is a directory with terminals in it. A project is where sessions come from.

**Critical path to minimum viable**: JanelaPTY → JanelaGit → JanelaPersistence → JanelaCore layout algebra → JanelaTerminal → JanelaSession → JanelaProtocol+JanelaDaemon → JanelaClient → JanelaUI → repaint encoder (last).

---

## I. Foundation Layer

### 1.1 JanelaPTY — Process and Terminal Byte Stream

**Status**: Highest priority. Everything depends on this. Currently throws on init.

**Requirements** (ADR 0004, ADR 0003):

#### PseudoTerminal

```swift
public actor PseudoTerminal {
    public init(
        command: [String],  // argv; never a shell string
        workingDirectory: URL,
        environment: [String: String],
        size: GridSize
    ) throws
    
    public func resize(to size: GridSize) async throws
    public func kill() async
    public func waitForExit() async -> Int32
}
```

**Implementation decisions**:

1. **Fork/exec chain**: `openpty()` → `fork()` → child calls `login_tty()`, `chdir`, `execve`.
   - **Cannot use `posix_spawn` or `Foundation.Process`** — they cannot give a child a controlling terminal.
   - Between `fork` and `exec` only async-signal-safe functions may be called.
   - Pre-marshal `char **` arrays for argv and environ BEFORE forking.

2. **PTY setup**:
   - `ws_xpixel`/`ws_ypixel` populated with backing-scale-aware values for Sixel/SGR-pixel mouse mode correctness on Retina.
   - Controller fd set to non-blocking.
   - Process group leadership established via `login_tty`.

3. **Process group killing**:
   - `kill(-pid, SIGTERM)` targets the process group, reaching grandchildren.
   - Wait with timeout; escalate to `SIGKILL` if needed.

4. **Error handling**:
   - `openpty` failure → throw with errno.
   - `fork` failure → throw, close controller fd.
   - Child `execve` failure → write errno to a pipe, `_exit(127)`.

#### TerminalByteStream

```swift
public protocol TerminalByteStreamDelegate: AnyObject {
    func streamDidReceiveOutput(_ data: DispatchData)
    func streamDidClose()
}

public final class TerminalByteStream: @unchecked Sendable {
    public init(fileDescriptor: Int32, delegate: TerminalByteStreamDelegate)
    public func write(_ data: Data) throws
    public func close()
}
```

**Implementation decisions** (ADR 0003):

1. **DispatchIO with water marks**:
   - High-water mark: 256 KB (measured from SwiftTerm source).
   - Low-water mark: 64 KB.
   - Read on a dedicated `DispatchQueue` (per terminal, serial).
   - **One-successor-read rule**: do not re-arm the read until the delegate has processed the current chunk.

2. **Back-pressure**:
   - Past high-water mark, stop re-arming the read.
   - Kernel PTY buffer fills, child blocks in `write(2)`.
   - **Never drop bytes**.

3. **Shutdown sequence** (to avoid `EV_VANISHED` crashes observed in SwiftTerm):
   - Close write channel first.
   - Flush read channel.
   - Close read channel.
   - Close file descriptor.

**Test strategy** (testing.md § JanelaPTY):

- Spawn `/bin/echo hello`, read output, assert exit code 0.
- Spawn `cat`, write bytes, read them back, terminate, assert clean shutdown.
- Spawn a process, resize, assert `SIGWINCH` delivery (via a test harness that prints the signal).
- Spawn a process group with grandchild, kill, assert all terminated.
- Spawn `yes`, let output accumulate to high-water mark, assert no unbounded memory growth.

**Seams**:

- `PseudoTerminal` is an actor. Tests use a protocol if needed, but prefer testing the real thing with real processes.
- `TerminalByteStream` is tested with real file descriptors backed by `pipe(2)` in tests.

---

### 1.2 JanelaGit — Worktree Operations

**Status**: Second priority. Required for worktree-backed sessions.

**Requirements** (ADR 0007):

#### GitRunning

```swift
public protocol GitRunning: Sendable {
    func run(args: [String], in directory: URL, env: [String: String]?) async throws -> String
    func probe(args: [String], in directory: URL) async -> Bool
}

public actor GitRunner: GitRunning {
    // Implementation over Foundation.Process
}
```

**Implementation decisions**:

1. **Always array arguments**: No shell, no quoting bugs, no injection.
2. **Always `-C <directory>`**: Never chdir the process; sessions run concurrently.
3. **`GIT_OPTIONAL_LOCKS=0` on read-only commands**: Background refresh never fights `index.lock`.
4. **Parse porcelain formats with `-z`**: Worktree paths may contain newlines.
5. **Resolve `git` from `PATH`**: Never hardcode `/usr/bin/git`; Xcode-shipped git lags.

#### WorktreeServing

```swift
public protocol WorktreeServing: Sendable {
    func list(in repository: URL) async throws -> [WorktreeDescriptor]
    func add(
        repository: URL,
        branch: String,
        startPoint: String?,
        path: URL
    ) async throws
    func remove(path: URL, force: Bool) async throws
    func removalWouldLoseWork(path: URL) async throws -> Bool
}

public actor WorktreeService: WorktreeServing {
    private let git: GitRunning
}
```

**Implementation decisions**:

1. **`list` parses `git worktree list --porcelain -z`**:
   - Split on `\0`, parse `worktree`, `branch`, `bare`, `detached`, `locked`, `prunable`.
   - Return array of `WorktreeDescriptor`.

2. **`add`**:
   - `git worktree add [-b <branch>] [<start-point>] <path>`.
   - Throws on failure; parse stderr for user-facing message.

3. **`remove`**:
   - `git worktree remove [--force] <path>`.
   - Throws on failure.

4. **`removalWouldLoseWork`**:
   - `git diff-index --quiet HEAD` in the worktree.
   - Exit 0 → no uncommitted changes, safe.
   - Exit 1 → uncommitted changes, user must confirm.
   - Exit 128 → detached HEAD or other state; treat as "would lose work".

**Test strategy** (testing.md § Git):

- Use `GitFixture` (scaffolds a real repo in `TemporaryDirectory`).
- Test `list` against a repo with 0, 1, and 3 worktrees; assert correct parse.
- Test `add` with and without start-point; assert worktree exists and has correct branch.
- Test `remove` on a clean worktree; assert it is gone.
- Test `removalWouldLoseWork` on a worktree with uncommitted changes; assert true.
- Test that paths with newlines are handled correctly (`-z` parsing).

---

### 1.3 JanelaPersistence — Database Schema and Records

**Status**: Third priority. Required before session/project stores.

**Requirements** (ADR 0005):

#### JanelaDatabase

```swift
public final class JanelaDatabase: @unchecked Sendable {
    public static func open(at url: URL) throws -> JanelaDatabase
    public static func inMemory() throws -> JanelaDatabase
    
    public func write<T>(_ block: (Database) throws -> T) async throws -> T
    public func read<T>(_ block: (Database) throws -> T) async throws -> T
}
```

**Implementation decisions**:

1. **GRDB `DatabasePool`** (not SwiftData, not Core Data).
2. **Location**: `~/Library/Application Support/sh.janela.Janela/janela.sqlite`.
3. **WAL journaling**, `synchronous = NORMAL`, `foreign_keys = ON`, 2 s busy timeout.
4. **Migrations** (append-only; never edit a shipped migration):

```swift
// v1-initial
CREATE TABLE project (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    directory TEXT NOT NULL,
    git_remote_url TEXT,
    git_default_branch TEXT,
    git_forge TEXT,  -- 'github', 'gitlab', or NULL
    settings TEXT NOT NULL,  -- JSON
    accent TEXT NOT NULL,
    is_expanded INTEGER NOT NULL DEFAULT 1,
    added_at REAL NOT NULL,
    sort_index INTEGER NOT NULL
);

CREATE TABLE session (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES project(id) ON DELETE CASCADE,  -- nullable for standalone
    name TEXT NOT NULL,
    directory TEXT NOT NULL,
    backing TEXT NOT NULL,  -- JSON: { "kind": "folder" | "projectDirectory" | "worktree", ... }
    layout TEXT NOT NULL,  -- JSON SessionLayout
    accent TEXT NOT NULL,
    created_at REAL NOT NULL,
    last_active_at REAL NOT NULL,
    is_pinned INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE terminal_descriptor (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    title TEXT,
    profile_id TEXT REFERENCES launch_profile(id) ON DELETE SET NULL,  -- nullable
    working_directory TEXT,  -- override, nullable
    starts_automatically INTEGER NOT NULL DEFAULT 0,
    role TEXT NOT NULL,  -- JSON: { "kind": "user" } | { "kind": "automation", "event": "..." }
    sort_index INTEGER NOT NULL
);

CREATE TABLE launch_profile (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    symbol_name TEXT NOT NULL,
    command TEXT NOT NULL,  -- JSON array
    environment TEXT NOT NULL,  -- JSON object
    is_agent INTEGER NOT NULL DEFAULT 0,
    is_builtin INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE automation_command (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    event TEXT NOT NULL,  -- 'worktreeCreated', 'sessionStart', 'sessionTeardown'
    command TEXT NOT NULL,  -- JSON array
    is_enabled INTEGER NOT NULL DEFAULT 1,
    timeout_seconds INTEGER NOT NULL DEFAULT 30,
    sort_index INTEGER NOT NULL
);
```

1. **SessionLayout depth bound**: Validate on encode and decode to max depth 6 (ADR 0010).
2. **Cascade tests** encode product rules:
   - Deleting a project deletes its sessions.
   - Deleting a session deletes its terminal descriptors and layout.
   - Deleting a launch profile does NOT cascade; terminal descriptors' `profile_id` is SET NULL.
   - A session with `project_id` set must reference an existing project (FK enforced).
   - A standalone session has `project_id IS NULL` (not a FK violation).

#### Record types

```swift
public struct ProjectRecord: Codable, FetchableRecord, PersistableRecord {
    public var id: ProjectID
    public var name: String
    public var directory: URL
    public var gitRemoteURL: String?
    public var gitDefaultBranch: String?
    public var gitForge: String?  // "github", "gitlab", or nil
    public var settings: ProjectSettings  // stored as JSON
    public var accent: Accent
    public var isExpanded: Bool
    public var addedAt: Date
    public var sortIndex: Int
}

// Similar for SessionRecord, TerminalDescriptorRecord, LaunchProfileRecord, AutomationCommandRecord
```

**Test strategy** (testing.md § Persistence):

- Round-trip tests for every record type: insert, fetch, assert equality.
- Cascade tests:
  - Insert project with sessions; delete project; assert sessions gone.
  - Insert session with terminals; delete session; assert terminals gone.
  - Insert launch profile, reference it from terminal; delete profile; assert terminal.profileID is nil.
- Depth bound test: Encode a SessionLayout at depth 7; assert rejection.
- Migration tests: Apply v1-initial to an empty DB; assert all tables exist with correct schema.

---

## II. Domain and Layout

### 2.1 JanelaCore — Domain Types and Layout Algebra

**Status**: Fourth priority. Pure logic, no I/O; can be built and tested in parallel with I/O layers.

**Requirements** (ADR 0009, ADR 0010, domain-model.md):

#### Domain types (all `Sendable` structs/enums)

```swift
public struct Project: Identifiable, Hashable, Sendable, Codable { /* ... */ }
public struct Session: Identifiable, Hashable, Sendable, Codable { /* ... */ }
public struct TerminalDescriptor: Identifiable, Hashable, Sendable, Codable { /* ... */ }
public struct LaunchProfile: Identifiable, Hashable, Sendable, Codable { /* ... */ }
public struct AutomationCommand: Identifiable, Hashable, Sendable, Codable { /* ... */ }

public enum Session.Backing: Hashable, Sendable, Codable {
    case projectDirectory
    case folder
    case worktree(WorktreeBinding)
}

public struct WorktreeBinding: Hashable, Sendable, Codable {
    public var branch: String?
    public var baseCommit: String?
    public var path: URL
    public var ownership: Ownership  // .managed | .adopted
    public var includedPaths: [String]
}

public enum TerminalRole: Hashable, Sendable, Codable {
    case user
    case automation(AutomationEvent)
}

public enum TerminalState: Hashable, Sendable {
    case idle
    case running
    case needsAttention
    case exited(code: Int32)
    case failed(message: String)
}
```

#### SessionLayout

```swift
public struct SessionLayout: Hashable, Sendable, Codable {
    public var tabs: [Tab]
    public var focusedTabIndex: Int
    
    public struct Tab: Hashable, Sendable, Codable {
        public var title: String?
        public var root: Pane
        public var focusedTerminalID: TerminalID
    }
    
    public indirect enum Pane: Hashable, Sendable, Codable {
        case terminal(TerminalID)
        case split(axis: Axis, fraction: Double, first: Pane, second: Pane)
    }
    
    public enum Axis: String, Hashable, Sendable, Codable {
        case horizontal, vertical
    }
}
```

**Implementation decisions** (ADR 0010):

1. **Depth bound**: Max depth 6. Enforced at encode (throw) and decode (truncate + log).
2. **Fraction clamped**: `0.05...0.95`. A pane you cannot see is a pane you cannot close.
3. **Referential integrity repaired on load**: Pane naming a missing terminal is dropped, not an error.
4. **Closing collapses splits**: Removing a terminal promotes its sibling. Last terminal in a tab closes the tab; last tab leaves one idle terminal.
5. **Focus traversal**: next/previous terminal in tree order (depth-first, left-to-right).

#### Layout operations

```swift
extension SessionLayout {
    public mutating func split(terminalID: TerminalID, axis: Axis, newTerminalID: TerminalID)
    public mutating func close(terminalID: TerminalID) -> TerminalID?  // returns new focused ID
    public mutating func focusNext()
    public mutating func focusPrevious()
    public mutating func newTab(terminalID: TerminalID, title: String?)
    public mutating func closeTab(index: Int)
    public func validate() throws  // depth, fraction, referential integrity
}
```

**Test strategy** (testing.md § Layout algebra):

- Pure unit tests, milliseconds each.
- Test split: start with one terminal, split horizontal, assert two panes with correct fraction.
- Test close-and-promote: split A → (B, C), close B, assert C promoted.
- Test close-last-in-tab: one tab with one terminal, close it, assert session has one idle terminal (not zero).
- Test depth bound: build a tree at depth 6, assert valid; attempt depth 7, assert truncated.
- Test fraction clamp: attempt split with fraction 0.02, assert clamped to 0.05.
- Test referential integrity repair: load layout naming terminal "abc", session has no "abc", assert pane dropped.
- Test focus traversal: build tree with 4 terminals, call focusNext 4 times, assert visits all then wraps.

---

## III. Daemon-Side Implementation

### 3.1 JanelaTerminal — Emulator Seam and Live Terminal

**Status**: Fifth priority. Requires PTY (1.1) and domain types (2.1).

**Requirements** (ADR 0004, ADR 0015):

#### TerminalEmulating (protocol, daemon-side)

```swift
public protocol TerminalEmulating: Sendable {
    func feed(data: [UInt8])
    func resize(to size: GridSize)
    func damageRevision() -> Int
    func encodeDamageSince(revision: Int) -> [UInt8]  // escape sequences
    func serialiseForAttach() -> [UInt8]  // full grid as escape sequences
    func snapshotText(range: TextRange) -> String
    func clearScrollback()
    var eventSink: (any TerminalEventSink)? { get set }
}

public protocol TerminalEventSink: Sendable {
    func terminalDidRequestAttention(kind: AttentionSignal.Kind)
    func terminalDidMarkPrompt(kind: PromptMarkKind)
    func terminalDidChangeTitle(_ title: String)
    func terminalDidChangeWorkingDirectory(_ url: URL)
}
```

**Implementation decisions**:

1. **Backed by SwiftTerm.Terminal** (headless, no view).
2. **`@preconcurrency import SwiftTerm`** (Swift 5 mode, ADR 0003).
3. **`feed` is the hot path**: Called from `TerminalByteStream` delegate on a per-terminal queue.
4. **`damageRevision` increments on every change**: Cheap integer, used for delta encoding.
5. **`encodeDamageSince` is the repaint encoder** (see VI below; stub initially).
6. **`serialiseForAttach`**: Full grid → ANSI escape sequences. Correct after any delay.
7. **Parse BEL, OSC 9, OSC 777, OSC 133, OSC 0/2, OSC 7** in the feed path; call `eventSink` methods.

#### LiveTerminal (daemon-only)

```swift
public actor LiveTerminal {
    public let id: TerminalID
    public private(set) var state: TerminalState
    
    public init(descriptor: TerminalDescriptor, emulator: any TerminalEmulating)
    
    public func start(
        pty: PseudoTerminal,
        stream: TerminalByteStream
    ) async throws
    
    public func resize(to size: GridSize) async
    public func write(_ data: Data) async throws
    public func snapshot(range: TextRange) async -> String
    public func clearScrollback() async
    public func terminate() async
}
```

**Implementation decisions**:

1. **`state` is derived from child process and emulator**:
   - `.idle`: not started.
   - `.running`: child alive, no attention signal.
   - `.needsAttention`: child alive, recent BEL/OSC signal.
   - `.exited(code)`: child terminated cleanly.
   - `.failed(message)`: spawn failed or child crashed.

2. **`start` wires stream → emulator**:
   - `TerminalByteStream.delegate` feeds emulator on read.
   - `emulator.eventSink` updates `state` on attention signals.
   - Launch PTY, start stream.

3. **`write` is input from client**: Passes bytes to PTY controller fd.

4. **`resize` calls both PTY and emulator**: `TIOCSWINSZ` on fd, `emulator.resize`.

**Test strategy**:

- LiveTerminal with a real PTY and real emulator: spawn `/bin/echo`, wait for exit, assert state is `.exited(0)`.
- Feed ANSI sequences to emulator, call `snapshot`, assert correct text.
- Feed BEL, assert `eventSink` called with `.bell`.
- Resize, assert both PTY and emulator resized.

---

### 3.2 JanelaSession — Session and Project Stores

**Status**: Sixth priority. Requires persistence (1.3), git (1.2), terminal (3.1).

**Requirements** (ADR 0009, ADR 0014):

#### ProjectStore

```swift
@Observable
public final class ProjectStore {
    public private(set) var projects: [Project] = []
    
    private let database: JanelaDatabase
    private let workTree: WorktreeServing
    
    public init(database: JanelaDatabase, worktree: WorktreeServing)
    
    public func load() async throws
    public func add(directory: URL, name: String?) async throws -> Project
    public func update(_ project: Project) async throws
    public func remove(_ project: Project) async throws -> RemovalPlan
}

public struct RemovalPlan: Sendable {
    public var sessions: [Session]
    public var liveTerminalCount: Int
    public var worktreeCount: Int
    public var totalIncludedBytes: Int64
}
```

**Implementation decisions**:

1. **`load` reads from database**: Fetch all `ProjectRecord`, map to `Project`, sort by `sortIndex`.
2. **`add` detects git**: Run `git remote get-url origin`, `git symbolic-ref HEAD`, `git config --get forge.type` (custom key for forge override). Populate `GitDescriptor` if detected. Insert into DB.
3. **`remove` computes removal plan**:
   - Fetch all sessions for project.
   - For each worktree-backed session, sum `includedPaths` sizes.
   - Count live terminals (state != `.idle`, != `.exited`).
   - Return plan; user confirms.
   - On confirm: delete sessions (cascade handles terminals), delete project.

#### SessionStore

```swift
@Observable
public final class SessionStore {
    public private(set) var sessions: [Session] = []
    
    private let database: JanelaDatabase
    private let worktree: WorktreeServing
    private let projectStore: ProjectStore
    
    public init(database: JanelaDatabase, worktree: WorktreeServing, projectStore: ProjectStore)
    
    public func load() async throws
    public func createSession(_ request: SessionCreationRequest) async throws -> Session
    public func update(_ session: Session) async throws
    public func removalPlan(for session: Session) async throws -> SessionRemovalPlan
    public func removeSession(_ session: Session, options: RemovalOptions) async throws
}

public enum SessionCreationRequest: Sendable {
    case standalone(directory: URL, name: String?)
    case inProject(ProjectID, name: String?)
    case newWorktree(project: ProjectID, branch: String, startPoint: String?, directory: URL?, name: String?)
    case adoptWorktree(project: ProjectID, directory: URL, name: String?)
    case fromPullRequest(project: ProjectID, reference: PullRequestReference)
}

public struct SessionRemovalPlan: Sendable {
    public var liveTerminalCount: Int
    public var worktreeWillBeRemoved: Bool
    public var includedPaths: [String]
    public var totalIncludedBytes: Int64
}

public struct RemovalOptions: Sendable {
    public var removeWorktree: Bool
    public var force: Bool
}
```

**Implementation decisions** (ADR 0013, ADR 0014):

1. **`createSession` orchestrates worktree + .worktreeinclude + automation**:

```text
Ordering (when worktree-backed):
  git worktree add
      ↓
  .worktreeinclude copy (if file exists)
      ↓
  .worktreeCreated automation commands (if any)
      ↓
  return Session (with .idle terminals for automation + user)
```

1. **`.worktreeinclude` resolution**:
   - `git ls-files -o -i --exclude-from=.worktreeinclude -z --directory` in project root.
   - For each path: `stat` to get size, sum total.
   - If total > 2 GB (default): prompt user with actual size and first offending path. User chooses proceed or skip.
   - Copy with `clonefile(2)` (APFS CoW); fallback to `FileManager.copyItem` on failure.
   - Never follow symlinks, never copy `.git`, skip unreadable files (log path shape, never content).
   - Record copied paths in `WorktreeBinding.includedPaths`.

2. **Automation** (ADR 0014):
   - For `.worktreeCreated` and `.sessionStart`: create `TerminalDescriptor` with `role: .automation(event)`.
   - Commands run in order (not parallel).
   - Failure is visible (terminal stays open) and non-fatal.
   - `.sessionStart` runs once per session (daemon records it fired).
   - `.sessionTeardown` is blocking, bounded by `timeout` (default 30 s).

3. **`ShellEnvironment` resolution**:
   - Launch shell argv: `["-\(shell.lastPathComponent)"]` (login shell via `-` prefix).
   - Prevents "command not found" for `claude`, `codex`, etc.

**Test strategy** (testing.md):

- Use in-memory database + fake `WorktreeServing`.
- Test createSession standalone: assert session exists, directory correct, no projectID.
- Test createSession inProject: assert projectID set, backing is `.projectDirectory`.
- Test createSession newWorktree: assert git worktree created, backing is `.worktree`, worktree binding correct.
- Test .worktreeinclude: create repo with `.worktreeinclude` listing `node_modules/`, create worktree, assert `node_modules/` copied, `includedPaths` recorded.
- Test automation: create project with `.sessionStart` command, create session, assert automation terminal exists with `role: .automation(.sessionStart)`.
- Test removalPlan: session with worktree + includedPaths, assert plan includes sizes and paths.
- Test removeSession: assert session deleted, worktree removed if `removeWorktree: true`.

---

### 3.3 JanelaProtocol + JanelaDaemon — Socket and Message Handling

**Status**: Seventh priority. Requires all daemon-side layers.

**Requirements** (ADR 0016, ADR 0017):

#### Framing

```text
┌────────────┬──────────┬─────────────────────┐
│ length u32 │ kind u8  │ payload             │
│ big-endian │          │ JSON or raw bytes   │
└────────────┴──────────┴─────────────────────┘
```

**Frame kinds**:

- `0x01`: Control message (JSON `ClientMessage` or `DaemonMessage`)
- `0x02`: Terminal output (raw bytes)
- `0x03`: Terminal input (raw bytes)

**Bounds**:

- Max frame length: 8 MB. Frames claiming more → protocol error → close connection.

#### Messages

```swift
// JanelaProtocol (shared by daemon and client)

public struct Hello: Codable, Sendable {
    public var protocolVersion: Int
    public var minimumSupported: Int
    public var clientName: String
    public var credential: Credential?  // unused in v1
}

public enum ClientMessage: Codable, Sendable {
    case hello(Hello)
    case subscribe(SubscriptionScope)
    case createSession(SessionCreationRequest)
    case removeSession(SessionID, RemovalOptions)
    case attach(TerminalID, viewport: GridSize)
    case detach(TerminalID)
    case input(TerminalID, bytes: [UInt8])  // sent as raw frame kind 0x03
    case resize(TerminalID, GridSize)
    case snapshotText(TerminalID, TextRange)
}

public enum DaemonMessage: Codable, Sendable {
    case hello(Hello)
    case state(StateUpdate)
    case output(TerminalID, bytes: [UInt8])  // sent as raw frame kind 0x02
    case attention(AttentionSignal)
    case terminalExited(TerminalID, code: Int32)
    case failure(RequestID, UserFacingError)
}

public struct StateUpdate: Codable, Sendable {
    public var projects: [Project]?
    public var sessions: [Session]?
    public var terminalStates: [TerminalID: TerminalState]?
}
```

**Implementation decisions**:

1. **Handshake**:
   - Every connection begins with `Hello`.
   - Daemon checks `protocolVersion` range; if incompatible, send `Hello` with refusal + close.
   - **Never kill terminals on version skew** (ADR 0015, 0016).

2. **Authentication (local socket, v1)**:
   - Socket at `~/.janela/run/janelad.sock`, mode `0700`.
   - `getsockopt(LOCAL_PEERCRED)` → `struct xucred`, verify `uid` matches daemon's.
   - Reject connection if uid differs.
   - Record `LOCAL_PEERPID` for logs only (not for auth; pid is reusable).

3. **Request/response correlation**:
   - ClientMessage carries `requestID: UUID`.
   - DaemonMessage.failure includes `requestID`.
   - State updates and output are unsolicited.

4. **Subscription**:
   - Client subscribes to `.all`, `.project(ProjectID)`, or `.session(SessionID)`.
   - Daemon sends full `StateUpdate` on subscribe, then deltas on change.

5. **Terminal attach/detach**:
   - `attach` with viewport size.
   - Daemon sends `serialiseForAttach()` (full grid) once, then `output` frames with deltas.
   - Multiple clients attached to one terminal: daemon resolves size as minimum of all viewports (ADR 0016).
   - `detach` stops output to that client for that terminal.

#### JanelaDaemon

```swift
@main
struct JanelaDaemon {
    static func main() async throws {
        let database = try JanelaDatabase.open(at: databaseURL)
        let git = GitRunner()
        let worktree = WorktreeService(git: git)
        let projectStore = ProjectStore(database: database, worktree: worktree)
        let sessionStore = SessionStore(database: database, worktree: worktree, projectStore: projectStore)
        
        try await projectStore.load()
        try await sessionStore.load()
        
        let listener = try SocketListener(path: socketPath)
        
        for try await connection in listener.connections() {
            Task {
                try await handleConnection(connection, sessionStore: sessionStore)
            }
        }
    }
}
```

**Implementation decisions**:

1. **launchd socket activation** (ADR 0017):
   - LaunchAgent plist declares socket at `~/.janela/run/janelad.sock`.
   - Daemon calls `launch_activate_socket` to get fd from launchd.
   - First connection starts daemon; idle exit after 5 min if no clients and no live terminals.

2. **Lifecycle**:
   - Daemon exits when: last client disconnects AND no live terminals AND idle for 5 min.
   - `KeepAlive`/`SuccessfulExit=false` in plist → launchd restarts after crash.
   - User chooses "Stop Background Service" → terminate all terminals, exit deliberately (no restart).

3. **Per-connection state**:
   - `Connection` actor tracks subscriptions, attached terminals, correlation ids.
   - Output coalesced once per frame (60 fps) per attached client.

**Test strategy** (testing.md § Protocol):

- Bind a real socket in `TemporaryDirectory` (keep path short, `sun_path` is 104 bytes).
- Test handshake: connect, send `Hello`, receive `Hello`, assert accepted.
- Test version skew: connect with unsupported version, assert refusal + close (terminals unaffected).
- Test auth: connect from different uid, assert rejected.
- Test subscribe: send `subscribe(.all)`, assert `StateUpdate` with projects and sessions.
- Test attach: send `attach(terminalID, viewport)`, assert `serialiseForAttach` frame, then `output` frames.
- Test input: send `input(terminalID, bytes)`, spawn `cat` in terminal, assert bytes echoed back.
- Test multiple clients: attach two clients to one terminal with different viewport sizes, assert terminal resized to minimum.

---

## IV. Client-Side Implementation

### 4.1 JanelaClient — Connection, Mirror, and Attention Policy

**Status**: Eighth priority. Requires protocol (3.3).

**Requirements** (ADR 0015, ADR 0011):

#### ConnectionManager

```swift
@Observable
public final class ConnectionManager {
    public private(set) var state: ConnectionState
    
    public func connect() async throws
    public func disconnect()
    public func send(_ message: ClientMessage) async throws
    public var messages: AsyncStream<DaemonMessage> { get }
}

public enum ConnectionState: Sendable {
    case disconnected
    case connecting
    case connected(version: Int)
    case reconnecting(attempt: Int)
    case failed(error: String)
}
```

**Implementation decisions**:

1. **Reconnection with exponential backoff**:
   - First retry: 1 s.
   - Each retry: min(previous * 2, 30 s).
   - Max retries: unlimited (daemon may be restarting).

2. **Subscribe on connect**:
   - After handshake, send `subscribe(.all)`.
   - Receive `StateUpdate`, populate mirrors.

3. **Correlation tracking**:
   - Map `requestID → continuation` for responses.
   - Timeout after 30 s; throw error.

#### Mirror stores

```swift
@Observable
public final class ProjectStore {
    public private(set) var projects: [Project] = []
    
    func apply(_ update: StateUpdate) {
        if let projects = update.projects {
            self.projects = projects
        }
    }
}

@Observable
public final class SessionStore {
    public private(set) var sessions: [Session] = []
    public private(set) var terminalStates: [TerminalID: TerminalState] = [:]
    
    func apply(_ update: StateUpdate) {
        if let sessions = update.sessions {
            self.sessions = sessions
        }
        if let terminalStates = update.terminalStates {
            self.terminalStates.merge(terminalStates) { $1 }
        }
    }
}

@MainActor
@Observable
public final class TerminalMirror {
    public let id: TerminalID
    public private(set) var descriptor: TerminalDescriptor
    public private(set) var state: TerminalState
    public private(set) var isAttached: Bool = false
    
    public func attach(viewport: GridSize, connection: ConnectionManager) async throws
    public func detach() async
    public func write(_ data: Data) async throws
}
```

**Implementation decisions**:

1. **`@MainActor` for all UI-facing state** (ADR 0003).
2. **Apply updates synchronously**: No `await` in SwiftUI views to read a tab title.
3. **Stale state is acceptable**: Client renders last known state; daemon is source of truth.

#### Attention policy

```swift
public protocol AttentionDelivering: Sendable {
    func deliver(_ delivery: AttentionDelivery) async
    func withdraw(for sessionID: SessionID) async
}

public struct AttentionDelivery: Sendable {
    public var sessionID: SessionID
    public var terminalID: TerminalID
    public var kind: AttentionKind
    public var title: String
    public var subtitle: String
    public var body: String?
}

public enum AttentionKind: Sendable {
    case bell
    case notification(title: String?, body: String)
    case commandFinished(exitCode: Int32, duration: Duration)
}

@MainActor
public final class AttentionPolicy {
    private let deliverer: any AttentionDelivering
    private var recentDeliveries: [TerminalID: Date] = [:]
    
    public func process(
        _ signal: AttentionSignal,
        focusedTerminalID: TerminalID?,
        isAppFrontmost: Bool
    ) async {
        // Apply rules, call deliverer if delivery warranted
    }
}
```

**Implementation decisions** (ADR 0011):

1. **Rules** (in order):
   - Always update in-app state (badge on session button, indicator on pane).
   - Never deliver for focused terminal in frontmost window.
   - Deliver to Notification Centre only when Janela not frontmost OR terminal is in unselected session.
   - Coalesce per terminal with 5 s window.
   - BEL badges but does not deliver unless user opted into "notify on bell".
   - OSC 9/777 always delivers (program explicitly requested).
   - OSC 133 `D` with non-zero exit code delivers only if command ran > 10 s.

2. **Content**:
   - Title: session name.
   - Subtitle: terminal title.
   - Body: OSC payload if present, else generic sentence.
   - **Body never logged, never persisted** (ADR 0011).

3. **Clicking notification**:
   - Activate app, select session, focus terminal, withdraw notification.

**Test strategy**:

- Fake `AttentionDelivering` that records calls.
- Process BEL with terminal focused + app frontmost → assert no delivery, badge updated.
- Process BEL with terminal unfocused + app frontmost → assert delivery.
- Process BEL twice within 5 s → assert one delivery (coalesced).
- Process OSC 9 notification → assert always delivers.
- Process OSC 133 `D;0` after 2 s → assert no delivery (short command).
- Process OSC 133 `D;1` after 15 s → assert delivery (long command failed).

---

### 4.2 JanelaDesign — Tokens and Reusable Controls

**Status**: Can be built in parallel with client logic.

**Requirements** (product.md, conventions.md):

#### Design tokens

```swift
public enum ColorToken {
    public static let surfacePrimary: Color
    public static let surfaceSecondary: Color
    public static let accent: Color
    // ... per accent color
}

public enum TypographyToken {
    public static let body: Font
    public static let bodyMono: Font
    public static let caption: Font
    // ...
}

public enum SpacingToken {
    public static let xs: CGFloat = 4
    public static let s: CGFloat = 8
    public static let m: CGFloat = 12
    public static let l: CGFloat = 16
    // ...
}
```

**Implementation decisions**:

1. **Native macOS appearance**: Use system colors, no custom themes beyond accent.
2. **SF Symbols** for icons.
3. **SF Mono** for terminal and monospace needs.
4. **Accent colors**: User-selectable per project/session.

#### Reusable controls

```swift
public struct SessionButton: View {
    public let session: Session
    public let badge: Int?
    public let action: () -> Void
}

public struct StatusIndicator: View {
    public let state: TerminalState
}

public struct EmptyStateView: View {
    public let title: String
    public let message: String
    public let action: (() -> Void)?
}
```

**Test strategy**:

- SwiftUI previews for each control in all states.
- Snapshot tests (if adopted): render views, compare to golden images.

---

### 4.3 JanelaTerminalUI — Terminal View Rendering

**Status**: Requires terminal mirror (4.1).

**Requirements** (ADR 0004, ADR 0015):

#### TerminalRendering (protocol, client-side)

```swift
public protocol TerminalRendering: AnyObject {
    func feed(data: [UInt8])
    func resize(to size: GridSize)
    func focus()
    var selectedText: String? { get }
}
```

**Implementation decisions**:

1. **Backed by `SwiftTerm.TerminalView`** (AppKit).
2. **`@preconcurrency import SwiftTerm`** (Swift 5 mode).
3. **`feed` called from connection's output stream** (already on main actor).
4. **Keyboard input** → `TerminalMirror.write` → `ClientMessage.input` → daemon.

#### TerminalViewWrapper

```swift
public struct TerminalViewWrapper: NSViewRepresentable {
    @Binding var mirror: TerminalMirror
    
    public func makeNSView(context: Context) -> SwiftTerm.TerminalView {
        let view = SwiftTerm.TerminalView(frame: .zero)
        // Configure fonts, colors, etc.
        return view
    }
    
    public func updateNSView(_ nsView: SwiftTerm.TerminalView, context: Context) {
        // Feed output, handle resize
    }
}
```

**Test strategy**:

- Manual testing with real daemon connection.
- Feed known ANSI sequences, verify rendering (visual).
- Type input, verify echoed back from `cat` or shell.

---

### 4.4 JanelaUI — SwiftUI Views and Navigation

**Status**: Ninth priority. Requires all client layers.

**Requirements** (ADR 0009, ADR 0010, development.md):

#### View hierarchy

```text
RootView
  ├─ NavigationSplitView
  │    ├─ Sidebar (collapsible)
  │    │    ├─ Standalone sessions (above projects)
  │    │    └─ Projects (collapsible, each with sessions)
  │    └─ Detail
  │         ├─ SessionView
  │         │    ├─ TabStrip
  │         │    └─ SplitView (recursive, renders Panes)
  │         │         └─ TerminalViewWrapper
  │         └─ EmptyStateView (when no session selected)
  └─ Sheets, alerts, popovers
```

**Implementation decisions**:

1. **Sidebar**:
   - Two sections: Standalone (flat list), Projects (collapsible groups).
   - Each session is a button; clicking selects session.
   - Badges show live terminal count or attention count.
   - Right-click context menu: New Session, Rename, Delete.

2. **Tab strip**:
   - Horizontal scroll view of tab buttons.
   - `⌘⇧[` / `⌘⇧]` to switch.
   - Tab title derived from focused terminal's title if tab title is nil.

3. **Split view**:
   - Recursive split rendering from `SessionLayout.Pane`.
   - `GeometryReader` + `HSplitView`/`VSplitView` (or custom splitter).
   - Dragging splitter updates `fraction`, calls `session.updateLayout`.
   - Coalesce `TIOCSWINSZ`: debounce resize events, send at most once per 100 ms.

4. **Keyboard shortcuts** (ADR 0010):
   - `⌘D` / `⌘⇧D`: split horizontal/vertical.
   - `⌘⌥←→↑↓`: move focus between panes.
   - `⌘W`: close focused pane.
   - `⌘T`: new tab.
   - `⌘⇧[` / `⌘⇧]`: switch tabs.
   - **No `Ctrl` chords bound** (terminal owns keyboard).

**Test strategy**:

- Manual testing with real daemon.
- UI tests (if adopted): simulate clicks, verify navigation.
- Accessibility audit: VoiceOver, keyboard navigation.

---

### 4.5 JanelaApp — Composition Root and Lifecycle

**Status**: Tenth priority. Wires everything together.

**Requirements** (ADR 0017, ADR 0011):

#### AppEnvironment

```swift
public struct AppEnvironment {
    public let database: JanelaDatabase
    public let connection: ConnectionManager
    public let projectStore: ProjectStore
    public let sessionStore: SessionStore
    public let attentionPolicy: AttentionPolicy
    
    public static func live() async throws -> AppEnvironment {
        let database = try JanelaDatabase.open(at: databaseURL)
        let connection = ConnectionManager(socketPath: socketPath)
        try await connection.connect()
        
        let projectStore = ProjectStore()
        let sessionStore = SessionStore()
        let attentionPolicy = AttentionPolicy(deliverer: NotificationDeliverer())
        
        return AppEnvironment(
            database: database,
            connection: connection,
            projectStore: projectStore,
            sessionStore: sessionStore,
            attentionPolicy: attentionPolicy
        )
    }
}
```

#### JanelaAppMain

```swift
@main
struct JanelaAppMain: App {
    @State private var environment: AppEnvironment?
    
    var body: some Scene {
        WindowGroup {
            if let environment {
                RootView()
                    .environment(environment.projectStore)
                    .environment(environment.sessionStore)
                    .environment(environment.connection)
            } else {
                ProgressView("Connecting…")
                    .task {
                        do {
                            environment = try await AppEnvironment.live()
                        } catch {
                            // Show error, offer degraded mode
                        }
                    }
            }
        }
        .commands {
            SidebarCommands()
            // Custom commands
        }
        
        Settings {
            SettingsView()
        }
    }
}
```

**Implementation decisions**:

1. **Daemon registration** (ADR 0017):
   - First launch: `SMAppService.agent(plistName: "sh.janela.janelad.plist").register()`.
   - Handle `requiresApproval`: show alert, link to System Settings, run in degraded mode.
   - Degraded mode: in-process terminals (no persistence, die on quit), visible explanation.

2. **Attention delivery** (ADR 0011):
   - `NotificationDeliverer` implements `AttentionDelivering`.
   - Request `UNUserNotificationCenter` authorization on first delivery (lazy).
   - Denial is supported: in-app badges still work.

3. **Version skew handling** (ADR 0016, 0017):
   - Connection handshake fails → show dialog: "Background service is old. 3 sessions, 2 with live terminals. Restart?"
   - User chooses when to restart daemon (kills terminals).

**Test strategy**:

- App launches, connects to daemon, shows sidebar with projects/sessions.
- Create session, verify appears in sidebar and DB.
- Restart daemon (via `make daemon-restart`), verify reconnection.
- Send notification, verify Notification Centre delivery (manual).

---

## V. Optional Features (Can Be Built in Any Order After Core)

### 5.1 `.worktreeinclude` — Copy Ignored Files Into Worktrees

**Status**: Independent. Requires git (1.2).

**Specification**: See § 3.2 SessionStore implementation above and ADR 0013.

**Additional test**: Create repo with `.worktreeinclude` listing `node_modules/` and `.env`, populate both, create worktree, assert both copied, sizes recorded, `clonefile` used (verify via fs stat: inode link count > 1 on APFS).

---

### 5.2 Automation — Project Commands

**Status**: Independent. Requires session store (3.2).

**Specification**: See § 3.2 SessionStore implementation above and ADR 0014.

**Additional test**:

- Create project with `.sessionStart` command `["echo", "started"]`.
- Create session in project.
- Assert automation terminal created with `role: .automation(.sessionStart)`.
- Assert terminal state transitions to `.running`, then `.exited(0)`.
- Assert terminal output contains "started".

---

### 5.3 Forge Integration — PR Status and Checks

**Status**: Independent. Requires git (1.2), session store (3.2).

**Requirements** (ADR 0012):

#### ForgeServing

```swift
public protocol ForgeServing: Sendable {
    func prStatus(for session: Session) async throws -> ForgeState?
}

public struct ForgeState: Codable, Sendable {
    public var host: Forge
    public var pullRequest: PullRequestSummary?
    public var checks: CheckRollup?
    public var refreshedAt: Date
}

public struct PullRequestSummary: Codable, Sendable {
    public var number: Int
    public var title: String
    public var state: String
    public var isDraft: Bool
    public var url: URL
}

public enum CheckRollup: String, Codable, Sendable {
    case passing, failing, running, none
}
```

**Implementation decisions**:

1. **Shell out to `gh` / `glab`**:
   - Detect forge from remote URL (github.com → GitHub, gitlab.com → GitLab).
   - Detect binary on PATH: `which gh`, `which glab`.
   - If missing or logged out: return nil (silence, not error).

2. **Read JSON with explicit field list**:
   - `gh pr view <branch> --json number,title,state,isDraft,url,statusCheckRollup`.
   - `glab mr view <branch> --output json` (parse similar fields).
   - Parse stdout as JSON; unknown fields → throw (detected API change).

3. **Cache on session**:
   - Refresh when session becomes visible, at most once per minute.
   - Store `ForgeState` in session (not persisted; ephemeral cache).

4. **Failure modes**:
   - Binary missing → nil.
   - Not logged in → nil (stderr contains "not logged in").
   - Rate limited → nil (stderr contains "rate limit").
   - Network error → nil.
   - Log failure class, never output.

**Test strategy**:

- Mock `ProcessRunning` with canned JSON responses.
- Test parse `gh pr view` output → assert correct `PullRequestSummary`.
- Test missing binary → assert nil, no error.
- Test `gh` exits 1 with "not logged in" → assert nil, log contains "auth".
- Test field rename → assert throws (unknown field).

---

### 5.4 Attention Signals — BEL, OSC 9/777, OSC 133

**Status**: Integrated into terminal emulator (3.1) and attention policy (4.1).

**Specification**: See § 3.1 TerminalEmulating and § 4.1 AttentionPolicy above, plus ADR 0006, 0011.

**Additional test**:

- Feed `\a` (BEL) to emulator, assert `eventSink.terminalDidRequestAttention` called with `.bell`.
- Feed `\x1b]9;Notification body\x07`, assert called with `.notification(title: nil, body: "Notification body")`.
- Feed `\x1b]777;notify;Title;Body\x07`, assert called with `.notification(title: "Title", body: "Body")`.
- Feed `\x1b]133;D;0\x07` after 2 s, assert no attention delivery (short command).
- Feed `\x1b]133;D;1\x07` after 15 s, assert delivery (long failed command).

---

## VI. Repaint Encoder (Deliberately Last)

### 6.1 Damage Tracking and Minimal Escape Sequence Encoding

**Status**: Most complex piece. Can use naive full repaint as placeholder initially.

**Requirements** (ADR 0015, ADR 0004):

**Goal**: Turn "these cells changed" into minimal, correct ANSI escape sequences that reproduce the changed grid.

**Implementation decisions**:

1. **Damage tracking**:
   - Emulator maintains `damageRevision: Int`, incremented on every change.
   - Maintain dirty cell bitmap or dirty line set.
   - `encodeDamageSince(revision)` returns escape sequences for cells changed since that revision.

2. **Encoding strategy** (reference: tmux source, SwiftTerm source):
   - Cursor positioning: `\x1b[<row>;<col>H` to jump, or relative moves (`\x1b[A/B/C/D`).
   - SGR codes for attributes: `\x1b[<attrs>m`.
   - Text runs: emit UTF-8 bytes directly.
   - Clear sequences: `\x1b[J` (clear to end of screen), `\x1b[K` (clear to end of line).
   - Diff algorithm: compare old grid to new grid, emit smallest sequence set.

3. **Correctness check**:
   - Feed bytes to one emulator.
   - Encode damage, feed to second emulator.
   - Assert grids identical (cell-by-cell comparison).

4. **Placeholder**:
   - Initial: full repaint every frame (`serialiseForAttach()` called every time).
   - Works correctly, slow, valid fallback.

**Test strategy** (testing.md § Repaint encoder):

- Feed known sequences to emulator A, encode damage, feed to emulator B, assert grids match.
- Feed `yes` output (flood), encode damage, assert frame rate bounded (not per-byte).
- Feed full-screen TUI redraws (vim, htop), assert correct after detach/reattach.

**Defer until**: Everything else works. This is the hardest piece, and a correct-but-dumb full repaint makes everything above it functional first.

---

## VII. Testing Strategy

### General Principles (from testing.md, conventions.md)

1. **swift-testing** (`@Test`, `#expect`), not XCTest.
2. **`swift test` runs in parallel**: Never write to fixed paths. Use `TemporaryDirectory` and `GitFixture`.
3. **Real git, real PTYs** in tests. Fakes only for network-bound or deliberate test doubles.
4. **`#expect` cannot swallow `try`**: Hoist throwing call into a `let`, then assert on value.

### Test Fixtures

```swift
public final class GitFixture {
    public let path: URL
    
    public init() throws {
        path = try TemporaryDirectory().url
        // git init, commit initial tree
    }
    
    public func addWorktree(branch: String) throws -> URL {
        let worktreePath = path.appendingPathComponent("worktrees/\(branch)")
        // git worktree add
        return worktreePath
    }
}

public final class TemporaryDirectory {
    public let url: URL
    
    public init() throws {
        url = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }
    
    deinit {
        try? FileManager.default.removeItem(at: url)
    }
}
```

### Cascade Tests (testing.md § Migrations)

Encode product rules:

```swift
@Test func deletingProjectCascadesToSessions() async throws {
    let db = try JanelaDatabase.inMemory()
    let project = try await db.write { /* insert project */ }
    let session = try await db.write { /* insert session with project.id */ }
    
    try await db.write { /* delete project */ }
    
    let sessions = try await db.read { /* fetch sessions */ }
    #expect(sessions.isEmpty)
}

@Test func deletingSessionCascadesToTerminals() async throws {
    // similar
}

@Test func deletingLaunchProfileSetsTerminalProfileIDToNil() async throws {
    // similar
}
```

### Module Test Coverage

| Module | What to Test | How |
| --- | --- | --- |
| JanelaPTY | Spawn, read, write, resize, kill, back-pressure | Real processes, real pipes |
| JanelaGit | List, add, remove worktrees; parse `-z` output | `GitFixture`, real git |
| JanelaPersistence | Round-trip, cascade, migration | In-memory DB, `#expect` equality |
| JanelaCore | Layout algebra: split, close, focus, validate | Pure unit tests, milliseconds |
| JanelaTerminal | Feed, resize, damage, snapshot | Real `SwiftTerm.Terminal` (headless) |
| JanelaSession | Create session, automation, .worktreeinclude | Fake `WorktreeServing`, in-memory DB |
| JanelaProtocol | Framing, handshake, message encode/decode | Real socket in `TemporaryDirectory` |
| JanelaDaemon | Connection, auth, subscription, lifecycle | Real socket, real messages |
| JanelaClient | Reconnection, mirror updates, attention policy | Fake connection, fake deliverer |
| JanelaUI | Sidebar, tabs, splits, keyboard shortcuts | Manual, SwiftUI previews, UI tests (optional) |

---

## VIII. Out of Scope for V1

Per product.md § Non-goals and individual ADR decisions:

- **Remote client** (phone, web): Protocol ready, listener deferred.
- **Cloud sessions / sync**: Local Mac only.
- **Per-session settings**: Settings are global or per-project.
- **Saved/named layouts**: Layout is wherever you left it, stored on session.
- **Nested projects / folders / tags**: Two levels, flat within each.
- **Agent-specific integrations**: Terminal signals only, never infer semantics.
- **Forge write actions** (merge, approve, comment): Open browser.
- **Sessions survive reboot**: Survive app quit, not reboot.
- **`janela notify` CLI**: Documented as v2 of ADR 0006.
- **Per-pattern symlink in `.worktreeinclude`**: Deferred, additive.

---

## IX. Performance Budgets

From performance.md:

| Path | Budget | Why |
| --- | --- | --- |
| Launch (cold, no sessions) | 250 ms | First impression; every ms counts |
| Launch (warm, 10 sessions) | 500 ms | Real working state; database read is on path |
| Create session (simple) | < 100 ms | Feels instant |
| Create worktree-backed session | 1–3 s | git + .worktreeinclude copy; user expects wait |
| Terminal input → echo visible | < 16 ms | Perception threshold for interactive |
| Flood handling | Frame rate bounded | 100 MB/s `yes` must not allocate unbounded memory |
| Resize (with reflow) | < 100 ms | Dragging a split; must feel responsive |
| Reconnect after daemon restart | < 2 s | Back-off is acceptable here |

**Rules of thumb**:

- PTY read → emulator feed: no allocations per chunk.
- Damage encode: amortised O(changed cells), not O(grid).
- Database writes: batch when possible; never block UI.
- Forge refresh: async, never on critical path.

---

## X. Developer Workflow and Validation

### Daily Loop

```bash
make build    # seconds; SPM only
make test     # seconds; all module tests
make lint     # before committing
make check    # lint + test; exactly what CI runs
```

### Before Finishing

Per AGENTS.md § Before you finish:

- [ ] `make check` passes.
- [ ] No dependency edge points upward or crosses daemon/client line except via JanelaCore/JanelaProtocol.
- [ ] No wire protocol change without version bump.
- [ ] No new user-facing concept without justification against product.md § Non-goals (budget is four nouns).
- [ ] No use of word "workspace" (replaced with project or session).
- [ ] No architectural decision change without ADR.
- [ ] No per-byte or per-frame allocation on terminal path without budget in performance.md.

---

## XI. Current State and Immediate Next Steps

Per development.md § Current state:

- Scaffolded, not implemented. Builds, launches, passes tests, but behavior is `TODO`.
- Search `grep -rn "TODO:" Packages/` for work queue.

**Immediate priorities** (dependency-ordered):

1. **JanelaPTY** (§ 1.1): `openpty → fork → login_tty → execve`, `TerminalByteStream` over DispatchIO.
2. **JanelaGit** (§ 1.2): `GitRunner` + `WorktreeService`, parse `--porcelain -z`.
3. **JanelaPersistence** (§ 1.3): GRDB records, round-trip tests, cascade tests.
4. **JanelaCore layout** (§ 2.1): `SessionLayout` algebra, depth bound, fraction clamp.
5. **JanelaTerminal** (§ 3.1): `TerminalEmulating` over SwiftTerm, `LiveTerminal` actor.
6. **JanelaSession** (§ 3.2): `ProjectStore`, `SessionStore`, .worktreeinclude, automation.
7. **JanelaProtocol + JanelaDaemon** (§ 3.3): Framing, handshake, socket listener, launchd.
8. **JanelaClient** (§ 4.1): Connection, reconnect, mirror stores, attention policy.
9. **JanelaUI** (§ 4.4): Sidebar, tabs, splits, keyboard shortcuts.
10. **Repaint encoder** (§ 6.1): Damage tracking, minimal escape sequences (LAST; placeholder works).

---

## XII. Sign-Off Checklist

Before any component is marked "done":

- [ ] Implementation matches this spec.
- [ ] Tests written and passing.
- [ ] `make lint` passes (no force unwraps, no `try!`, no `print()`).
- [ ] Doc comments explain why, not just what.
- [ ] No `@preconcurrency` without a comment explaining the plan to remove it.
- [ ] If module crosses daemon/client line: rejected by reviewer (layering bug).
- [ ] If adds dependency edge: points downward per architecture.md.
- [ ] If changes protocol: version bumped, old peer story documented.
- [ ] If unbounded allocation: justified in performance.md.

---

## Appendix A: Key Non-Negotiables (from AGENTS.md)

1. Worktree-aware, not worktree-centric.
2. Two levels, no more.
3. Never reimplement user's tools.
4. Terminal owns keyboard.
5. Laziness is a feature.
6. Daemon is source of truth; clients render mirror.
7. Never kill terminals to make our lives easier.
8. Nothing blocks across socket.
9. No unbounded buffers.
10. Errors shown or logged, never both raw.
11. Never log terminal traffic.
12. Automation is visible.

---

## Appendix B: Vocabulary (from domain-model.md)

| Say | Not |
| --- | --- |
| project | repository, workspace, group, folder |
| session | workspace, worktree, tab, window |
| terminal | pane, shell, tab, session |
| tab | window, view |
| split | pane, division |
| launch profile | agent, command, tool, preset |
| directory | folder, path, cwd |
| automation command | hook, script, task, job |
| daemon, `janelad` | server, backend, service, agent |
| client | frontend, UI (when you mean the process) |
| attach / detach | connect, open, subscribe (when you mean one terminal) |
| connect / disconnect | attach (when you mean the socket) |

---

**End of specification. Every requirement traceable to an ADR or development.md decision.**
