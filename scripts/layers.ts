export type Side = "shared" | "daemon" | "client" | "tool";

export interface PackageSpec {
  readonly name: string;
  readonly dir: string;
  readonly layer: number;
  readonly side: Side;
  readonly deps: readonly string[];
  readonly planned?: boolean;
}

export interface GatedModule {
  readonly pattern: string;
  readonly allowed: readonly string[];
  readonly reason: string;
}

export const PACKAGES: readonly PackageSpec[] = [
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
    deps: [
      "@janela/support",
      "@janela/core",
      "@janela/protocol",
      "@janela/git",
      "@janela/pty",
      "@janela/db",
      "@janela/terminal",
      "@janela/session",
      "@janela/daemon",
    ],
  },
  {
    name: "@janela/gateway",
    dir: "apps/gateway",
    layer: 7,
    side: "daemon",
    deps: ["@janela/support", "@janela/protocol", "@janela/daemon"],
  },

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
      "@janela/support",
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
  {
    name: "@janela/web",
    dir: "apps/web",
    layer: 10,
    side: "client",
    deps: ["@janela/support", "@janela/protocol", "@janela/client", "@janela/design", "@janela/ui"],
  },

  {
    name: "@janela/test-support",
    dir: "packages/test-support",
    layer: 0,
    side: "tool",
    deps: [],
  },
];

export const GATED_MODULES: readonly GatedModule[] = [
  {
    pattern: "@xterm/headless",
    allowed: ["@janela/terminal"],
    reason:
      "The daemon-side emulator seam. Nothing above @janela/terminal may know which library holds the grid — that is the whole cost of swapping engines later.",
  },
  {
    pattern: "@xterm/addon-serialize",
    allowed: ["@janela/terminal"],
    reason:
      "Serialise-for-attach is part of the TerminalEmulating seam, not a utility anyone may reach for.",
  },
  {
    pattern: "@xterm/xterm",
    allowed: ["@janela/terminal-ui"],
    reason:
      "The client-side rendering seam. Two seams, one library family, one rule — the rule did not change when the daemon arrived, there are simply two places it applies.",
  },
  {
    pattern: "@xterm/addon-*",
    allowed: ["@janela/terminal-ui", "@janela/terminal"],
    reason: "Terminal addons belong to whichever of the two seams owns that side.",
  },
  {
    pattern: "bun:ffi",
    allowed: ["@janela/pty"],
    reason:
      "The only FFI surface in the system. A second one is a second native artifact to build, sign and locate.",
  },
  {
    pattern: "bun:sqlite",
    allowed: ["@janela/db"],
    reason:
      "The database is daemon-private and @janela/db is its only door. A second opener means two sources of truth.",
  },
  {
    pattern: "@prisma/client",
    allowed: ["@janela/db"],
    reason:
      "Prisma is an implementation detail of @janela/db. A generated client type in a service signature is a leaked schema.",
  },
  {
    pattern: "@prisma/driver-adapter-utils",
    allowed: ["@janela/db"],
    reason:
      "The driver adapter's types and constants. Same door as @prisma/client: a Prisma column type or adapter error in a signature above @janela/db is a leaked schema.",
  },
  {
    pattern: "node:child_process",
    allowed: ["@janela/support"],
    reason:
      "One subprocess runner, taking an argument array, with no shell — so the quoting bug class does not exist. @janela/git and @janela/forge share it rather than each spawning their own.",
  },
  {
    pattern: "node:net",
    allowed: ["@janela/daemon", "@janela/janelad", "@janela/gateway"],
    reason:
      "The daemon owns the listener. A client reaches the socket through the Tauri shell, because a WebView cannot open a Unix socket. `apps/daemon` binds the path and hands the bound server down, because socket activation was given up and there is no descriptor to inherit (#39, 2026-09-08) — `@janela/daemon` still never binds and never chooses a path. `apps/gateway` is the browser's Tauri shell: it opens the socket because a browser cannot, and relays bytes it never reads.",
  },
  {
    pattern: "react",
    allowed: [
      "@janela/design",
      "@janela/terminal-ui",
      "@janela/ui",
      "@janela/desktop",
      "@janela/web",
    ],
    reason:
      "Nothing in @janela/session or below may import a view layer. The daemon detects, the client decides, the app delivers.",
  },
  {
    pattern: "@base-ui/react",
    allowed: ["@janela/design"],
    reason:
      "The primitive seam, and the same rule as @xterm/*: one package names the library that owns focus, portals and dismissal, and everything above it composes what @janela/design exports. A view that imports a primitive directly is a view that has to be rewritten when the library does.",
  },
  {
    pattern: "cn",
    allowed: ["@janela/design"],
    reason:
      "One Tailwind class merger, in the package that owns the classes. Two of them resolve conflicting utilities by different rules, and nothing would tell you which one a control used — so @janela/design re-exports `cn` and nobody installs a second.",
  },
  {
    pattern: "framer-motion",
    allowed: ["@janela/design"],
    reason:
      "The motion seam, and the same rule as @base-ui/react: one package names the library, and everything above composes what @janela/design exports. It arrived with Fluid Hover, whose highlight needs a spring; a view that animates by hand instead grows a second motion dialect, and the terminal path must stay free of per-frame React work (docs/performance.md).",
  },
  {
    pattern: "monaco-editor*",
    allowed: ["@janela/design"],
    reason:
      "The code-editor seam, same rule as @xterm/* and @base-ui/react: one package names the library. It arrived for the automation scripts, is loaded only when a script editor mounts, and everything above composes ShellScriptEditor.",
  },
  {
    pattern: "react-dom",
    allowed: ["@janela/ui", "@janela/desktop", "@janela/web"],
    reason:
      "Mounting is the composition root's job, and @janela/ui's own tests. Nothing lower renders itself.",
  },
  {
    pattern: "@tauri-apps/*",
    allowed: ["@janela/desktop"],
    reason:
      "Tauri is the shell, not the architecture. @janela/client stays transport-agnostic so a browser client is a new transport rather than a rewrite.",
  },
  {
    pattern: "@janela/support/process",
    allowed: [
      "@janela/git",
      "@janela/forge",
      "@janela/pty",
      "@janela/session",
      "@janela/janelad",
      "@janela/gateway",
    ],
    reason:
      "@janela/support is isomorphic so a browser client can link it; its subprocess half is daemon-only and lives behind this subpath.",
  },
];

export const PACKAGE_BY_NAME: ReadonlyMap<string, PackageSpec> = new Map(
  PACKAGES.map((p) => [p.name, p]),
);
