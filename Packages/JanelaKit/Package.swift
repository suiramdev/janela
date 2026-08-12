// swift-tools-version: 6.2
//
// JanelaKit — all of Janela's logic lives here as a layered set of modules.
// The Xcode app target (see ../../project.yml) is a thin shell that depends on
// `JanelaApp` and does almost nothing itself.
//
// LAYERING RULE (enforced by the compiler through target dependencies):
//
//     Support  →  Core  →  Protocol
//                             ↙              ↘
//     ==== daemon ====                 ==== client ====
//     { Git, PTY, Persistence }        Client
//              ↓                          ↓
//         Terminal                    Design  →  TerminalUI
//              ↓                          ↓
//         Session                      UI  →  App
//              ↓
//         Daemon  →  janelad
//
// The two halves meet only at Core and Protocol. No client target may depend on a
// daemon target or vice versa — which is what makes a CLI possible without a
// refactor, and why JanelaUI cannot spawn a process even by accident.
// See docs/decisions/0015-daemon-owned-sessions.md.
//
// Dependencies point downward only. If you need an upward reference, you need a
// protocol in the lower layer instead. See docs/architecture.md.

import PackageDescription

// MARK: - Shared build settings

/// Applied to every first-party target.
///
/// `ExistentialAny` and `MemberImportVisibility` are upcoming features we opt into
/// early so the codebase never accumulates violations. `InternalImportsByDefault`
/// is deliberately *not* enabled — see docs/conventions.md for why.
let sharedSwiftSettings: [SwiftSetting] = [
    .enableUpcomingFeature("ExistentialAny"),
    .enableUpcomingFeature("MemberImportVisibility"),
    .swiftLanguageMode(.v6),
]

// MARK: - Package

let package = Package(
    name: "JanelaKit",
    platforms: [
        // macOS 15 is the floor: it is what SwiftUI needs for the window, focus and
        // toolbar APIs Janela relies on. See docs/decisions/0002-macos-deployment-target.md.
        .macOS(.v15)
    ],
    products: [
        // The single product the app target links. Everything else is internal
        // structure that we are free to reorganise without touching project.yml.
        .library(name: "JanelaApp", targets: ["JanelaApp"]),

        // Exposed individually so tests, previews and the `janela-dev` CLI can link
        // narrow slices without dragging in the UI.
        .library(name: "JanelaCore", targets: ["JanelaCore"]),
        .library(name: "JanelaProtocol", targets: ["JanelaProtocol"]),
        .library(name: "JanelaGit", targets: ["JanelaGit"]),
        .library(name: "JanelaTerminal", targets: ["JanelaTerminal"]),
        .library(name: "JanelaSession", targets: ["JanelaSession"]),
        .library(name: "JanelaClient", targets: ["JanelaClient"]),

        // The daemon binary. Ships inside Janela.app and is registered as a
        // LaunchAgent; see docs/decisions/0017-daemon-lifecycle.md.
        .executable(name: "janelad", targets: ["janelad"]),
    ],
    dependencies: [
        // SQLite persistence. Chosen over SwiftData for predictable performance,
        // explicit migrations and testability. See docs/decisions/0005-persistence.md.
        .package(url: "https://github.com/groue/GRDB.swift.git", from: "7.0.0"),

        // Terminal emulation (VT parsing + AppKit view). Kept behind the
        // `TerminalEmulating` protocol in JanelaTerminal so it can be replaced by a
        // Metal renderer or libghostty later. See docs/decisions/0004-terminal-engine.md.
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", from: "1.2.0"),
    ],
    targets: [

        // MARK: Layer 0 — Support
        // Zero domain knowledge. Logging, signposts, clocks, filesystem access,
        // error plumbing. Anything here must be usable from any other module.
        .target(
            name: "JanelaSupport",
            swiftSettings: sharedSwiftSettings
        ),

        // MARK: Layer 1 — Core
        // The domain model: value types, identifiers, and the protocols that upper
        // layers implement. No I/O, no frameworks beyond Foundation. Pure and
        // trivially testable — if something here needs a `try await`, it is probably
        // in the wrong module.
        .target(
            name: "JanelaCore",
            dependencies: ["JanelaSupport"],
            swiftSettings: sharedSwiftSettings
        ),

        // MARK: Layer 2 — Protocol
        // The vocabulary the two processes share: frames, messages, handshake, and
        // the transport seam. Pure and Codable, with no idea how either side is
        // implemented. Changing anything here is a wire-compatibility decision —
        // see docs/decisions/0016-daemon-protocol.md.
        .target(
            name: "JanelaProtocol",
            dependencies: ["JanelaSupport", "JanelaCore"],
            swiftSettings: sharedSwiftSettings
        ),

        // MARK: Layer 3 — Capabilities (daemon side)
        // Each of these owns exactly one external boundary and hides it completely.

        /// Git, by way of `/usr/bin/git`. Owns worktree creation, enumeration and
        /// removal. Never leaks a raw command string above its own API.
        .target(
            name: "JanelaGit",
            dependencies: ["JanelaSupport", "JanelaCore"],
            swiftSettings: sharedSwiftSettings
        ),

        /// Pseudo-terminals and child processes. The hot path: byte pumps, resizing,
        /// signal delivery, process reaping. No UI, no domain model, no third-party
        /// dependency — this is the part we must be able to profile in isolation.
        .target(
            name: "JanelaPTY",
            dependencies: ["JanelaSupport"],
            swiftSettings: sharedSwiftSettings
        ),

        /// The on-disk metadata store. Owns the schema and its migrations.
        .target(
            name: "JanelaPersistence",
            dependencies: [
                "JanelaSupport",
                "JanelaCore",
                .product(name: "GRDB", package: "GRDB.swift"),
            ],
            swiftSettings: sharedSwiftSettings
        ),

        // MARK: Layer 4 — Terminal (daemon side)
        // Binds a PTY to a *headless* emulator and owns the authoritative grid,
        // damage tracking and repaint encoding. Runs in janelad, never in a client;
        // the client's half of this seam is JanelaTerminalUI, which draws.
        // One of exactly two targets allowed to import SwiftTerm.
        .target(
            name: "JanelaTerminal",
            dependencies: [
                "JanelaSupport",
                "JanelaCore",
                "JanelaPTY",
                .product(name: "SwiftTerm", package: "SwiftTerm"),
            ],
            swiftSettings: sharedSwiftSettings
        ),

        // MARK: Layer 5 — Session (daemon side)
        // The application's brain. Composes Git + Terminal + Persistence into the
        // project and session lifecycle and project automation. Runs inside the
        // daemon, and deliberately does *not* import JanelaProtocol: it announces
        // change through a `StateObserving` protocol it owns, so it stays usable —
        // and testable — with no socket at all.
        .target(
            name: "JanelaSession",
            dependencies: [
                "JanelaSupport",
                "JanelaCore",
                "JanelaGit",
                "JanelaTerminal",
                "JanelaPersistence",
            ],
            swiftSettings: sharedSwiftSettings
        ),

        // MARK: Layer 6 — Daemon
        // Listener, connections, subscriptions, peer-credential checks. Thin on
        // purpose: what a message *means* belongs in JanelaSession.
        .target(
            name: "JanelaDaemon",
            dependencies: [
                "JanelaSupport",
                "JanelaCore",
                "JanelaProtocol",
                "JanelaSession",
                "JanelaTerminal",
            ],
            swiftSettings: sharedSwiftSettings
        ),

        // The daemon executable. Process plumbing only — socket activation, signal
        // handling, idle exit. Nothing here is worth testing, which is the point.
        .executableTarget(
            name: "janelad",
            dependencies: ["JanelaDaemon", "JanelaSupport"],
            swiftSettings: sharedSwiftSettings
        ),

        // MARK: Layer 6 — Client
        // The connection, the mirrored @Observable state the UI reads, and the
        // attention policy — which lives here rather than in the daemon because only
        // a client knows what is focused. See docs/decisions/0011-notifications.md.
        .target(
            name: "JanelaClient",
            dependencies: ["JanelaSupport", "JanelaCore", "JanelaProtocol"],
            swiftSettings: sharedSwiftSettings
        ),

        // MARK: Layer 7 — Design
        // Tokens, typography, spacing, and the small set of reusable controls.
        // Knows nothing about projects or sessions; it could be lifted into
        // another app.
        .target(
            name: "JanelaDesign",
            dependencies: ["JanelaSupport"],
            resources: [.process("Resources")],
            swiftSettings: sharedSwiftSettings
        ),

        // The client half of the terminal seam: a surface that draws the bytes the
        // daemon sends. The second and last target allowed to import SwiftTerm.
        .target(
            name: "JanelaTerminalUI",
            dependencies: [
                "JanelaCore",
                "JanelaProtocol",
                "JanelaDesign",
                .product(name: "SwiftTerm", package: "SwiftTerm"),
            ],
            swiftSettings: sharedSwiftSettings
        ),

        // MARK: Layer 8 — Feature UI
        // SwiftUI views and presentation state. Note what is absent: Git, PTY,
        // Persistence, Terminal and Session are daemon-side and are not linked here.
        // The app cannot spawn a process — the capability is not discouraged, it is
        // not present.
        .target(
            name: "JanelaUI",
            dependencies: [
                "JanelaCore",
                "JanelaProtocol",
                "JanelaClient",
                "JanelaDesign",
                "JanelaTerminalUI",
            ],
            swiftSettings: sharedSwiftSettings
        ),

        // MARK: Layer 9 — App
        // Composition root: builds the client object graph, defines the `App` scene,
        // menus and commands, registers the LaunchAgent via SMAppService, and adapts
        // attention policy onto UNUserNotificationCenter. The Xcode target is a shell
        // around this.
        .target(
            name: "JanelaApp",
            dependencies: [
                "JanelaSupport",
                "JanelaCore",
                "JanelaProtocol",
                "JanelaClient",
                "JanelaUI",
                "JanelaTerminalUI",
            ],
            swiftSettings: sharedSwiftSettings
        ),

        // MARK: - Tests
        // One test target per module that has behaviour worth pinning down.
        // Naming and structure conventions live in docs/testing.md.
        .testTarget(
            name: "JanelaCoreTests",
            dependencies: ["JanelaCore"],
            swiftSettings: sharedSwiftSettings
        ),
        .testTarget(
            name: "JanelaGitTests",
            dependencies: ["JanelaGit", "JanelaTestSupport"],
            swiftSettings: sharedSwiftSettings
        ),
        .testTarget(
            name: "JanelaPTYTests",
            dependencies: ["JanelaPTY", "JanelaTestSupport"],
            swiftSettings: sharedSwiftSettings
        ),
        .testTarget(
            name: "JanelaPersistenceTests",
            dependencies: ["JanelaPersistence", "JanelaTestSupport"],
            swiftSettings: sharedSwiftSettings
        ),
        .testTarget(
            name: "JanelaTerminalTests",
            dependencies: ["JanelaTerminal", "JanelaTestSupport"],
            swiftSettings: sharedSwiftSettings
        ),
        .testTarget(
            name: "JanelaSessionTests",
            dependencies: ["JanelaSession", "JanelaTestSupport"],
            swiftSettings: sharedSwiftSettings
        ),
        .testTarget(
            name: "JanelaProtocolTests",
            dependencies: ["JanelaProtocol"],
            swiftSettings: sharedSwiftSettings
        ),
        .testTarget(
            name: "JanelaDaemonTests",
            dependencies: ["JanelaDaemon", "JanelaTestSupport"],
            swiftSettings: sharedSwiftSettings
        ),
        .testTarget(
            name: "JanelaClientTests",
            dependencies: ["JanelaClient", "JanelaTestSupport"],
            swiftSettings: sharedSwiftSettings
        ),

        /// Shared test helpers: temporary directories, throwaway git repositories,
        /// fake clocks. Not shipped in the app.
        .target(
            name: "JanelaTestSupport",
            dependencies: ["JanelaSupport", "JanelaCore"],
            swiftSettings: sharedSwiftSettings
        ),
    ]
)
