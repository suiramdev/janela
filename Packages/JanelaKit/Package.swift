// swift-tools-version: 6.2
//
// JanelaKit — all of Janela's logic lives here as a layered set of modules.
// The Xcode app target (see ../../project.yml) is a thin shell that depends on
// `JanelaApp` and does almost nothing itself.
//
// LAYERING RULE (enforced by the compiler through target dependencies):
//
//     Support  →  Core  →  { Git, PTY, Persistence }  →  Terminal
//                                                          ↓
//                                                      Workspace
//                                                          ↓
//                                          Design  →  Feature UI  →  App
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
        .library(name: "JanelaGit", targets: ["JanelaGit"]),
        .library(name: "JanelaTerminal", targets: ["JanelaTerminal"]),
        .library(name: "JanelaWorkspace", targets: ["JanelaWorkspace"]),
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

        // MARK: Layer 2 — Capabilities
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

        // MARK: Layer 3 — Terminal
        // Binds a PTY to an emulator and exposes a session you can attach a view to.
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

        // MARK: Layer 4 — Workspace
        // The application's brain. Composes Git + Terminal + Persistence into the
        // workspace lifecycle. This is where product behaviour lives, and it is
        // deliberately UI-free so it can be tested without a window server.
        .target(
            name: "JanelaWorkspace",
            dependencies: [
                "JanelaSupport",
                "JanelaCore",
                "JanelaGit",
                "JanelaTerminal",
                "JanelaPersistence",
            ],
            swiftSettings: sharedSwiftSettings
        ),

        // MARK: Layer 5 — Design
        // Tokens, typography, spacing, and the small set of reusable controls.
        // Knows nothing about workspaces; it could be lifted into another app.
        .target(
            name: "JanelaDesign",
            dependencies: ["JanelaSupport"],
            resources: [.process("Resources")],
            swiftSettings: sharedSwiftSettings
        ),

        // MARK: Layer 6 — Feature UI
        // SwiftUI views and observable presentation state. Talks to JanelaWorkspace
        // through its services; never reaches past it into Git or PTY directly.
        .target(
            name: "JanelaUI",
            dependencies: [
                "JanelaCore",
                "JanelaDesign",
                "JanelaTerminal",
                "JanelaWorkspace",
            ],
            swiftSettings: sharedSwiftSettings
        ),

        // MARK: Layer 7 — App
        // Composition root: builds the object graph, defines the `App` scene, menus
        // and commands. The Xcode target is a shell around this.
        .target(
            name: "JanelaApp",
            dependencies: [
                "JanelaSupport",
                "JanelaGit",
                "JanelaTerminal",
                "JanelaUI",
                "JanelaWorkspace",
                "JanelaPersistence",
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
            name: "JanelaWorkspaceTests",
            dependencies: ["JanelaWorkspace", "JanelaTestSupport"],
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
