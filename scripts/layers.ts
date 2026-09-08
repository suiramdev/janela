/**
 * The module graph, as data.
 *
 * This graph used to live in a package manifest that a compiler read, so an illegal
 * import was a build error rather than a review comment. Nothing in TypeScript does
 * that for us — worse, Bun hoists `node_modules`, so a package can
 * `import "@janela/pty"` and have it *resolve* without ever declaring it.
 *
 * So the graph is written down here, once, and `check-layers.ts` enforces it.
 * This file is the single source of truth: `docs/architecture.md` § Packages
 * describes it in prose, and `.oxlintrc.json` restates the coarse side-level half
 * of it for editor feedback, but if they disagree, this file is right and the
 * others are stale.
 *
 * See docs/decisions/0022-layering-enforcement.md.
 */

/** Which process a package belongs to. */
export type Side =
  /** Links into both processes. Pure, and it may import from neither side. */
  | "shared"
  /** Runs inside `janelad`. Owns PTYs, git, the database, the emulator. */
  | "daemon"
  /** Runs inside a client. Renders a mirror; cannot spawn anything. */
  | "client"
  /** Not shipped. Test helpers and build tooling. */
  | "tool";

export interface PackageSpec {
  /** Workspace name, as it appears in an import. */
  readonly name: string;
  /** Directory relative to the repository root. */
  readonly dir: string;
  /**
   * Layer index. A dependency must have a *strictly lower* layer than its
   * dependent — that is what "dependencies point downward only" means once the
   * compiler has stopped saying it for us. Peers share a layer and therefore
   * cannot depend on each other, which is how `git` and `forge` stay apart.
   */
  readonly layer: number;
  readonly side: Side;
  /** Every first-party package this one may import. Exhaustive. */
  readonly deps: readonly string[];
  /** Designed and documented, but not yet implemented. */
  readonly planned?: boolean;
}

/**
 * Layer order, and the reason each boundary is where it is.
 *
 *   0  support        logging, errors, timing, bounded buffers, subprocess
 *   1  core           domain types. Pure. No I/O.
 *   2  protocol       wire messages, framing, handshake, transport seam
 *          ╭──────────────────────── daemon ────────────────────────╮
 *   3      git   pty   db   forge
 *   4      terminal                     (headless emulator + repaint encoder)
 *   5      session                      (the brain)
 *   6      daemon  →  apps/daemon       (listener, then the executable)
 *          ╰────────────────────────────────────────────────────────╯
 *          ╭──────────────────────── client ────────────────────────╮
 *   6      client                       (connection, mirror, attention policy)
 *   7      design                       (tokens and reusable controls)
 *   8      terminal-ui                  (the surface, fed escape sequences)
 *   9      ui
 *  10      apps/desktop                 (composition root)
 *          ╰────────────────────────────────────────────────────────╯
 *
 * The two halves meet only at `core` and `protocol`.
 */
export const PACKAGES: readonly PackageSpec[] = [
  // ---- Shared ---------------------------------------------------------------
  {
    name: "@janela/support",
    dir: "packages/support",
    layer: 0,
    side: "shared",
    deps: [],
  },
  {
    name: "@janela/core",
    dir: "packages/core",
    layer: 1,
    side: "shared",
    deps: ["@janela/support"],
  },
  {
    name: "@janela/protocol",
    dir: "packages/protocol",
    layer: 2,
    side: "shared",
    deps: ["@janela/support", "@janela/core"],
  },

  // ---- Daemon: one external boundary each, hidden completely ----------------
  {
    name: "@janela/git",
    dir: "packages/git",
    layer: 3,
    side: "daemon",
    deps: ["@janela/support", "@janela/core"],
  },
  {
    name: "@janela/pty",
    dir: "packages/pty",
    layer: 3,
    side: "daemon",
    deps: ["@janela/support"],
  },
  {
    name: "@janela/db",
    dir: "packages/db",
    layer: 3,
    side: "daemon",
    deps: ["@janela/support", "@janela/core"],
  },
  {
    name: "@janela/forge",
    dir: "packages/forge",
    layer: 3,
    side: "daemon",
    deps: ["@janela/support", "@janela/core"],
  },
  {
    name: "@janela/terminal",
    dir: "packages/terminal",
    layer: 4,
    side: "daemon",
    deps: ["@janela/support", "@janela/core", "@janela/pty"],
  },
  {
    name: "@janela/session",
    dir: "packages/session",
    layer: 5,
    side: "daemon",
    deps: [
      "@janela/support",
      "@janela/core",
      "@janela/git",
      "@janela/db",
      "@janela/terminal",
      "@janela/forge",
    ],
  },
  {
    name: "@janela/daemon",
    dir: "packages/daemon",
    layer: 6,
    side: "daemon",
    deps: [
      "@janela/support",
      "@janela/core",
      "@janela/protocol",
      "@janela/session",
      "@janela/terminal",
    ],
  },
  {
    name: "@janela/janelad",
    dir: "apps/daemon",
    layer: 7,
    side: "daemon",
    deps: ["@janela/support", "@janela/daemon", "@janela/db"],
  },

  // ---- Client ---------------------------------------------------------------
  {
    name: "@janela/client",
    dir: "packages/client",
    layer: 6,
    side: "client",
    deps: ["@janela/support", "@janela/core", "@janela/protocol"],
  },
  {
    name: "@janela/design",
    dir: "packages/design",
    layer: 7,
    side: "client",
    deps: ["@janela/support"],
  },
  {
    name: "@janela/terminal-ui",
    dir: "packages/terminal-ui",
    layer: 8,
    side: "client",
    deps: ["@janela/core", "@janela/protocol", "@janela/design"],
  },
  {
    name: "@janela/ui",
    dir: "packages/ui",
    layer: 9,
    side: "client",
    deps: [
      "@janela/core",
      "@janela/protocol",
      "@janela/client",
      "@janela/design",
      "@janela/terminal-ui",
    ],
  },
  {
    name: "@janela/desktop",
    dir: "apps/desktop",
    layer: 10,
    side: "client",
    deps: [
      "@janela/support",
      "@janela/core",
      "@janela/protocol",
      "@janela/client",
      "@janela/design",
      "@janela/terminal-ui",
      "@janela/ui",
    ],
  },

  // ---- Not shipped ----------------------------------------------------------
  {
    // Layer 0 and dependency-free, deliberately. Every package's tests link it,
    // including `@janela/support`'s own, so a first-party dependency here would be
    // a cycle in the project-reference graph — and a test helper that needs the
    // thing under test is a test helper that cannot test it. The fakes are typed
    // structurally for the same reason.
    name: "@janela/test-support",
    dir: "packages/test-support",
    layer: 0,
    side: "tool",
    deps: [],
  },
];

/**
 * External modules that exactly one place is allowed to import.
 *
 * Each of these is a decision with an ADR behind it, and each is a boundary that
 * erodes the moment a second importer appears. There used to be one such rule —
 * only two modules could link the terminal library — and it was enforced by
 * declaring that dependency on exactly two of them. Here every dependency resolves
 * everywhere, so each rule needs teeth of its own.
 */
export interface GatedModule {
  /** Import specifier, or a prefix ending in `*`. */
  readonly pattern: string;
  /** Packages permitted to import it, by name. */
  readonly allowed: readonly string[];
  /** Why, in one sentence, with the ADR that decided it. */
  readonly reason: string;
}

export const GATED_MODULES: readonly GatedModule[] = [
  {
    pattern: "@xterm/headless",
    allowed: ["@janela/terminal"],
    reason:
      "The daemon-side emulator seam. Nothing above @janela/terminal may know which library holds the grid — that is the whole cost of swapping engines later (ADR 0018).",
  },
  {
    pattern: "@xterm/addon-serialize",
    allowed: ["@janela/terminal"],
    reason:
      "Serialise-for-attach is part of the TerminalEmulating seam, not a utility anyone may reach for (ADR 0018).",
  },
  {
    pattern: "@xterm/xterm",
    allowed: ["@janela/terminal-ui"],
    reason:
      "The client-side rendering seam. Two seams, one library family, one rule — the rule did not change when the daemon arrived, there are simply two places it applies (ADR 0018).",
  },
  {
    pattern: "@xterm/addon-*",
    allowed: ["@janela/terminal-ui", "@janela/terminal"],
    reason: "Terminal addons belong to whichever of the two seams owns that side (ADR 0018).",
  },
  {
    pattern: "bun:ffi",
    allowed: ["@janela/pty"],
    reason:
      "The only FFI surface in the system. A second one is a second native artifact to build, sign and locate (ADR 0021).",
  },
  {
    pattern: "bun:sqlite",
    allowed: ["@janela/db"],
    reason:
      "The database is daemon-private and @janela/db is its only door. A second opener means two sources of truth (ADR 0019).",
  },
  {
    pattern: "@prisma/client",
    allowed: ["@janela/db"],
    reason:
      "Prisma is an implementation detail of @janela/db. A generated client type in a service signature is a leaked schema (ADR 0019).",
  },
  {
    pattern: "@prisma/driver-adapter-utils",
    allowed: ["@janela/db"],
    reason:
      "The driver adapter's types and constants. Same door as @prisma/client: a Prisma column type or adapter error in a signature above @janela/db is a leaked schema (ADR 0019).",
  },
  {
    pattern: "node:child_process",
    allowed: ["@janela/support"],
    reason:
      "One subprocess runner, taking an argument array, with no shell — so the quoting bug class does not exist. @janela/git and @janela/forge share it rather than each spawning their own (ADR 0007).",
  },
  {
    pattern: "node:net",
    allowed: ["@janela/daemon"],
    reason:
      "The daemon owns the listener. A client reaches the socket through the Tauri shell, because a WebView cannot open a Unix socket (ADR 0016).",
  },
  {
    pattern: "react",
    allowed: ["@janela/design", "@janela/terminal-ui", "@janela/ui", "@janela/desktop"],
    reason:
      "Nothing in @janela/session or below may import a view layer. The daemon detects, the client decides, the app delivers (ADR 0011).",
  },
  {
    pattern: "react-dom",
    allowed: ["@janela/ui", "@janela/desktop"],
    reason:
      "Mounting is the composition root's job, and @janela/ui's own tests. Nothing lower renders itself.",
  },
  {
    pattern: "@tauri-apps/*",
    allowed: ["@janela/desktop"],
    reason:
      "Tauri is the shell, not the architecture. @janela/client stays transport-agnostic so a browser client is a new transport rather than a rewrite (ADR 0023).",
  },
  {
    pattern: "@janela/support/process",
    allowed: ["@janela/git", "@janela/forge", "@janela/pty", "@janela/session", "@janela/janelad"],
    reason:
      "@janela/support is isomorphic so a browser client can link it; its subprocess half is daemon-only and lives behind this subpath (ADR 0023).",
  },
];

export const PACKAGE_BY_NAME: ReadonlyMap<string, PackageSpec> = new Map(
  PACKAGES.map((p) => [p.name, p]),
);
