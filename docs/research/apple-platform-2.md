# Research: Apple platform choices for Janela (native macOS agentic IDE, macOS 15+ deployment, Xcode 26.6 / Swift 6.3)

Primary sources only: `developer.apple.com` (DocC JSON endpoints under `/tutorials/data/...`, which are the machine-readable form of the public docs), `swift.org`, `github.com/swiftlang/swift-evolution`, `github.com/actions/runner-images`, `github.com/migueldeicaza/SwiftTerm`, `sparkle-project.org`. Anything sourced from a blog or third-party write-up is explicitly excluded.

---

## 0. Toolchain reality check

| Claim in the brief | Verified? | Evidence |
| --- | --- | --- |
| Swift 6.3 exists and is shipping | Yes | Swift 6.3 released 2026-03-24; tag `swift-6.3-RELEASE`. [swift.org/blog/swift-6.3-released](https://www.swift.org/blog/swift-6.3-released/) |
| Xcode 26.6 exists and is the GA default | Yes | GitHub-hosted macOS 26 image ships Xcode 26.6 (build 17F113) as default, alongside 26.5 / 26.4.1 / 26.3. [actions/runner-images images/macos/macos-26-Readme.md](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-Readme.md) |
| macOS 26 SDK, arm64 | Yes | Runner image lists SDK `macosx26.5` for Xcode 26.5/26.6; `macos-26` / `macos-26-xlarge` labels are arm64. [actions/runner-images README](https://github.com/actions/runner-images/blob/main/README.md) |
| Xcode 26.x requires macOS 15.6+ host | Yes | "Xcode 26 requires a Mac running macOS Sequoia 15.6 or later." [Xcode 26 Release Notes](https://developer.apple.com/documentation/xcode-release-notes/xcode-26-release-notes) |

Note: Swift 6.3's headline features (`@c` attribute, module selectors, `@specialize`/`@inline(always)`/`@export(implementation)`, Swift Build preview in SwiftPM, official Android SDK) are essentially irrelevant to Janela. **The concurrency model Janela must design against is Swift 6.2's**, because SE-0461 and SE-0466 landed there and are the two proposals that decide the whole architecture. Source: [swift.org/blog/swift-6.3-released](https://www.swift.org/blog/swift-6.3-released/).

---

## 1. SwiftUI vs AppKit for a document-less, multi-pane, window-heavy tool

### 1.1 What SwiftUI genuinely provides at deployment target macOS 15

All availability data below is from the `platforms.introducedAt` field of Apple's own DocC JSON, i.e. the same data that renders the "macOS 13.0+" badges on developer.apple.com.

| API | macOS availability | Source |
| --- | --- | --- |
| `Settings` scene | **11.0** | [swiftui/settings](https://developer.apple.com/documentation/swiftui/settings) |
| `Table` | **12.0** | [swiftui/table](https://developer.apple.com/documentation/swiftui/table) |
| `MenuBarExtra` | **13.0** | [swiftui/menubarextra](https://developer.apple.com/documentation/swiftui/menubarextra) |
| `NavigationSplitView` | **13.0** | [swiftui/navigationsplitview](https://developer.apple.com/documentation/swiftui/navigationsplitview), [TN3154](https://developer.apple.com/documentation/technotes/tn3154-adopting-swiftui-navigation-split-view) |
| Window/scene customization (toolbar appearance+visibility, drag region, zoom participation, restoration behavior) | **15.0** | [Customizing window styles and state-restoration behavior in macOS](https://developer.apple.com/documentation/SwiftUI/Customizing-window-styles-and-state-restoration-behavior-in-macOS) |

Everything Janela needs from the "SwiftUI genuinely does this now" list is available at deployment target macOS 15 with margin. In particular the macOS 15 scene-customization APIs are exactly at the floor, not above it — so Janela can use them unconditionally with **no `if #available` ladders**. This is a real argument for holding the deployment target at 15 rather than dropping to 14.

Specific facts worth designing around:

- **`MenuBarExtra` supports `.menuBarExtraStyle(.window)`** for "more complex or data rich menu bar extras… a popover-like window from the menu bar icon that contains standard controls". An app whose *only* scene is a `MenuBarExtra` is auto-terminated if the user removes the extra from the menu bar. [swiftui/menubarextra](https://developer.apple.com/documentation/swiftui/menubarextra)
- **`NavigationSplitView` is 2- or 3-column and is meant to be the root of a `Scene`**, with selection in leading columns driving trailing columns; `navigationSplitViewStyle(_:)` offers `.automatic` / `.balanced` / `.prominentDetail`. `NavigationLink` is documented to double as `List` selection driver inside a split view. [swiftui/navigationsplitview](https://developer.apple.com/documentation/swiftui/navigationsplitview), [swiftui/navigationsplitviewstyle](https://developer.apple.com/documentation/swiftui/navigationsplitviewstyle), [swiftui/navigationlink](https://developer.apple.com/documentation/SwiftUI/NavigationLink)
- **Customizable toolbars are a first-class SwiftUI feature**, not an AppKit-only one: `ToolbarItem.init(id:placement:content:)` exists precisely to "allow for user customization", paired with an ID on the `.toolbar` modifier. [swiftui/toolbaritem](https://developer.apple.com/documentation/swiftui/toolbaritem), [View/toolbar(content:)](https://developer.apple.com/documentation/SwiftUI/View/toolbar(content:))
- All SwiftUI value types are now declared `nonisolated struct` in the DocC declarations (e.g. `nonisolated struct NavigationSplitView<…>`, `nonisolated struct Table<…>`, `nonisolated struct MenuBarExtra<…>`). This is the SE-0466-era annotation style and matters when you set default isolation (§2.4).

### 1.2 What still requires AppKit

1. **The terminal view itself.** SwiftTerm's macOS front end is `open class TerminalView: NSView` / `LocalProcessTerminalView: TerminalView` — there is no SwiftUI view. Source: `Sources/SwiftTerm/Mac/MacLocalTerminalView.swift`, symbol `LocalProcessTerminalView`, doc comment: *"`LocalProcessTerminalView` is an AppKit NSView that can be used to host a local process… launched inside a pseudo-terminal."* [MacLocalTerminalView.swift](https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/Mac/MacLocalTerminalView.swift) So `NSViewRepresentable` is mandatory, as chosen. ✅
2. **Window tabbing.** The entire tabbing surface is `NSWindow`-only and has no SwiftUI equivalent: `NSWindow.tabbingMode` (macOS 10.12+), `tabbingIdentifier`, `tabGroup` (`NSWindowTabGroup`), `tabbedWindows`, `addTabbedWindow(_:ordered:)`, `mergeAllWindows(_:)`, `moveTabToNewWindow(_:)`, `selectNextTab(_:)` / `selectPreviousTab(_:)`, `toggleTabBar(_:)`, `toggleTabOverview(_:)`, class properties `allowsAutomaticWindowTabbing` and `userTabbingPreference`. [appkit/nswindow/tabbingmode-swift.property](https://developer.apple.com/documentation/appkit/nswindow/tabbingmode-swift.property) If Janela wants Safari/Terminal-style native window tabs for workspaces, you must reach the `NSWindow` behind the SwiftUI scene (`NSApp.windows`, or an `NSWindowDelegate` installed from an `NSViewRepresentable`/`NSHostingController`).
3. **Fine-grained `NSToolbar` control.** SwiftUI covers add/remove/reorder customization; it does not expose `NSToolbarItem` subclassing, `NSToolbarItemGroup` with dynamic sizing, or custom `NSToolbar.Delegate` behaviour. There is no primary-source SwiftUI API for those.

### 1.3 Terminal rendering: an important, under-appreciated finding

SwiftTerm on `main` ships a **Metal renderer**: `Package.swift` declares `resources: [.process("Apple/Metal/Shaders.metal")]` on the `SwiftTerm` target. [SwiftTerm/Package.swift](https://github.com/migueldeicaza/SwiftTerm/blob/main/Package.swift) This changes the "terminal rendering performance" calculus materially — you are not necessarily on a CoreText/CGContext path, and any custom renderer you write behind your swappable protocol starts from behind, not ahead.

---

## 2. Swift 6 strict concurrency — verified proposal numbers and the PTY hot path

### 2.1 Verified swift-evolution proposals (all read from the proposal files themselves)

| Proposal | Title | Status (from the file) | Feature flag |
| --- | --- | --- | --- |
| [SE-0414](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0414-region-based-isolation.md) | Region based Isolation | **Implemented (Swift 6.0)** | `RegionBasedIsolation` |
| [SE-0430](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0430-transferring-parameters-and-results.md) | `sending` parameter and result values | Implemented (Swift 6.0) | — |
| [SE-0461](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0461-async-function-isolation.md) | Run nonisolated async functions on the caller's actor by default | **Implemented (Swift 6.2)** | `NonisolatedNonsendingByDefault` |
| [SE-0466](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0466-control-default-actor-isolation.md) | Control default actor isolation inference | **Implemented (Swift 6.2)** | `-default-isolation` / `SwiftSetting.defaultIsolation` |
| [SE-0338](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0338-clarify-execution-non-actor-async.md) | Clarify execution of non-actor async functions | superseded by SE-0461 (cited as "Previous Proposal" in SE-0461) | — |
| [SE-0449](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0449-nonisolated-for-global-actor-cutoff.md) | `nonisolated` on any declaration | cited by SE-0466 | — |
| [SE-0470](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0470-isolated-conformances.md) | Isolated conformances / `SendableMetatype` | cited by SE-0466 amendment | — |

Note SE-0414's review history is non-trivial: it went through two reviews and was "accepted with modifications" in Feb 2024, with the key modification that *non-`Sendable` captured values of isolated closures are merged into the actor's region*. [forums.swift.org acceptance](https://forums.swift.org/t/accepted-with-modifications-se-0414-region-based-isolation/70051)

### 2.2 SE-0461 is the single most important proposal for Janela

Verbatim from the proposal: *"Without the upcoming feature flag, the default for nonisolated async functions is `@concurrent`. When the upcoming feature flag is enabled, the default for nonisolated async functions changes to `nonisolated(nonsending)`."* And, critically for a terminal app: *"the change can also regress performance of existing code if, for example, a specific async function relied on running off of the main actor when called from the main actor to maintain a responsive UI."* [SE-0461](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0461-async-function-isolation.md)

**Consequence for Janela's PTY hot path:** with `NonisolatedNonsendingByDefault` on, a plain `nonisolated func drain() async` called from `@MainActor` code will *run on the main actor*. Your PTY drain must be explicitly annotated `@concurrent` (or live on a dedicated actor with a custom executor) or you will silently move the parse loop onto the main thread. This is the exact failure mode Apple warns about independently in [Improving your app's responsiveness](https://developer.apple.com/documentation/xcode/improving-app-responsiveness), whose worked example shows a `Task {}` inheriting main-actor isolation and hanging the UI, fixed only by `Task.detached` or by making the function genuinely `async` + nonisolated.

### 2.3 Apple's own responsiveness budget

From [Improving your app's responsiveness](https://developer.apple.com/documentation/xcode/improving-app-responsiveness): synchronous main-thread work in response to a discrete user interaction should be **< 100 ms**, and *"Assume that less than half that time is available for your app's main thread to do its work."* At 60 Hz that is a ~8 ms frame budget for terminal glyph layout + draw across all visible sessions. Hang detection in Instruments requires macOS 13+ (Instruments 14+).

### 2.4 SE-0466 and the default-isolation decision

SE-0466 gives you a per-target switch: `swiftSettings: [.defaultIsolation(MainActor.self)]` (SwiftPM, `_PackageDescription` 6.2+) or `-default-isolation MainActor`. Default isolation does **not** apply to: declarations inside an `actor`, declarations with explicit/inherited isolation, typealiases/imports/enum cases, and — per the accepted amendment — *"Declarations whose primary definition directly conforms to a protocol that inherits `SendableMetatype`"*. That last rule is what makes `Codable`/`CodingKeys` and `Transferable` keep working. [SE-0466](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0466-control-default-actor-isolation.md)

The practical shape this implies for Janela's SPM package: **split targets by isolation policy**, not by feature. UI targets get `.defaultIsolation(MainActor.self)`; the PTY/process/git/db targets get the default `nonisolated`.

### 2.5 ⚠️ CONTRADICTION: SwiftTerm is not Swift 6 language mode

`SwiftTerm/Package.swift` ends with:

```swift
swiftLanguageModes: [.v5]
```

[SwiftTerm/Package.swift](https://github.com/migueldeicaza/SwiftTerm/blob/main/Package.swift)

That is a hard, checked-in fact: SwiftTerm compiles in Swift 5 language mode. Consequences you must plan for:

- None of its types are data-race-audited. `TerminalView`, `LocalProcess`, `Terminal`, and the delegate protocols carry no `Sendable` / `@MainActor` annotations.
- `LocalProcessTerminalViewDelegate` and `TerminalViewDelegate` are plain `AnyObject` protocols (`public protocol LocalProcessTerminalViewDelegate: AnyObject`), so conforming a `@MainActor` type to them from a Swift 6 module requires `@preconcurrency import SwiftTerm` and/or `MainActor.assumeIsolated` in each callback. [MacLocalTerminalView.swift](https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/Mac/MacLocalTerminalView.swift)
- Its minimum platform is `.macOS(.v11)` (or `.v13` when benchmarks are enabled), so it will not block a macOS 15 floor, but it also will not have adopted anything newer.

This does not invalidate the SwiftTerm choice — it invalidates any assumption that "SwiftTerm behind a protocol" is concurrency-clean by construction. Budget for a `@preconcurrency` boundary module.

### 2.6 What SwiftTerm's PTY hot path actually does (read the source before rebuilding it)

From `Sources/SwiftTerm/LocalProcess.swift` ([source](https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/LocalProcess.swift)), class `LocalProcess`:

- `let readSize = 128*1024` — 128 KB reads.
- Two queues: `var dispatchQueue: DispatchQueue` (delivery; **defaults to `DispatchQueue.main`**) and `var readQueue: DispatchQueue` (label `"sender"`), with the comment *"The queue we use to read, it feels more interactive if we read here and then post to the main thread. Otherwise it feels chunky."*
- I/O is `DispatchIO(type: .stream, fileDescriptor: master, queue: dispatchQueue, cleanupHandler: …)` with `io.setLimit(lowWater: 1)` / `setLimit(highWater: readSize)`.
- **Explicit backpressure**: `pendingHighWaterBytes`, `readSuspendedForBackpressure`, `enqueueReceivedData(_:) -> Bool` returning "keep reading", and `resumePtyRead()` to re-arm. Comment: *"One op must spawn exactly one successor"* — a guard against exponential in-flight read chains under a fast producer.
- **Time-sliced main-queue drain**: `pendingTimeSliceNs: UInt64 = 4_000_000` (4 ms) and `pendingChunkFlushThreshold = 32`; `drainReceivedData()` re-`async`s itself once the 4 ms slice expires.
- Cleanup-handler ordering exists specifically to avoid *"BUG IN CLIENT OF LIBDISPATCH: Unexpected EV_VANISHED"*.
- Child exit is watched with `DispatchSource.makeProcessSource(identifier: shellPid, eventMask: .exit, …)`, with a documented ordering hazard: the handler must be installed **before** `activate()`, because `NOTE_EXIT` is delivered at most once and a fast-exiting child would otherwise drop it. Also `running`/`shellPid` must be published before activation or `waitpid(0, …)` targets the caller's process group.
- Two spawn paths exist: a `PseudoTerminalHelpers.fork(andExec:…)` (forkpty) path, and a `swift-subprocess` path using `openpty` + `PlatformOptions.preSpawnProcessConfigurator` setting `POSIX_SPAWN_SETSID`.

**⚠️ Contradiction / caution on Subprocess:** `Package.swift` carries a commented-out `swift-subprocess` dependency with the note: *"We can not use Swift Subprocess, because there is no way of configuring the child process to be a controlling terminal, as it is posix-spawn based."* — while `LocalProcess.swift` contains a live Subprocess code path. These two are in tension in the upstream tree. If Janela plans to use `swift-subprocess` for agent processes, treat controlling-terminal semantics as an open risk and verify empirically. [Package.swift](https://github.com/migueldeicaza/SwiftTerm/blob/main/Package.swift)

**Design implication:** the "PTY-reading actor feeding a `@MainActor` renderer" design is *already implemented* in `LocalProcess`, but with GCD primitives, not Swift concurrency, and with delivery defaulting to the main queue. If you wrap `LocalProcessTerminalView`, you inherit that pipeline wholesale. If you want an actor-based pipeline with your own backpressure policy across N concurrent sessions, you should use `LocalProcess(delegate:dispatchQueue:)` with a **non-main** queue (the `else` branch does a synchronous `dispatchQueue.sync { delegate?.dataReceived(...) }`, so choose deliberately) or drive `Terminal` directly and skip `LocalProcess`.

---

## 3. SwiftData vs Core Data vs GRDB for a small local metadata store

Facts:

- **SwiftData: macOS 14.0+.** [documentation/swiftdata](https://developer.apple.com/documentation/swiftdata) — available at a macOS 15 floor, so availability is not the blocker.
- **SwiftData is Core Data's store format.** Apple's own sample explicitly runs *"two persistence stacks: a Core Data persistence stack for the host app, and a SwiftData persistence stack for the widget extension. Both stacks write to the same store file."* The sample sets `description.url = url` and must manually set `NSPersistentHistoryTrackingKey` because *"SwiftData enables persistent history tracking automatically, Core Data does not."* [Adopting SwiftData for a Core Data app](https://developer.apple.com/documentation/coredata/adopting-swiftdata-for-a-core-data-app) So "SwiftData vs Core Data" is a front-end question, not a storage-engine question; both mean an `NSPersistentStoreCoordinator`, a managed object model, and history tracking on the launch path.
- Note the sample is marked `introducedAt: 27.0 / beta: true` — the *coexistence guidance itself* is beta documentation as of this writing.
- **GRDB** is a thin, explicit SQLite layer with `DatabaseQueue` / `DatabasePool` (WAL) concurrency, no object graph, no model migration runtime. [groue/GRDB.swift](https://github.com/groue/GRDB.swift)

Assessment for Janela's workload (workspace/session/worktree metadata; small row counts; many concurrent readers; startup latency matters):

- SwiftData/Core Data cost you `dyld` load of CoreData + model load + store coordinator setup on the launch path. Apple's own guidance in [Reducing your app's launch time](https://developer.apple.com/documentation/xcode/reducing-your-app-s-launch-time) is explicitly *"Reduce dependencies on external frameworks and dynamic libraries"* and *"Move expensive tasks out of your app delegate"*.
- SwiftData buys you `@Model` + `@Query` SwiftUI integration. For a terminal-first tool where the hot UI is a `TerminalView`, not a data-bound list of thousands of rows, that integration is worth little.
- **GRDB is the right call** — but the actual justification is not "faster than SQLite via Core Data"; it is (a) no managed-object-context/main-actor coupling, (b) explicit control over WAL and connection pooling for many concurrent sessions, (c) a schema you can inspect and migrate with `sqlite3` from an agent shell, which matters a lot for an agent-hosting IDE.

---

## 4. Project generation: XcodeGen vs Tuist vs SPM-only vs checked-in .xcodeproj

Primary facts:

- **XcodeGen** is a Swift CLI that generates `.xcodeproj` from a YAML/JSON spec, and its README states the goal explicitly: *"Generate projects on demand and remove your `.xcodeproj` from git, which means **no more merge conflicts**!"* and *"Groups and files in Xcode are always synced to your directories on disk"*. Installation via `brew install xcodegen` or `mint`. `--use-cache` avoids regeneration when the spec and files are unchanged. It is built on `tuist/XcodeProj`. [yonaskolb/XcodeGen README](https://github.com/yonaskolb/XcodeGen) — note its README also says *"Make sure the latest stable (non-beta) version of Xcode is installed first."*
- XcodeGen's own README lists **Tuist first** under "Alternatives". [same source]
- **SPM-only is viable for build/test but not for app bundling.** `swift test` in Xcode 26 gained `--attachments-path` for Swift Testing (ST-0009). [Xcode 26 Release Notes](https://developer.apple.com/documentation/xcode-release-notes/xcode-26-release-notes) But SwiftPM cannot produce a signed, notarizable `.app` bundle with an `Info.plist`, entitlements, and a hardened-runtime signature — Apple's distribution flow is `xcodebuild archive` + Organizer / `notarytool`.
- **`pbxproj` mergeability**: the reason XcodeGen exists. Note an important second-order fact for an agent-edited repo: XcodeGen *auto-discovers sources from the directory tree*, so an agent that adds a `.swift` file needs no project edit at all. With a checked-in `.xcodeproj`, every file addition is a `pbxproj` mutation — the single worst merge-conflict generator in Apple tooling, and one that coding agents get wrong routinely.

**Verdict: XcodeGen + all-logic-in-SPM is correct and I found no primary evidence against it.** ✅ Two caveats:

1. **SwiftUI Previews.** Xcode 26 fixed a batch of Previews bugs specific to this architecture: *"Previews could fail to find libraries linked through symlinked paths"*, *"Previews now handles static libraries that were resulting in a 'does not contain an archive' error"*, *"Previewing code that used libraries asserting they were loaded on the main thread could crash. Previews now runs library initializers on the main thread."*, *"Compilation caching should now work with Previews."* [Xcode 26 Release Notes](https://developer.apple.com/documentation/xcode-release-notes/xcode-26-release-notes) The pattern here is clear: previews-of-code-in-an-SPM-package-linked-into-a-generated-project is a known-fragile path that Apple has been patching. Expect friction; do not make previews load-bearing.
2. **Xcode 26 build-and-run bug relevant to a terminal app**: *"Fixed: Run action incorrectly launched a duplicate app instance when using SwiftUI Previews, or when running a command line app which opens windows using SDL, GLFW, or NSApplication APIs without being packaged as an app bundle."* [same] — another reason to keep the app target a real bundle, not an SPM executable.

---

## 5. Distribution: notarization, hardened runtime, Sparkle, and what conflicts with spawning processes

### 5.1 Hardened runtime does NOT block spawning subprocesses

The Hardened Runtime is a per-executable set of protections with six opt-out "Runtime Exceptions": `com.apple.security.cs.allow-jit`, `allow-unsigned-executable-memory`, `allow-dyld-environment-variables`, `disable-library-validation`, `disable-executable-page-protection`, `debugger`; plus "Resource Access" entitlements (audio-input, camera, location, address book, calendars, photos, apple-events). [documentation/security/hardened-runtime](https://developer.apple.com/documentation/security/hardened-runtime)

**None of these govern `fork`/`exec`/`posix_spawn` of arbitrary binaries.** The doc's own summary: *"The Hardened Runtime doesn't affect the operation of most apps, but it does disallow certain less common capabilities, like just-in-time (JIT) compilation."* Also: *"You add entitlements only to executables. Shared libraries, frameworks, and in-process plug-ins inherit the entitlements of their host executable."* and *"The default value of these Boolean entitlements is false. When Xcode signs your code, it includes an entitlement only if the value is true… Don't include an entitlement [set to false]."*

So: **hardened runtime + unsandboxed is compatible with spawning `claude`, `codex`, `opencode`, `/usr/bin/git`, and arbitrary user shells.** The chosen stack is correct here. ✅

### 5.2 App Sandbox IS the conflict — and Apple documents exactly why

Apple's helper-tool guide is the primary evidence that sandboxing an app that launches other executables is a structural problem, not a configuration detail. From [Embedding a command-line tool in a sandboxed app](https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app):

- The embedded tool must be signed with **exactly two** entitlements: `com.apple.security.app-sandbox` and `com.apple.security.inherit`. *"Adding other entitlements to the tool can cause problems. If the tool immediately crashes with a code signing error when your app runs the tool, check that the tool is signed with just these two entitlements."*
- `com.apple.security.get-task-allow` **is incompatible with** `com.apple.security.inherit` — so you must disable `CODE_SIGN_INJECT_BASE_ENTITLEMENTS`, and the doc states plainly: *"The absence of the `com.apple.security.get-task-allow` entitlement means that you won't be able to debug your tool."*
- The tool must be embedded in `Contents/MacOS` via a Copy Files phase with Code Sign On Copy, and `SKIP_INSTALL` must be enabled.

This entire regime applies only to **tools you embed and ship**. Janela launches **arbitrary user-installed binaries at arbitrary paths** (`~/.local/bin/claude`, Homebrew `git`, the user's `$SHELL`) which cannot be signed with `com.apple.security.inherit` by you. There is no supported sandboxed path for that. Independently, SwiftTerm's own `LocalProcessTerminalView` doc comment says: *"Generally, for the `LocalProcessTerminalView` to be useful, you will want to disable the sandbox for your application, otherwise the underlying shell will not have access to much… For this, you need to disable for your target in 'Signing and Capabilities' the sandbox entirely."* [MacLocalTerminalView.swift](https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/Mac/MacLocalTerminalView.swift)

**Corollary: Mac App Store distribution is off the table.** Apple: *"To distribute a macOS app through the Mac App Store, you must enable the App Sandbox capability."* [documentation/security/app-sandbox](https://developer.apple.com/documentation/security/app-sandbox) Developer ID + notarization + Sparkle is the only route. The chosen stack (unsandboxed + hardened runtime) is correct. ✅

### 5.3 Sparkle: one hardened-runtime interaction you must handle

From [sparkle-project.org/documentation](https://sparkle-project.org/documentation/):

- *"If you enable Library Validation, which is part of the Hardened Runtime and required for notarization, you will also need to either sign your application with an `Apple Development` certificate for development (requires being in Apple's developer program), or disable library validation for Debug configurations only. Otherwise, the system may not let your application load Sparkle if you attempt to sign to run locally via an ad-hoc signature. This is not an issue for distribution when you sign your application with a Developer ID certificate."*
- Sparkle requires `@loader_path/../Frameworks` (or `@executable_path/../Frameworks`) in the runpath search path, and your packaging must **preserve symlinks and executable permissions**.
- Update archives must be signed with Sparkle's **EdDSA (ed25519)** key via `./bin/generate_keys`, independent of Apple code signing. Key rotation is supported for Developer-ID-signed apps as long as you change *either* the Apple certificate *or* the EdDSA key, not both.
- Optional feed signing via `SURequireSignedFeed` (validated as of Sparkle 2.9); `SUVerifyUpdateBeforeExtraction` constrains EdDSA key rotation to Developer-ID-signed **dmg** archives.
- Unsandboxed apps can **remove Sparkle's XPC Services** to save space.
- `CFBundleVersion` must be incrementing and properly formatted — Sparkle uses it for version comparison.
- Sparkle supports dmg, zip, tarball, Apple Archives (`.aar`, Sparkle 2.7+ / macOS 10.15+), and installer packages.

**Actionable:** `disable-library-validation` should be a **Debug-configuration-only** entitlement, never in the shipped Release entitlements. This is the one place where a hardened-runtime exception legitimately enters a Janela build, and it is a Sparkle concern, not a subprocess concern.

---

## 6. swift-testing vs XCTest in Xcode 26, and headless CI on GitHub Actions

### 6.1 Feature state

Swift Testing in Xcode 26 / Swift 6.2 gained, per [Xcode 26 Release Notes](https://developer.apple.com/documentation/xcode-release-notes/xcode-26-release-notes):

- **Exit tests** — *"allow you to test code that calls `precondition()` or `fatalError()` or might otherwise terminate the test process."* Directly useful for Janela's PTY teardown and process-supervision code.
- **Attachments** (ST-0009), surfaced in Xcode's Test Report and `.xcresult`; `swift test --attachments-path <dir>` on the CLI.
- **Runtime issue detection** in both Swift Testing and XCTest when run via Xcode/`xcodebuild`, configurable in the Test Plan to promote runtime issues to failures.
- `ConditionTrait.evaluate()` (ST-0010), `.compactMapIssues { }` / `.filterIssues { }` traits.
- XCTest gained non-failing issues: `XCTIssue` with warning severity plus `XCTIssue.isFailure`.

Swift 6.3 adds on top ([swift.org/blog/swift-6.3-released](https://www.swift.org/blog/swift-6.3-released/)): warning-severity issues via `Issue.record(_, severity: .warning)` (ST-0013), **test cancellation** via `try Test.cancel()` (ST-0016), and image attachments (ST-0014/0015/0017). Proposals: ST-0012, ST-0013, ST-0014, ST-0015, ST-0016, ST-0017, ST-0020.

### 6.2 Known sharp edges (all from the Xcode release notes, i.e. Apple-acknowledged)

- *"Modules which use Swift Testing and enable the Strict Memory Safety feature introduced in Swift 6.2 encounter memory safety diagnostics from `@Test`, `@Suite`, and other macros."* (fixed in 26.x, but tells you `-strict-memory-safety` + Swift Testing was broken)
- *"Using a Swift.org toolchain in Xcode may cause build errors in targets that use Swift Testing due to an incompatible macro plugin being selected."* → **do not mix a swift.org toolchain with Xcode's Swift Testing.**
- Known issue: *"Swift Testing exit tests may produce crash logs in /Library/."*
- Xcode 26.2 note: *"Swift Testing exit tests run correctly when the Swift upcoming 'nonisolated…' [feature is enabled]"* — i.e. exit tests × `NonisolatedNonsendingByDefault` was a real interaction bug. [Xcode 26.2 Release Notes](https://developer.apple.com/documentation/xcode-release-notes/xcode-26_2-release-notes)

### 6.3 GitHub Actions macOS runners

From [actions/runner-images README](https://github.com/actions/runner-images/blob/main/README.md) and [macos-26-Readme.md](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-Readme.md):

- Labels: `macos-26` / `macos-latest` / `macos-26-xlarge` are **arm64**; `macos-26-intel` / `macos-26-large` / `macos-latest-large` are x64. `macos-15` is arm64; `macos-15-large`/`macos-15-intel` are x64. `macos-14` is **deprecated**.
- macOS 26 arm64 image: OS 26.5.2 (25F84), Darwin 25.5.0, Xcode **26.6 (17F113) default** at `/Applications/Xcode_26.6.app` symlinked to `/Applications/Xcode.app`, plus 26.5 / 26.4.1 / 26.3. SDK for 26.6 is `macosx26.5`. Xcode Command Line Tools 26.6.
- Policy: *"only one major version of Xcode will be supported per macOS version"* and *"all minor versions of the supported major version will be available"*. Announcement: *"Default Xcode on macOS 26 Tahoe will be set to Xcode 26.6 on 2026.07.21."*
- An `xcode-27` public-preview image exists (arm64).

**Implication:** pin `runs-on: macos-26` and explicitly `sudo xcode-select -s /Applications/Xcode_26.6.app` rather than relying on the default, because the default moves on announced dates. Do not use `macos-latest` for a toolchain-sensitive Swift 6.3 project.

**Headless caveat:** Janela's tests will spawn PTYs. GitHub macOS runners have no window server session available to a normal `xcodebuild test` run for UI tests, but `swift test` / `xcodebuild test` on a *logic* test bundle plus SwiftTerm's own headless approach (SwiftTerm ships a `HeadlessTerminal` in its test suite and a `Termcast` executable target — see [Package.swift](https://github.com/migueldeicaza/SwiftTerm/blob/main/Package.swift)) is the right model. Note SwiftTerm's manifest itself branches on `ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true"` to drop its benchmark target — evidence that benchmark targets are a known CI liability.

---

## 7. Performance tooling

- **`os_signpost` + `OSLog(subsystem:category: .pointsOfInterest)`** is Apple's documented mechanism for launch/phase instrumentation; the launch-time doc gives the literal pattern (`os_signpost(.begin, log: poiLog, name: …)` / `.end`). [Reducing your app's launch time](https://developer.apple.com/documentation/xcode/reducing-your-app-s-launch-time) `OSSignposter` is the modern Swift API. [documentation/os/ossignposter](https://developer.apple.com/documentation/os/ossignposter)
- **Instruments templates**: *App Launch* (time profile + thread-state trace), *Time Profiler*, *CPU Profiler*, *Hitches*, plus the **dyld Activity** instrument which *"measures the time your app spends running static initializers"*. Hangs instruments are included in Time Profiler / CPU Profiler / Hitches templates. [Reducing your app's launch time](https://developer.apple.com/documentation/xcode/reducing-your-app-s-launch-time), [Improving your app's responsiveness](https://developer.apple.com/documentation/xcode/improving-app-responsiveness)
- **Launch-time levers Apple names explicitly**: reduce third-party frameworks/dynamic libraries (*"Each additional third-party framework that your app loads adds to the launch time"*); use **mergeable dynamic libraries** (Xcode 15+) to get *"app launch times similar to static linking in release builds, without losing dynamically linked build times in debug builds"*; remove static initializers — C++ static constructors, ObjC `+load`, `__attribute__((constructor))`. [Reducing your app's launch time](https://developer.apple.com/documentation/xcode/reducing-your-app-s-launch-time), [Configuring your project to use mergeable libraries](https://developer.apple.com/documentation/xcode/configuring-your-project-to-use-mergeable-libraries)
- **The Launch Time pane in Xcode Organizer is iOS-only**: *"For iOS apps, use the Launch Time pane in the Xcode Organizer…"* [same source] → for a Mac app you must measure launch yourself (signposts + Instruments App Launch template).
- **MetricKit is macOS 12.0+** ([documentation/metrickit](https://developer.apple.com/documentation/metrickit)) so it is technically available. But for a Developer-ID-distributed, non-App-Store Mac app there is no Xcode Organizer aggregation pipeline (Organizer hang/hitch data is described in the context of shipping App Store apps). Treat MetricKit as low-value for Janela.
- `XCTOSSignpostMetric` exists for signpost-driven performance tests. [Improving your app's responsiveness](https://developer.apple.com/documentation/xcode/improving-app-responsiveness)

---

## 8. Implications for Janela — concrete recommendations

1. **Set `.defaultIsolation(MainActor.self)` on UI targets only, and leave engine targets `nonisolated`.** Per SE-0466 this is a per-target SwiftPM setting; mixing them in one target defeats the purpose. Concretely: `JanelaUI`, `JanelaApp` → MainActor; `JanelaTerminalCore`, `JanelaProcess`, `JanelaGit`, `JanelaStore` → nonisolated.
2. **Enable `NonisolatedNonsendingByDefault` deliberately and annotate the PTY drain `@concurrent`.** SE-0461's own "Source compatibility" section warns that this flag can move work you expected to be off-main onto main. Add a unit test asserting the drain is not on the main thread (`dispatchPrecondition(condition: .notOnQueue(.main))` in a debug build).
3. **Do not reimplement PTY backpressure — port SwiftTerm's.** Their constants are earned: 128 KB reads, 4 ms main-queue drain slice, 32-chunk flush threshold, high-water suspend/resume, "one read op spawns exactly one successor". If you write your own actor pipeline, reproduce all four properties or you will regress on `cat` of a large file across many sessions.
4. **Construct `LocalProcess(delegate:dispatchQueue:)` with an explicit non-main queue per session**, then hop to `@MainActor` yourself in batches. The default (`nil` → `DispatchQueue.main`) plus N concurrent sessions is a main-thread saturation design. Note the non-main branch uses `dispatchQueue.sync` — verify that against your renderer's locking.
5. **Wrap SwiftTerm in a `@preconcurrency import` boundary module.** Because SwiftTerm is `swiftLanguageModes: [.v5]`, put all SwiftTerm contact inside one target (`JanelaTerminalSwiftTerm`) that conforms to your swappable protocol; the rest of the app never sees an unaudited type. This also makes the protocol swap real rather than aspirational.
6. **Take the macOS 15 scene-customization APIs as a hard floor and use them unconditionally.** Toolbar appearance/visibility, window drag region, zoom participation, and restoration behavior are all macOS 15 SwiftUI APIs — exactly your deployment target.
7. **Reach for `NSWindow` only for tabbing.** `tabbingIdentifier` + `tabbingMode` + `NSWindowTabGroup` + `NSWindow.allowsAutomaticWindowTabbing` have no SwiftUI surface. Plan a single `NSWindowDelegate`-bridging type; do not scatter `NSApp.windows` lookups.
8. **Use SwiftUI's `ToolbarItem(id:placement:content:)` + `.toolbar(id:)` rather than a hand-rolled `NSToolbar`.** Customizable toolbars are a documented SwiftUI capability; drop to `NSToolbarDelegate` only if you need `NSToolbarItemGroup` sizing behavior.
9. **Keep GRDB. Reject SwiftData explicitly on launch-time and inspectability grounds**, and cite Apple's own coexistence doc as evidence that SwiftData == Core Data store format (so it carries the whole CoreData framework load on your launch path, against Apple's own "reduce dependencies on dynamic libraries" launch guidance).
10. **Keep XcodeGen + SPM. Add `--use-cache` to the generate step and check the cache path into `.gitignore`.** Add a CI job that runs `xcodegen generate && git diff --exit-code` to catch spec/tree drift introduced by agents.
11. **Ship two entitlement files.** `Janela.Debug.entitlements` with `com.apple.security.cs.disable-library-validation` (Sparkle + ad-hoc signing, per Sparkle's docs) and `Janela.Release.entitlements` with **zero** hardened-runtime exceptions. Apple: *"Don't include an entitlement [set to false]."*
12. **Do not add App Sandbox, ever.** Not as a future option. The `com.apple.security.inherit` regime is documented to work only for tools you embed and sign yourself; arbitrary user-installed agent CLIs cannot satisfy it. This also permanently forecloses the Mac App Store — decide that now, not later.
13. **Adopt Swift Testing, not XCTest, but pin the toolchain.** Exit tests directly cover PTY/process-supervision death paths. Do **not** select a swift.org toolchain in Xcode (Apple-documented macro-plugin incompatibility). Pin `runs-on: macos-26` + explicit `xcode-select -s /Applications/Xcode_26.6.app`.
14. **Instrument launch with `OSSignposter` from day one** (`.pointsOfInterest` category), and add a `dyld Activity` check to your perf checklist. Because the Organizer Launch Time pane is iOS-only, an unmeasured Mac launch path will silently rot.
15. **Prefer static linking / mergeable libraries for your SPM products in Release.** Apple explicitly names dynamic-library count as a launch-time cost and names mergeable libraries as the fix.
16. **Budget 8 ms/frame, not 16.** Apple's guidance: assume less than half of the 100 ms interaction budget is available to your main thread; with 60 Hz redraw across many sessions, terminal layout must be off-main and only the draw call on-main.

### Explicit contradictions with the already-chosen stack

| Chosen | Contradicting evidence |
| --- | --- |
| "SwiftTerm behind a swappable protocol" as a clean Swift 6 dependency | SwiftTerm's manifest is `swiftLanguageModes: [.v5]`; its delegates are unannotated `AnyObject` protocols. Requires `@preconcurrency` and a quarantine target. [Package.swift](https://github.com/migueldeicaza/SwiftTerm/blob/main/Package.swift) |
| "PTY-reading hot path feeding a `@MainActor` renderer" as new work | Already implemented in `LocalProcess` with DispatchIO + explicit backpressure + 4 ms drain slice, and delivery **defaults to `DispatchQueue.main`**. Adopting SwiftTerm without passing an explicit queue gives you the opposite of what you want. [LocalProcess.swift](https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/LocalProcess.swift) |
| Implicit assumption that hardened runtime is the subprocess constraint | It is not. Hardened runtime's six exceptions are about JIT/unsigned memory/dyld env/library validation/page protection/debugging. The subprocess constraint is **App Sandbox**. [hardened-runtime](https://developer.apple.com/documentation/security/hardened-runtime), [embedding-a-helper-tool-in-a-sandboxed-app](https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app) |
| Unsandboxed + hardened runtime with no entitlements | Sparkle forces `disable-library-validation` in **Debug** if you sign ad-hoc locally. Plan two entitlement files. [sparkle-project.org/documentation](https://sparkle-project.org/documentation/) |
| Terminal rendering as a place to win by writing a custom renderer | SwiftTerm already ships a Metal renderer (`Apple/Metal/Shaders.metal` processed resource). Baseline is higher than assumed. [Package.swift](https://github.com/migueldeicaza/SwiftTerm/blob/main/Package.swift) |
| (If applicable) using `swift-subprocess` for agent processes | SwiftTerm's manifest states Subprocess *"can not"* configure a controlling terminal because it is posix-spawn based — while its source contains a live Subprocess path. Unresolved upstream; verify empirically before committing. [Package.swift](https://github.com/migueldeicaza/SwiftTerm/blob/main/Package.swift) |
| SwiftUI-only, AppKit "where needed" | Correct, but "where needed" is a fixed, enumerable list: terminal `NSView`, `NSWindow` tabbing, and (optionally) `NSToolbarItemGroup`. Everything else in the brief's list is native SwiftUI at macOS 15. |

---

## 9. Decision table

| Area | Recommendation | Rationale (primary source) | Rejected alternative |
| --- | --- | --- | --- |
| UI framework | SwiftUI for scenes/chrome/sidebars/settings/menu bar; AppKit for terminal view, window tabbing, exotic toolbar items | `Settings` 11.0, `Table` 12.0, `MenuBarExtra` 13.0, `NavigationSplitView` 13.0, window customization 15.0 — all ≤ deployment target ([developer.apple.com DocC platform metadata](https://developer.apple.com/documentation/swiftui/navigationsplitview)) | Pure AppKit (throws away `Settings`/`MenuBarExtra`/customizable toolbars for no benefit); pure SwiftUI (no `NSWindow` tabbing surface exists) |
| Terminal emulation | SwiftTerm behind a protocol, quarantined in one `@preconcurrency import` target | Only shipping Swift VT emulator with an AppKit `NSView` front end + Metal renderer + hardened PTY loop ([MacLocalTerminalView.swift](https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/Mac/MacLocalTerminalView.swift), [Package.swift](https://github.com/migueldeicaza/SwiftTerm/blob/main/Package.swift)) | Writing a VT parser from scratch (rebuilds 4 non-obvious backpressure behaviours you'd rediscover by bug report) |
| PTY I/O | `LocalProcess` with an **explicit non-main** `dispatchQueue` per session; port the 128 KB / 4 ms / high-water backpressure constants | `LocalProcess.readSize = 128*1024`, `pendingTimeSliceNs = 4_000_000`, `enqueueReceivedData` high-water suspend ([LocalProcess.swift](https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/LocalProcess.swift)) | Default `DispatchQueue.main` delivery (main-thread saturation at N sessions); naive `AsyncStream` wrapper (no backpressure) |
| Concurrency model | `.defaultIsolation(MainActor.self)` on UI targets, `nonisolated` on engine targets; `NonisolatedNonsendingByDefault` on; PTY drain explicitly `@concurrent` | [SE-0466](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0466-control-default-actor-isolation.md), [SE-0461](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0461-async-function-isolation.md), [SE-0414](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0414-region-based-isolation.md) | Whole-package `MainActor` default (drags PTY/git/db onto main); no default isolation (false-positive churn in view code) |
| Metadata store | GRDB / SQLite | SwiftData is a Core Data front end over the same store file ([Apple coexistence sample](https://developer.apple.com/documentation/coredata/adopting-swiftdata-for-a-core-data-app)); launch guidance says reduce dynamic-library dependencies ([launch time](https://developer.apple.com/documentation/xcode/reducing-your-app-s-launch-time)) | SwiftData (macOS 14+, but CoreData load on launch path, opaque store, main-actor-coupled contexts); raw Core Data (all the cost, none of the ergonomics) |
| Project generation | XcodeGen `project.yml` + all logic in SPM; `.xcodeproj` gitignored; CI `xcodegen generate && git diff --exit-code` | XcodeGen's stated purpose is removing `.xcodeproj` from git and syncing groups to disk ([README](https://github.com/yonaskolb/XcodeGen)) | Checked-in `.xcodeproj` (pbxproj conflicts on every agent-added file); SPM-only (cannot produce a signed notarizable `.app`); Tuist (heavier model, extra runtime, no evidence of benefit at this scale) |
| Distribution | Developer ID + notarization + hardened runtime + Sparkle 2 (EdDSA, `SURequireSignedFeed`, XPC services removed) | [hardened-runtime](https://developer.apple.com/documentation/security/hardened-runtime); [Sparkle docs](https://sparkle-project.org/documentation/) | Mac App Store (requires App Sandbox, which is incompatible with spawning arbitrary user CLIs — [app-sandbox](https://developer.apple.com/documentation/security/app-sandbox), [helper tool guide](https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app)) |
| Entitlements | Release: none. Debug: `com.apple.security.cs.disable-library-validation` only | Apple: *"Don't include an entitlement [set to false]"*; Sparkle requires it for ad-hoc-signed local builds | Blanket `disable-library-validation` in Release (weakens the only protection you actually get) |
| Testing | Swift Testing (exit tests for process supervision); XCTest only where Swift Testing has no equivalent | [Xcode 26 release notes](https://developer.apple.com/documentation/xcode-release-notes/xcode-26-release-notes); ST-0013/0016 in [Swift 6.3](https://www.swift.org/blog/swift-6.3-released/) | XCTest-only (no exit tests, no parameterized traits); swift.org toolchain in Xcode (documented macro-plugin incompatibility) |
| CI | `runs-on: macos-26` (arm64) + explicit `xcode-select -s /Applications/Xcode_26.6.app` | Image ships Xcode 26.6 default today, but default is announced to change on dates ([macos-26-Readme.md](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-Readme.md), [README](https://github.com/actions/runner-images/blob/main/README.md)) | `macos-latest` (moving target); `macos-14` (deprecated) |
| Perf tooling | `OSSignposter` + `.pointsOfInterest`, Instruments App Launch / Time Profiler / Hitches, dyld Activity, mergeable libraries | [Reducing your app's launch time](https://developer.apple.com/documentation/xcode/reducing-your-app-s-launch-time), [Improving your app's responsiveness](https://developer.apple.com/documentation/xcode/improving-app-responsiveness) | MetricKit (macOS 12+ but no Organizer aggregation for Developer-ID apps); Organizer Launch Time pane (iOS-only) |

---

## Sources

**Kept — primary**

- [swift.org/blog/swift-6.3-released](https://www.swift.org/blog/swift-6.3-released/) — establishes Swift 6.3 content and ST-00xx proposal list.
- [SE-0414](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0414-region-based-isolation.md), [SE-0430](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0430-transferring-parameters-and-results.md), [SE-0461](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0461-async-function-isolation.md), [SE-0466](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0466-control-default-actor-isolation.md) — proposal text read directly; statuses and flags quoted verbatim.
- [SwiftTerm Package.swift](https://github.com/migueldeicaza/SwiftTerm/blob/main/Package.swift), [LocalProcess.swift](https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/LocalProcess.swift), [MacLocalTerminalView.swift](https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/Mac/MacLocalTerminalView.swift) — language mode, PTY constants, sandbox note, Metal resource.
- [developer.apple.com/documentation/security/hardened-runtime](https://developer.apple.com/documentation/security/hardened-runtime), [.../security/app-sandbox](https://developer.apple.com/documentation/security/app-sandbox), [.../xcode/embedding-a-helper-tool-in-a-sandboxed-app](https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app) — entitlement lists, sandbox inheritance regime, `get-task-allow` incompatibility.
- [.../xcode/reducing-your-app-s-launch-time](https://developer.apple.com/documentation/xcode/reducing-your-app-s-launch-time), [.../xcode/improving-app-responsiveness](https://developer.apple.com/documentation/xcode/improving-app-responsiveness) — dyld/static-initializer guidance, 100 ms budget, Instruments templates.
- [.../coredata/adopting-swiftdata-for-a-core-data-app](https://developer.apple.com/documentation/coredata/adopting-swiftdata-for-a-core-data-app) — SwiftData/Core Data shared store file.
- [Xcode 26 Release Notes](https://developer.apple.com/documentation/xcode-release-notes/xcode-26-release-notes), [Xcode 26.2 Release Notes](https://developer.apple.com/documentation/xcode-release-notes/xcode-26_2-release-notes) — Swift Testing features, Previews fixes, toolchain caveats.
- [actions/runner-images README](https://github.com/actions/runner-images/blob/main/README.md) + [macos-26-Readme.md](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-Readme.md) — runner labels, Xcode 26.6 default, SDK matrix.
- [sparkle-project.org/documentation](https://sparkle-project.org/documentation/) + [/sandboxing](https://sparkle-project.org/documentation/sandboxing/) — library validation, EdDSA, rpath, archive formats.
- [yonaskolb/XcodeGen README](https://github.com/yonaskolb/XcodeGen) — stated goals, caching, alternatives.
- SwiftUI DocC platform metadata for `Settings`, `Table`, `MenuBarExtra`, `NavigationSplitView`, `ToolbarItem`, `NSWindow.tabbingMode`, `SwiftData`, `MetricKit`, `OSSignposter`.

**Dropped**

- forums.swift.org review threads — used only to corroborate SE-0414's "accepted with modifications"; not load-bearing.
- InfoQ Swift 6.3 article, Swift Dev Journal toolbar post, swiftwithmajid toolbar post, "What's New in Testing" forum recap — secondary write-ups; every claim they make was re-sourced from the proposal/doc that owns it.
- `swiftpackageindex.com` SwiftTerm page — mirror of the README.

## Gaps

1. **Tuist was not evaluated from primary sources at depth.** Its README was fetched but not mined; the recommendation to stay on XcodeGen rests on XcodeGen's own documented properties plus the marginal-benefit argument, not on a measured Tuist comparison. If the team wants Tuist's caching/generation-avoidance, that needs its own pass against `docs.tuist.dev`.
2. **No primary source found stating that a *non-sandboxed* app's `posix_spawn` children are unconstrained.** The evidence is negative/structural (hardened runtime's exception list contains nothing about process spawning; sandbox inheritance is documented only for sandboxed apps). A definitive positive statement would need the `sandbox_init(3)` / `codesign(1)` man pages, which were not read.
3. **SwiftTerm's Metal renderer was inferred from the `Shaders.metal` processed resource in `Package.swift`, not from reading `Apple/Metal/*.swift`.** Whether it is default-on, opt-in, or experimental is unverified. Next step: read `Sources/SwiftTerm/Apple/AppleTerminalView.swift` and `Sources/SwiftTerm/Apple/Metal/`.
4. **`NSHostingView`/`NSHostingController` performance characteristics for many concurrent embedded terminal views** were not covered by any primary doc found. This is the single largest architectural unknown for the "many concurrent sessions" requirement and warrants a spike, not more reading.
5. **No primary Apple documentation exists on SwiftUI `Table` row-count scaling limits.** If Janela's session list can reach thousands of rows, prototype before committing.
6. **`Xcode 26` build-setting names for approachable concurrency** (`SWIFT_APPROACHABLE_CONCURRENCY`, `SWIFT_DEFAULT_ACTOR_ISOLATION`) could not be confirmed from the release notes JSON; only the SwiftPM/compiler-flag spellings from SE-0466 are verified. Since all logic lives in the SPM package, use `SwiftSetting.defaultIsolation` and avoid the Xcode setting entirely.
