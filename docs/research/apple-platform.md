# Apple Platform Technology Choices for Janela (macOS 26 / Swift 6)

Primary-source research brief. Every non-obvious claim below is traced to Apple developer documentation,
swift.org / swift-evolution proposals, or the upstream repository of the tool in question.

Method note: `developer.apple.com/documentation/*` pages are JavaScript-rendered. All Apple API facts below
were read from the DocC JSON backing those pages, at
`https://developer.apple.com/tutorials/data/documentation/<path>.json`. Where a platform availability number
is quoted, it comes from the `metadata.platforms[].introducedAt` field of that JSON. The human-readable page
URL is cited for convenience.

Toolchain assumed: Xcode 26.6, Swift 6.3.3, macOS 26 SDK, arm64.

---

## 1. SwiftUI vs AppKit on macOS 26

### 1.1 What SwiftUI genuinely covers today

| Capability | API | macOS availability (from DocC JSON) | Source |
| --- | --- | --- | --- |
| Two/three-column layout | `NavigationSplitView` | macOS 13.0 | [docs](https://developer.apple.com/documentation/swiftui/navigationsplitview) |
| Column-based data grid with sorting/selection | `Table` | **macOS 12.0** (iOS 16.0) | [docs](https://developer.apple.com/documentation/swiftui/table) |
| Preferences window managed by the system | `Settings` scene | macOS 11.0 | [docs](https://developer.apple.com/documentation/swiftui/settings) |
| Status-bar item | `MenuBarExtra` | macOS 13.0 | [docs](https://developer.apple.com/documentation/swiftui/menubarextra) |
| Window styling | `Scene.windowStyle(_:)`, `WindowStyle.plain` | `plain` is macOS 15.0 | [docs](https://developer.apple.com/documentation/swiftui/windowstyle/plain) |
| Utility/panel windows | `UtilityWindow` scene + `WindowVisibilityToggle` | **macOS 15.0** | [docs](https://developer.apple.com/documentation/swiftui/utilitywindow) |
| Scene launch policy (suppress default window at launch) | `Scene.defaultLaunchBehavior(_:)` / `SceneLaunchBehavior` | **macOS 15.0** | [docs](https://developer.apple.com/documentation/swiftui/scene/defaultlaunchbehavior(_:)) |
| Window resize anchoring | `View.windowResizeAnchor(_:)` | macOS 26 (listed under "June 2025" in SwiftUI updates) | [SwiftUI updates](https://developer.apple.com/documentation/updates/swiftui) |
| Extra window drag regions | `WindowDragGesture` | macOS 26 ("June 2025") | [SwiftUI updates](https://developer.apple.com/documentation/updates/swiftui) |
| Focus | `@FocusState`, `FocusedValue`, `focusedSceneValue` | macOS 12.0 (`FocusState`) | [docs](https://developer.apple.com/documentation/swiftui/focusstate) |
| Keyboard shortcuts | `View.keyboardShortcut(_:modifiers:)`, `Commands`/`CommandMenu` | macOS 11.0 | [docs](https://developer.apple.com/documentation/swiftui/view/keyboardshortcut(_:modifiers:)) |
| Drag & drop (typed, Transferable) | `View.draggable(_:)` / `.dropDestination(for:action:)` | macOS 13.0 | [docs](https://developer.apple.com/documentation/swiftui/view/draggable(_:)) |
| **User-customizable toolbar** | `View.toolbar(id:content:)` + `ToolbarItem(id:placement:)` + `ToolbarCommands()` | macOS 11.0 | [docs](https://developer.apple.com/documentation/swiftui/view/toolbar(id:content:)) |

Two corrections to widely-repeated folklore, verified against the DocC JSON:

1. **Toolbar customization does not require `NSToolbar` any more.** `View.toolbar(id:content:)` is documented as
   "Populates the toolbar or navigation bar with the specified items, allowing for user customization," and the
   discussion explicitly states: *"In macOS you can enable menu support for toolbar customization by adding a
   `ToolbarCommands` instance to a scene using the `commands(content:)` modifier… the system adds a menu item to
   your app's main menu to provide toolbar customization support. This is in addition to the ability to
   Control-click on the toolbar to open the toolbar customization editor."*
   ([toolbar(id:content:)](https://developer.apple.com/documentation/swiftui/view/toolbar(id:content:))). Related
   types: `ToolbarCustomizationBehavior`, `ToolbarCustomizationOptions`, `View.toolbarItemHidden(_:)`.
2. **`UtilityWindow` and `defaultLaunchBehavior` are macOS 15, not macOS 26.** The SwiftUI "updates" page lists them
   under the June-2025 heading, but the symbol JSON reports `introducedAt: "15.0"` for macOS. Do not raise the
   deployment target for those.

### 1.2 macOS 26-era SwiftUI/AppKit bridging additions

From [SwiftUI updates, "June 2025" → "UIKit and AppKit integration"](https://developer.apple.com/documentation/updates/swiftui):

- `NSHostingSceneRepresentation` — "An AppKit type that hosts and can present SwiftUI scenes." This is the
  inverse of the usual direction: an AppKit-driven app can now own `NSApplication` and still present SwiftUI
  `Scene`s. ([docs](https://developer.apple.com/documentation/swiftui/nshostingscenerepresentation))
- `NSGestureRecognizerRepresentable` — wrap `NSGestureRecognizer` into SwiftUI gesture handling.
  ([docs](https://developer.apple.com/documentation/swiftui/nsgesturerecognizerrepresentable))
- `NSHostingMenu` — "An AppKit menu with menu items that are defined by a SwiftUI View," so menu content can be
  written once in SwiftUI and installed into an AppKit menu tree.
  ([docs](https://developer.apple.com/documentation/swiftui/nshostingmenu))
- `View.allowsWindowActivationEvents(_:)` — controls whether a gesture consumes the click that activates the
  window (relevant for a terminal grid where the first click should place the cursor, not be swallowed).

Also in the same release: `ContainerBackgroundPlacement.window`, `View.toolbar(removing:)`, `ToolbarSpacer`,
`View.glassEffect(_:in:)`, `View.scrollEdgeEffectStyle(_:for:)` (Liquid Glass), and `TextEditor` gaining
`AttributedString` support.

### 1.3 What still needs AppKit

- **The terminal view itself.** There is no SwiftUI primitive for a cell-grid text renderer with per-cell
  attributes, custom cursor, selection, IME, and scrollback. The supported bridge is `NSViewRepresentable`
  ([docs](https://developer.apple.com/documentation/swiftui/nsviewrepresentable)); its protocol requirements
  (`makeNSView(context:)`, `updateNSView(_:context:)`, `Coordinator`) put the AppKit object under SwiftUI's
  lifecycle. Practically: subclass `NSView`, override `draw(_:)` or drive a `CALayer`/`CAMetalLayer`, and
  implement `NSTextInputClient` for IME.
- **`NSWindow` control.** SwiftUI exposes no binding for `NSWindow.tabbingMode` /
  `NSWindow.tabbingIdentifier` / `addTabbedWindow(_:ordered:)`; these are AppKit-only
  ([NSWindow.tabbingMode](https://developer.apple.com/documentation/appkit/nswindow/tabbingmode-swift.property)).
  If Janela wants native window tabs (rather than in-app tabs it draws itself), it must reach the `NSWindow`.
- **`NSToolbar` beyond the SwiftUI surface** — e.g. `NSToolbarItemGroup` with custom validation, search-field
  toolbar items with non-standard behaviour, or delegate-driven dynamic item sets, still require
  `NSToolbar`/`NSToolbarDelegate` ([docs](https://developer.apple.com/documentation/appkit/nstoolbar)).
- **Services menu / Services provider.** Registration is `NSApplication.servicesProvider` plus an `NSServices`
  array in `Info.plist`; there is no SwiftUI equivalent.
- **`NSApplicationDelegate` responsibilities** — `applicationShouldTerminate`, dock menu, `NSAppleEventManager`
  URL handling — are reached from SwiftUI via `@NSApplicationDelegateAdaptor`.

### 1.4 Recommended shape

SwiftUI `App` + `Scene` for the shell (window management, split view, settings, commands, menu bar), with the
terminal surface as a single `NSViewRepresentable`. Escape hatch to `NSWindow` via
`@NSApplicationDelegateAdaptor` or by walking `NSApp.windows` keyed on the SwiftUI scene id. `NSHostingMenu`
(macOS 26) means the menu definitions can stay in SwiftUI even where AppKit owns the menu.

---

## 2. Swift 6 strict concurrency

### 2.1 The proposals that matter, with verified numbers and statuses

Statuses read from the `Status:` line of each proposal on `main` in `swiftlang/swift-evolution`:

| Proposal | Title | Status | Feature flag |
| --- | --- | --- | --- |
| [SE-0337](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0337-support-incremental-migration-to-concurrency-checking.md) | Incremental migration to concurrency checking | Implemented (Swift 5.6) | `-strict-concurrency=` |
| [SE-0414](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0414-region-based-isolation.md) | Region based Isolation | **Implemented (Swift 6.0)** | `RegionBasedIsolation` |
| [SE-0420](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0420-inheritance-of-actor-isolation.md) | Inheritance of actor isolation (`isolated (any Actor)?`) | **Implemented (Swift 6.0)** | — |
| [SE-0430](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0430-transferring-parameters-and-results.md) | `sending` parameter and result values | **Implemented (Swift 6.0)** | — |
| [SE-0431](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0431-isolated-any-functions.md) | `@isolated(any)` function types | **Implemented (Swift 6.0)** | — |
| [SE-0434](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0434-global-actor-isolated-types-usability.md) | Usability of global-actor-isolated types | Implemented (Swift 6.0) | `GlobalActorIsolatedTypesUsability` |
| [SE-0461](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0461-async-function-isolation.md) | Run nonisolated async functions on the caller's actor by default | **Implemented (Swift 6.2)** | `NonisolatedNonsendingByDefault` |
| [SE-0466](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0466-control-default-actor-isolation.md) | Control default actor isolation inference | **Implemented (Swift 6.2)** | — (`-default-isolation MainActor`) |
| [SE-0470](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0470-isolated-conformances.md) | **Global-actor isolated conformances** | **Implemented (Swift 6.2)** | `InferIsolatedConformances` |

Note the exact titles: SE-0430's landed title is *"`sending` parameter and result values"* (the `transferring`
spelling was dropped during review — the file name still says `transferring`), and SE-0470 is *"Global-actor
isolated conformances"*, not "isolated conformances" generally.

Two facts worth internalising:

- **SE-0466 is opt-in and does not change defaults.** The proposal is implemented in Swift 6.2 but ships as a
  compiler mode (`-default-isolation MainActor` / `defaultIsolation:` in a SwiftPM manifest), not an upcoming
  feature. Default isolation remains `nonisolated` unless you turn it on.
- **SE-0461 changes runtime behaviour, and Apple knows it's a hazard.** From the proposal's Source-compatibility
  section: *"the change can also regress performance of existing code if, for example, a specific async function
  relied on running off of the main actor when called from the main actor to maintain a responsive UI."* With
  `NonisolatedNonsendingByDefault` on, a `nonisolated func f() async` called from `@MainActor` **runs on the main
  actor**. To keep an async function off the main actor you must annotate it `@concurrent`.

### 2.2 Region-based isolation, in one paragraph

SE-0414's model: the compiler partitions values into *isolation regions*. Two values are in the same region if
using one can affect the other. A non-`Sendable` value may be passed across an isolation boundary if the compiler
can prove its whole region is *disconnected* — i.e. the sending context provably has no remaining references.
SE-0430 gives this an explicit spelling: a `sending` parameter/result is one whose region is transferred to the
callee. This is what makes the PTY→renderer hand-off expressible without `@unchecked Sendable`.

### 2.3 Practical guidance: PTY read loop → `@MainActor` renderer

This is the single most performance-sensitive isolation decision in Janela. The shape that satisfies Swift 6
strict concurrency *and* avoids per-byte actor hops:

1. **Do not make the byte source an `actor`.** A PTY `read(2)` loop should live on a dedicated thread or a
   `DispatchSourceRead`/`DispatchIO` on a private serial queue. Actors are cooperative-pool tasks; a blocking
   `read()` inside an actor method occupies a cooperative thread. Use a `nonisolated` type that owns the fd and
   a `DispatchIO` channel, and publish results via an `AsyncStream`.
2. **Batch.** Never send one byte, or even one `read()` result, per hop. Coalesce reads into buffers and hand
   over at most one chunk per display refresh. This is the difference between ~120k main-actor hops/sec and 120.
3. **Make the chunk type `Sendable` by construction.** Two viable designs:
   - A `struct Chunk: Sendable { let bytes: [UInt8] }` — `Array<UInt8>` is `Sendable`; copying the bytes once per
     chunk is cheap relative to a hop.
   - Or a class-based ring-buffer slice passed with `sending` (SE-0430), so the reader provably gives up its
     reference. Prefer this only if profiling shows the copy matters.
4. **Parse off the main actor.** The VT/ANSI state machine should live in the reader's isolation domain (or in a
   dedicated parser actor), producing *screen deltas* — not raw bytes — for the main actor. The main actor's job
   is to apply a diff and invalidate rects.
5. **Own the grid model outside `@MainActor` if you can.** A terminal grid mutated by the parser and read by the
   renderer is the classic case for `@MainActor` on the *view-facing snapshot* only. Publish immutable
   snapshots (`Sendable` value types) into the main actor; keep the mutable grid in the parser's domain.
6. **Use `nonisolated(nonsending)` deliberately.** Under SE-0461 semantics, mark hot parsing helpers `@concurrent`
   if they must not be pulled onto the main actor by an inheriting caller.
7. **`@isolated(any)` (SE-0431)** is the right tool for a callback stored by the reader that must run on whatever
   actor registered it, without the reader knowing which actor that is.
8. Follow the swift.org migration guide's incremental path: enable
   [`IncrementalAdoption`](https://www.swift.org/migration/documentation/swift-6-concurrency-migration-guide/incrementaladoption)
   module by module rather than flipping the whole package to Swift 6 language mode at once
   ([Guide.docc/IncrementalAdoption.md](https://github.com/swiftlang/swift-migration-guide/blob/main/Guide.docc/IncrementalAdoption.md),
   [DataRaceSafety.md](https://github.com/swiftlang/swift-migration-guide/blob/main/Guide.docc/DataRaceSafety.md)).

**Anti-pattern to avoid:** `@MainActor` on the whole app via `-default-isolation MainActor` (SE-0466). It is
attractive for a UI app and terrible for a terminal — it silently drags the parser onto the main actor.
Janela should keep default isolation `nonisolated` and annotate the UI layer explicitly.

---

## 3. Persistence for a small local metadata store

Janela's store is: workspaces, sessions, worktree associations, agent transcripts index, window layout. Small,
local, single-process, needs fast cold start.

### 3.1 SwiftData

- SwiftData "combin[es] Core Data's proven persistence technology and Swift's modern concurrency features"
  ([SwiftData](https://developer.apple.com/documentation/swiftdata)).
- **Concurrency model:** background work is done through `ModelActor`, "An interface for providing
  mutually-exclusive access to the attributes of a conforming model," which refines `Actor` and vends
  `modelContainer`, `modelContext`, `modelExecutor`, and a `nonisolated var unownedExecutor`
  ([ModelActor](https://developer.apple.com/documentation/swiftdata/modelactor),
  [unownedExecutor](https://developer.apple.com/documentation/swiftdata/modelactor/unownedexecutor)). The
  `@ModelActor` macro generates that boilerplate
  ([ModelActor()](https://developer.apple.com/documentation/swiftdata/modelactor())).
- **Constraint that bites:** `PersistentModel` instances and `ModelContext` are not `Sendable`; a model fetched
  on one `ModelActor` cannot be handed to `@MainActor`. You pass `PersistentIdentifier` across and re-fetch. This
  is inherent to the `ModelActor` design (the actor's executor *is* the context's serialization point).
- **Practical downside for Janela:** SwiftData is a macro-generated layer over Core Data; schema migrations are
  declared via `VersionedSchema`/`SchemaMigrationPlan`, debugging goes through the Core Data stack, and you get
  no SQL. It also pulls in the Core Data runtime at launch.

### 3.2 Core Data

Same runtime, older API, `NSManagedObject` subclasses, `NSPersistentContainer`. No advantage over SwiftData for a
brand-new Swift 6 codebase except mature migration tooling and predictable behaviour.

### 3.3 GRDB

From the upstream DocC ([GRDB/Documentation.docc/Concurrency.md](https://github.com/groue/GRDB.swift/blob/master/GRDB/Documentation.docc/Concurrency.md),
[DatabaseConnections.md](https://github.com/groue/GRDB.swift/blob/master/GRDB/Documentation.docc/DatabaseConnections.md)):

- Two connection types. `DatabaseQueue` "opens a single database connection, and serializes all database accesses,
  reads, and writes. There is never more than one thread that uses the database." `DatabasePool` "manages a pool of
  several database connections, and allows concurrent reads and writes thanks to the WAL mode."
- **Rule 1 (upstream's wording): "Connect to any database file only once."** One `DatabaseQueue`/`DatabasePool` per
  file for the whole lifetime of use.
- Guarantees on the safe `read`/`write` methods: *Serialized Writes* ("All writes performed by one `DatabaseQueue`
  or `DatabasePool` instance are serialized… prevents `SQLITE_BUSY` errors during concurrent writes"),
  *Write Transactions* (all writes wrapped in a transaction), *Isolated Reads* (all reads wrapped in a
  transaction; "An isolated read sees a stable and immutable state").
- Testability note straight from the docs: "The demo applications share the same database code for the on-disk
  pool that feeds the app, and the in-memory queue that feeds tests and SwiftUI previews. This makes sure tests
  and previews run fast, without any temporary file, with the same behavior as the app." That property —
  in-memory `DatabaseQueue` for previews and tests, on-disk `DatabasePool` for the app — is directly valuable to
  Janela's preview and CI story.
- Cross-process caveat, also from the docs: "Writes performed by other processes can trigger an `SQLITE_BUSY`
  `DatabaseError` that you can handle." Relevant if a CLI companion binary ever touches the same file.

### 3.4 Verdict

GRDB. Reasons: (a) plain SQLite file that a coding agent or the developer can inspect with `sqlite3` and that a
sidecar CLI can read; (b) no Core Data runtime on the launch path; (c) migrations are ordinary SQL under
`DatabaseMigrator`; (d) the in-memory-queue-for-previews/tests pattern is documented and first-class; (e) the
concurrency guarantees are stated precisely and map onto Swift 6 without `PersistentIdentifier` round-trips.
SwiftData's `ModelActor` model is fine, but the "models aren't `Sendable`, re-fetch by ID" tax plus opaque
migrations is a poor fit for a tool whose own users are developers.

---

## 4. Project generation & build

### 4.1 The `project.pbxproj` problem, stated by primary sources

- Apple's own fix: **buildable folders (synchronized root groups)**, introduced in Xcode 16. From the
  [Xcode 16 release notes](https://developer.apple.com/documentation/xcode-release-notes/xcode-16-release-notes):
  *"Minimize project file changes, and avoid version control conflicts with buildable folder references… Buildable
  folders only record the folder path into the project file without enumerating the contained files. This minimizes
  diffs to the project when files are added and removed, and avoids source control conflicts with your team."*
  Convert with the "Convert to Folder" context menu in the Project Navigator.
- Tuist's own analysis of why conflicts happen: `PBXFileReference`/group entries "update whenever a file is added,
  removed, or relocated in the project hierarchy—common actions in a pull request… This frequent updating is a
  primary driver of merge conflicts"
  ([tuist.dev blog](https://tuist.dev/blog/2025/03/21/git-conflicts)). The same post credits Xcode 16 synchronized
  groups as "a low-effort, high-return investment."
- The pbxproj representation of a buildable folder is `PBXFileSystemSynchronizedRootGroup`, with
  `PBXFileSystemSynchronizedBuildFileExceptionSet` for per-file exceptions
  ([Tuist ProjectDescription: BuildableFolder](https://projectdescription.tuist.dev/documentation/projectdescription/buildablefolder/)).

**This is the key finding for an agent-edited repo:** with buildable folders, adding a Swift file requires *zero*
change to `project.pbxproj`. The historical reason to adopt XcodeGen or Tuist largely evaporates for a
single-app, few-target project.

### 4.2 The alternatives, from their own docs

- **XcodeGen** — YAML `project.yml`, globs like `Sources/**/*.swift`
  ([ProjectSpec.md](https://github.com/yonaskolb/XcodeGen/blob/master/Docs/ProjectSpec.md)). Generated
  `.xcodeproj` is gitignored. Cost: a second source of truth, and Xcode UI edits are lost on regeneration.
- **Tuist** — Swift DSL (`Project.swift`, `Workspace.swift`, `Tuist.swift`) with `tuist generate|build|test`
  ([Projects guide](https://tuist.dev/en/docs/guides/features/projects),
  [ProjectDescription](https://projectdescription.tuist.dev/documentation/projectdescription/)). Tuist's own
  positioning page is explicit that it targets *modularization at scale*, not merely conflict avoidance:
  "If conflicts are your only gripe, project generation might be overkill."
- **SwiftPM-only** — no `.xcodeproj` at all; Xcode opens `Package.swift` directly. Tuist's own write-up flags the
  cost honestly: "Xcode can become sluggish, with tiny graph changes triggering slow, asynchronous processes—or
  worse, leaving your project in an inconsistent state requiring a clean of derived data." Additional hard limit:
  a SwiftPM package cannot produce a signed, notarizable `.app` bundle with an `Info.plist`, entitlements, and
  embedded frameworks — you need an Xcode app target (or a hand-rolled bundler) for that.

### 4.3 CLI build & test

```sh
# App target (Xcode project/workspace)
xcodebuild -project Janela.xcodeproj -scheme Janela -destination 'platform=macOS,arch=arm64' build
xcodebuild -project Janela.xcodeproj -scheme Janela -destination 'platform=macOS,arch=arm64' test
xcodebuild -project Janela.xcodeproj -scheme Janela -configuration Release archive -archivePath build/Janela.xcarchive
xcodebuild -exportArchive -archivePath build/Janela.xcarchive -exportOptionsPlist ExportOptions.plist -exportPath build/export
```

```sh
# Pure-Swift core packages, no Xcode needed
swift build -c release
swift test
swift test --filter TerminalParserTests    # arguments are passed through to Swift Testing
```

`swift test --filter` and friends are documented in
[swiftpm docs: `swift test`](https://docs.swift.org/swiftpm/documentation/packagemanagerdocs/swifttest/); the
pass-through behaviour to Swift Testing is stated in
[swift-testing Documentation/CommandlineDebugging.md](https://github.com/swiftlang/swift-testing/blob/main/Documentation/CommandlineDebugging.md):
*"Arguments such as `--filter` are passed through to Swift Testing directly."*

### 4.4 Making SwiftUI previews work

Previews need an Xcode target with a build destination and, for anything touching the app's environment, an app
target. Concretely for Janela:

- Keep pure logic (VT parser, session model, GRDB store) in local SwiftPM packages under `Packages/`. Previews
  work in package targets, but only when the package is opened *inside* an Xcode project/workspace that has a
  concrete platform destination.
- Views that need real data should use an **in-memory `DatabaseQueue`** seeded by a fixture — the pattern GRDB
  documents for "tests and SwiftUI previews."
- Use `@Previewable` (SwiftUI, macOS 15+) for stateful previews without a wrapper view
  ([Previewable()](https://developer.apple.com/documentation/swiftui/previewable())).
- Previews of the terminal `NSViewRepresentable` will exercise the real AppKit view; feed it a canned byte
  stream rather than spawning a PTY, so previews never fork a process.

### 4.5 Verdict

**Xcode project, checked in, with buildable folders for every source directory, plus local SwiftPM packages for
the non-UI core.** Rationale: Apple's own Xcode 16+ mechanism removes the pbxproj churn that motivated
XcodeGen/Tuist; keeping a real `.xcodeproj` preserves previews, Instruments, signing, entitlements, and archive
export with zero indirection; and the SwiftPM packages give agents a fast `swift test` loop that never touches
Xcode. Revisit Tuist only if the target count exceeds ~10.

---

## 5. Distribution

### 5.1 Hardened runtime + notarization

- Notarization is not optional for Developer-ID distribution tooling: from
  [Hardened Runtime](https://developer.apple.com/documentation/security/hardened-runtime) — *"To upload a macOS
  app to be notarized, you must enable the Hardened Runtime capability."*
- The hardened runtime "doesn't affect the operation of most apps, but it does disallow certain less common
  capabilities, like just-in-time (JIT) compilation," and Apple's guidance is to *"use only the entitlements that
  are absolutely necessary."* Runtime exceptions enumerated on that page:
  `com.apple.security.cs.allow-jit`, `com.apple.security.cs.allow-unsigned-executable-memory`,
  `com.apple.security.cs.allow-dyld-environment-variables`, `com.apple.security.cs.disable-library-validation`,
  `com.apple.security.cs.disable-executable-page-protection`, `com.apple.security.cs.debugger`.
- Submission flow ([Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)):

  ```sh
  xcrun notarytool submit Janela-1.0.0.zip --keychain-profile "notarytool-password" --wait
  xcrun stapler staple Janela.app
  ```

  Apple notes `notarytool` requires Xcode 13 or later and that you should `xcode-select` an appropriate version
  when multiple are installed. Failure triage: [Resolving common notarization issues](https://developer.apple.com/documentation/security/resolving-common-notarization-issues).

### 5.2 The App Sandbox is incompatible with Janela's core function

Janela must spawn arbitrary user-chosen binaries (`claude`, `codex`, `opencode`, `zsh`, whatever is on `PATH`)
with arbitrary working directories. The App Sandbox forbids this:

- Apple's supported pattern for a sandboxed app running a child process is **embedding** the tool in the bundle and
  signing it with exactly two entitlements. From
  [Embedding a command-line tool in a sandboxed app](https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app):
  *"The tool's entitlements include just `com.apple.security.app-sandbox` and `com.apple.security.inherit`."*
  And, as an Important aside: *"Adding other entitlements to the tool can cause problems. If the tool immediately
  crashes with a code signing error when your app runs the tool, check that the tool is signed with just these two
  entitlements."*
- `com.apple.security.inherit` means the child inherits the *parent's* sandbox — so the child cannot read files
  outside the container either. Verification command from the same article:
  `codesign -d -vvv --entitlements :- AppWithTool.app/Contents/MacOS/ToolX`.
- The implication is direct: a sandboxed Janela could only run binaries it ships, and those binaries would be
  confined to Janela's container. That is not a coding-agent host. **Ship unsandboxed, Developer ID + hardened
  runtime + notarized.**
- Consequence: **App Store distribution is off the table** (the App Store requires `com.apple.security.app-sandbox`).
  Plan for direct download from day one.
- Entitlements Janela should almost certainly *not* request: `allow-unsigned-executable-memory`,
  `disable-executable-page-protection` (both broadly weaken code-signing protections),
  `com.apple.security.cs.debugger` ("indicates whether the app is a debugger and may attach to other processes or
  get task ports" — invites extra notarization scrutiny and isn't needed for PTY spawning). `allow-jit` is only
  needed if you embed a JIT (you don't). `disable-library-validation` is only needed if you `dlopen` third-party
  unsigned plugins — defer until a plugin system exists.

### 5.3 Sparkle vs plain download

From [Sparkle's documentation](https://sparkle-project.org/documentation/):

- Integration is SwiftPM: add `https://github.com/sparkle-project/Sparkle` as a package dependency.
- Security model: sign the update archive with **EdDSA (ed25519)** via `./bin/generate_keys`, which stores the
  private key in the login Keychain and prints the public key for `Info.plist`. Sparkle explicitly advises
  "not having your signing keys accessible from the machine that is hosting your product."
- Optional `SURequireSignedFeed` signs the appcast and release notes, so "an attacker [who compromises the
  server]" cannot forge feed metadata. Signed feeds are validated as of Sparkle 2.9.
- **Key rotation is possible only if you also Developer-ID-sign the app:** "if you both code-sign your application
  with Apple's Developer ID program and include a public EdDSA key… Sparkle allows rotating keys by issuing a new
  update that changes either your Apple code signing certificate or your EdDSA keys (but not both)." This is a
  strong argument for Developer ID + Sparkle together, not Sparkle alone.
- Distribution mechanics: `generate_appcast /path/to/updates_folder/` produces the appcast plus `.delta` files
  for incremental updates; `CFBundleVersion` must be monotonically increasing and correctly formatted. Supported
  archive formats: dmg, zip, tarball, Apple Archive (`.aar`, Sparkle 2.7+), and installer packages.
- Recommended build path: "Product › Archive and Distribute App choosing Developer ID method of distribution…
  In automated environments, this process can be done using `xcodebuild archive` and `xcodebuild -exportArchive`."
  Xcode's archive/export re-signs Sparkle's XPC services and helpers, preserves hardened runtime, and strips
  `com.apple.security.get-task-allow`.
- **Since Janela is unsandboxed**, skip the entire [sandboxing guide](https://sparkle-project.org/documentation/sandboxing/)
  and strip the bundled XPC services (Sparkle documents a build-phase script for this, followed by a re-`codesign`).
  Fewer binaries to notarize, smaller app.

---

## 6. Testing

### 6.1 swift-testing vs XCTest

From [swiftlang/swift-testing README](https://github.com/swiftlang/swift-testing/blob/main/README.md):

- "Swift Testing is included with the Swift 6 toolchain and Xcode 16. You do not need to add it as a package
  dependency to your Swift package or Xcode project." Just `import Testing`.
- "**Works with XCTest** — If you already have tests written using XCTest, you can run them side-by-side with newer
  tests written using Swift Testing." Migration can be incremental.
- Apple platforms are listed as **Supported** with **Automated** qualification (CI verifies build + all tests).
  Linux, FreeBSD, and Windows are also Supported.
- Feature set relevant to Janela: `#expect`/`#require` with expression capture, `@Test(arguments:)`
  parameterisation (parameterised cases run in parallel by default), traits including `.enabled(if:)` and
  execution time limits, and tags for cross-cutting selection.

**XCTest is still required for UI testing.** `XCUIApplication`/`XCUIElement` have no Swift Testing equivalent, and
`XCTestCase.measure` / `XCTMetric` performance tests are XCTest-only. So: Swift Testing for unit and integration
tests, XCTest for the small UI-automation and performance-baseline suites.

### 6.2 CI on GitHub Actions macOS runners

Read directly from the runner-image manifests in `actions/runner-images` (`main` branch,
image version 20260728.0273.1 at time of research):

- [`images/macos/macos-26-arm64-Readme.md`](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md):
  OS macOS 26.5.2 (25F84), Darwin 25.5.0. **Xcode 26.6 (17F113) is the default** (`/Applications/Xcode.app`), with
  26.5, 26.4.1, 26.3, 26.2, 26.1.1, 26.0.1 also installed. Xcode Command Line Tools 26.6. SDKs macOS 26.0–26.5+.
  This runner matches Janela's declared toolchain exactly.
- [`images/macos/macos-15-arm64-Readme.md`](https://github.com/actions/runner-images/blob/main/images/macos/macos-15-arm64-Readme.md):
  macOS 15.7.7, **default Xcode 16.4** with 26.0.1–26.3 available but not default. Do not use for Janela unless you
  pin `xcode-select`.
- Announcement banner in those same READMEs: *"Default Xcode on macOS 26 Tahoe will be set to Xcode 26.6 on
  2026.07.21"* and *"Xcode 27 is now available as a public preview."*

Headless run recipe:

```yaml
runs-on: macos-26-arm64
steps:
  - uses: actions/checkout@v4
  - run: sudo xcode-select -s /Applications/Xcode_26.6.app   # pin explicitly; don't trust the default
  - run: swift test --parallel                                # core packages, no simulator/UI needed
  - run: |
      xcodebuild test \
        -project Janela.xcodeproj -scheme Janela \
        -destination 'platform=macOS,arch=arm64' \
        -resultBundlePath TestResults.xcresult \
        CODE_SIGNING_ALLOWED=NO | xcbeautify
```

Notes: `xcbeautify` 3.2.1 is preinstalled on both images. macOS UI tests on a headless runner do work (the runner
has a real window server), but they are the flakiest part of an Apple CI matrix — keep the UI suite to smoke tests.
`CODE_SIGNING_ALLOWED=NO` avoids needing a signing identity for the test build; the release/notarize job needs a
real Developer ID certificate imported into a temporary keychain.

---

## 7. Performance tooling

- **os_signpost / `OSSignposter`.** Structured intervals in the unified log, readable by Instruments' "Points of
  Interest" and "os_signpost" instruments. `OSSignposter(subsystem:category:)`
  ([docs](https://developer.apple.com/documentation/os/ossignposter)) — instrument the PTY read → parse →
  layout → draw pipeline with one interval per frame and one per chunk. `OSLog` with an explicit subsystem
  (`dev.janela.*`) keeps it filterable via `log stream --predicate 'subsystem == "dev.janela"'`
  ([Logging system activity](https://developer.apple.com/documentation/os/logging-system-activity)).
- **Instruments templates** worth wiring into the repo: Time Profiler, Allocations, Leaks, System Trace,
  SwiftUI (view body / update counts), Animation Hitches, and App Launch — see
  [Improving your app's performance](https://developer.apple.com/documentation/xcode/improving-your-app-s-performance)
  and [Analyzing the performance of your shipping app](https://developer.apple.com/documentation/xcode/analyzing-the-performance-of-your-shipping-app).
- **MetricKit on macOS — read the availability carefully.** `MXMetricManager` is macOS 12.0+, but the DocC
  Overview says the shared object "receives daily metric reports when the device your app is installed on is
  running iOS 13 and later **or macOS 26 and later**," while diagnostic reports arrive immediately "in iOS 15 and
  later and macOS 12 and later"
  ([MXMetricManager](https://developer.apple.com/documentation/metrickit/mxmetricmanager)). So on macOS, daily
  *metric* payloads are effectively a macOS 26 feature. Additionally, the JSON records
  `deprecatedAt: "27.0"` with `message: "Use MetricManager instead."` — i.e. `MXMetricManager` is already on a
  deprecation path in favour of `MetricManager`. **Write against `MetricManager`, not `MXMetricManager`.**
  Note MetricKit reports are opt-in from the user's device and arrive at most once per day; they are a fleet
  signal, not a development tool.
- **Launch time.** The App Launch template in Instruments plus signposts around `applicationDidFinishLaunching`
  and first-frame. Concrete levers for Janela: (a) `Scene.defaultLaunchBehavior(.suppressed)` where a window
  isn't wanted at launch (macOS 15+); (b) avoid Core Data/SwiftData runtime initialisation on the launch path
  (another reason for GRDB); (c) defer opening the DB and enumerating worktrees until after first paint;
  (d) keep dynamic framework count low — every embedded framework is dyld work.

---

## Implications for Janela

| Area | Recommendation | Rationale (primary source) | Rejected alternative |
| --- | --- | --- | --- |
| UI framework | SwiftUI `App`/`Scene` shell; terminal surface as `NSViewRepresentable`; `@NSApplicationDelegateAdaptor` for `NSWindow`/Services escapes | `Table` (macOS 12+), `Settings`, `MenuBarExtra`, `@FocusState`, `.draggable`, and **user-customizable toolbars via `toolbar(id:)` + `ToolbarCommands`** are all native SwiftUI today ([toolbar(id:content:)](https://developer.apple.com/documentation/swiftui/view/toolbar(id:content:))). macOS 26 adds `NSHostingMenu` / `NSHostingSceneRepresentation` to blur the boundary further | Pure AppKit (throws away Settings/Commands/focus plumbing); pure SwiftUI (no terminal renderer, no `NSWindow.tabbingMode`, no Services) |
| Deployment target | macOS 15.0, not 26.0 | `UtilityWindow` and `Scene.defaultLaunchBehavior(_:)` — the two macOS-specific scene APIs Janela actually wants — report `introducedAt: "15.0"`, contrary to the SwiftUI updates page's June-2025 grouping | macOS 26.0 minimum (halves the addressable install base for zero API gain, except Liquid Glass and MetricKit daily reports) |
| Default actor isolation | Keep `nonisolated` default. Annotate the UI layer `@MainActor` explicitly | SE-0466 is opt-in and does not change defaults; `-default-isolation MainActor` would silently pull the VT parser onto the main actor | `-default-isolation MainActor` (SE-0466) |
| PTY → renderer path | `DispatchIO` reader on a private queue → VT parser in its own isolation domain → batched `Sendable` screen-delta snapshots into `@MainActor`, one per display refresh | SE-0414 regions + SE-0430 `sending` make the hand-off expressible without `@unchecked Sendable`; SE-0461 warns that inheriting isolation "can regress performance… if a specific async function relied on running off of the main actor" | `actor PTYReader` with a blocking `read()` (occupies a cooperative thread); per-byte or per-`read()` main-actor hops |
| Async escape hatch | Mark hot off-main work `@concurrent`; enable `NonisolatedNonsendingByDefault` deliberately, not by accident | SE-0461 changes runtime behaviour, is gated by an upcoming feature flag, and SourceKit surfaces the implicit annotation | Leaving it implicit and hoping |
| Persistence | GRDB, on-disk `DatabasePool` (WAL) in the app, in-memory `DatabaseQueue` in tests and previews | Upstream documents exactly this split; explicit Serialized-Writes / Write-Transactions / Isolated-Reads guarantees; plain SQLite file inspectable by agents and sidecar CLIs; no Core Data runtime on the launch path | SwiftData (models and `ModelContext` are non-`Sendable`; every cross-actor read becomes a `PersistentIdentifier` round-trip; Core Data runtime cost at launch); raw SQLite C API |
| Project layout | Checked-in `Janela.xcodeproj` with **buildable folders** for every source dir + local SwiftPM packages under `Packages/` for the non-UI core | Xcode 16 release notes: buildable folders "only record the folder path into the project file without enumerating the contained files… avoids source control conflicts." Adding a file = zero pbxproj diff, which is exactly the agent-editability requirement | Tuist (own docs: "If conflicts are your only gripe, project generation might be overkill"); XcodeGen (second source of truth, YAML, loses Xcode UI edits); SwiftPM-only (cannot produce a signed notarizable `.app`; Tuist documents Xcode sluggishness and derived-data inconsistency) |
| Test framework | Swift Testing for unit/integration; XCTest only for UI automation and `measure` baselines | Swift Testing ships in the Swift 6 toolchain / Xcode 16+, needs no dependency, and runs side-by-side with XCTest; Apple platforms are "Supported / Automated" | XCTest everywhere (no parameterised parallel cases, no expression capture); Quick/Nimble (extra dependency) |
| CI | `runs-on: macos-26-arm64`, explicit `sudo xcode-select -s /Applications/Xcode_26.6.app`, `swift test --parallel` for core + one `xcodebuild test` for the app | The macos-26-arm64 image is macOS 26.5.2 with Xcode 26.6 as default and 26.0.1–26.5 available; macos-15-arm64 still defaults to Xcode 16.4 | `macos-latest` (unpinned; default Xcode changes on announced dates — the READMEs literally carry a "Default Xcode… will be set to Xcode 26.6 on 2026.07.21" banner) |
| Sandbox | **Do not sandbox.** Developer ID + hardened runtime + notarization | Sandboxed child processes must be signed with "just… `com.apple.security.app-sandbox` and `com.apple.security.inherit`" and therefore inherit the container — incompatible with spawning `claude`/`codex`/`zsh` in arbitrary worktrees | App Sandbox (kills the product); consequently, Mac App Store distribution |
| Entitlements | Hardened runtime with **no** exceptions initially. Add `disable-library-validation` only if/when a plugin system loads third-party dylibs | Apple: "use only the entitlements that are absolutely necessary." `allow-jit`, `allow-unsigned-executable-memory`, `disable-executable-page-protection`, and `cs.debugger` are all unnecessary for `posix_spawn` + PTY | Blanket-enabling exceptions "just in case" (notarization scrutiny, weaker posture) |
| Updates | Sparkle 2 via SwiftPM, EdDSA-signed archives, `SURequireSignedFeed`, XPC services stripped | Sparkle key rotation requires Developer ID signing *plus* an EdDSA key; signed feeds prevent server-compromise metadata forgery; the sandboxing XPC services are dead weight for an unsandboxed app | Plain download + "check for updates" link (no delta updates, no signature chain); Homebrew-cask-only (loses in-app update UX) |
| Observability | `OSLog`/`OSSignposter` under a `dev.janela.*` subsystem, signposts on read→parse→layout→draw; Instruments App Launch + Time Profiler + SwiftUI templates in the repo | `OSSignposter(subsystem:category:)` feeds Instruments' Points of Interest directly | `print()` / `Date()` timing; `MXMetricManager` (already `deprecatedAt: 27.0`, "Use MetricManager instead", and daily macOS metric reports only land on macOS 26+) |

### Concrete first-week actions

1. `Janela.xcodeproj` with one app target, every source directory converted to a **buildable folder**; commit it.
2. `Packages/TerminalCore`, `Packages/SessionStore` as local SwiftPM packages with `swift-tools-version: 6.0`,
   Swift 6 language mode, and `swift test` green.
3. Entitlements file: hardened runtime, **no** App Sandbox, **no** runtime exceptions. Verify with
   `codesign -d -vvv --entitlements :- Janela.app` in CI.
4. `.github/workflows/ci.yml` on `macos-26-arm64` with an explicit `xcode-select` to Xcode 26.6.
5. GRDB `DatabaseMigrator` with migration 1 = workspaces/sessions/worktrees; a `makeInMemoryQueue()` factory used
   by every preview and test.
6. `OSSignposter` instance wired through the PTY→render path before writing the renderer, so every optimisation
   afterwards is measured rather than guessed.

---

## Gaps / not confidently answered

- **Terminal renderer implementation choice** (Core Text + `CALayer` vs Metal vs `NSTextView`/TextKit 2) was out of
  scope here and has no single authoritative Apple document. It needs its own benchmark-driven investigation.
- **`NSHostingView` / SwiftUI hosting overhead per window** — Apple publishes no numbers. With "many concurrent
  sessions" as a goal, measure `NSHostingView` memory per window empirically before committing to one
  `WindowGroup` window per session vs an in-app tab model.
- **`MetricManager`** (the macOS 27 replacement for `MXMetricManager`) — its API surface was not examined; if
  Janela targets macOS 15+, MetricKit is largely unavailable anyway and this is low priority.
- **Xcode 26.6 SwiftUI preview reliability for `NSViewRepresentable` wrapping a custom-drawn view** — no primary
  source; verify empirically early, since a broken preview loop degrades the whole dev experience.
- **Notarization of a Sparkle-updated app in CI** — Apple documents `notarytool`, and Sparkle documents
  `xcodebuild archive`/`-exportArchive`, but the end-to-end signing of Sparkle's `Autoupdate` and `Updater.app`
  inside a GitHub Actions keychain is only partially documented; expect one debugging cycle.
