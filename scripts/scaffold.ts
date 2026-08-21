#!/usr/bin/env bun
/**
 * One-shot scaffolder for the workspace's `package.json` and `tsconfig.json`
 * files, driven by `scripts/layers.ts` so the dependency edges in the manifest
 * and the ones in `package.json` cannot disagree on the day they are written.
 *
 * This exists so the graph is generated from the graph. It is not part of `check`
 * and is not expected to be run again — later edits are made by hand, and
 * `check:layers` is what keeps them honest.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { PACKAGES, type PackageSpec } from "./layers.ts";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

interface Extra {
  readonly description: string;
  readonly deps?: Record<string, string>;
  readonly devDeps?: Record<string, string>;
  readonly scripts?: Record<string, string>;
  readonly exports?: Record<string, unknown>;
  readonly jsx?: boolean;
  readonly dom?: boolean;
}

const EXTRAS: Record<string, Extra> = {
  "@janela/support": {
    description:
      "Logging, user-facing errors, timing marks, bounded buffers, and the one subprocess runner.",
    exports: {
      ".": "./src/index.ts",
      "./process": "./src/process.ts",
    },
  },
  "@janela/core": {
    description: "The domain model: project, session, terminal, launch profile. Pure, no I/O.",
  },
  "@janela/protocol": {
    description: "Frames, messages, handshake, and the transport seam both processes share.",
  },
  "@janela/git": {
    description: "Git, by way of the user's own git binary. Worktrees and .worktreeinclude.",
  },
  "@janela/pty": {
    description: "Pseudo-terminals and child processes. The hot path.",
    scripts: {
      "build:native": "cargo build --release --manifest-path native/Cargo.toml",
      clean: "cargo clean --manifest-path native/Cargo.toml && rm -rf dist *.tsbuildinfo",
    },
  },
  "@janela/db": {
    description: "The daemon's SQLite store: schema, migrations, repositories.",
    deps: { "@prisma/client": "7.9.1" },
    devDeps: { prisma: "7.9.1" },
    scripts: {
      generate: "prisma generate",
      migrate: "prisma migrate dev",
      "migrate:deploy": "prisma migrate deploy",
      clean: "rm -rf generated dist *.tsbuildinfo",
    },
  },
  "@janela/forge": {
    description: "GitHub and GitLab state, through the user's own gh and glab. Planned.",
  },
  "@janela/terminal": {
    description: "The daemon-side emulator: authoritative grid, damage tracking, repaint encoding.",
    deps: { "@xterm/addon-serialize": "0.14.0", "@xterm/headless": "6.0.0" },
  },
  "@janela/session": {
    description: "The brain: project and session lifecycle, automation, removal planning.",
  },
  "@janela/daemon": {
    description: "Listener, connections, subscriptions, peer-credential checks.",
  },
  "@janela/janelad": {
    description: "The daemon executable. Process plumbing only.",
    scripts: {
      build:
        "bun build --compile --minify --sourcemap --target=bun-darwin-arm64 --outfile janelad src/main.ts",
      dev: "bun run src/main.ts --foreground",
      clean: "rm -rf janelad dist *.tsbuildinfo",
    },
  },
  "@janela/client": {
    description: "The connection, the mirrored state a client renders, and the attention policy.",
  },
  "@janela/design": {
    description: "Tokens, semantic colours, and the small set of reusable controls.",
    deps: {
      "class-variance-authority": "0.7.1",
      clsx: "2.1.1",
      "lucide-react": "1.33.0",
      "tailwind-merge": "3.6.0",
    },
    devDeps: { react: "19.2.8", tailwindcss: "4.3.3" },
    jsx: true,
    dom: true,
  },
  "@janela/terminal-ui": {
    description: "The client-side terminal surface: a view that is fed escape sequences.",
    deps: { "@xterm/addon-fit": "0.11.0", "@xterm/addon-webgl": "0.19.0", "@xterm/xterm": "6.0.0" },
    devDeps: { react: "19.2.8" },
    jsx: true,
    dom: true,
  },
  "@janela/ui": {
    description: "Views and presentation state. Reaches no further than @janela/client.",
    devDeps: { react: "19.2.8", "react-dom": "19.2.8" },
    jsx: true,
    dom: true,
  },
  "@janela/desktop": {
    description: "The Tauri app: window, native menus, notifications, and the socket bridge.",
    deps: {
      "@tauri-apps/api": "2.11.1",
      "@tauri-apps/plugin-log": "2.9.0",
      "@tauri-apps/plugin-notification": "2.3.3",
      react: "19.2.8",
      "react-dom": "19.2.8",
    },
    devDeps: {
      "@tauri-apps/cli": "2.11.4",
      "@vitejs/plugin-react": "6.1.0",
      tailwindcss: "4.3.3",
      vite: "8.2.2",
    },
    scripts: {
      dev: "tauri dev",
      build: "vite build",
      bundle: "tauri build",
      clean: "rm -rf dist src-tauri/target *.tsbuildinfo",
    },
    jsx: true,
    dom: true,
  },
  "@janela/test-support": {
    description: "Temporary directories, throwaway git repositories, fakes. Not shipped.",
  },
};

function packageJson(pkg: PackageSpec, extra: Extra): string {
  const deps: Record<string, string> = { ...extra.deps };
  for (const dep of pkg.deps) deps[dep] = "workspace:*";

  const devDeps: Record<string, string> = { ...extra.devDeps };
  if (pkg.name !== "@janela/test-support") {
    devDeps["@janela/test-support"] = "workspace:*";
  }

  const scripts: Record<string, string> = {
    typecheck: "tsc --build",
    test: "bun test",
    ...extra.scripts,
  };
  if (!("clean" in scripts)) scripts["clean"] = "rm -rf dist *.tsbuildinfo";

  const json = {
    name: pkg.name,
    version: "0.0.0",
    private: true,
    type: "module",
    description: extra.description,
    exports: extra.exports ?? { ".": "./src/index.ts" },
    scripts: Object.fromEntries(Object.entries(scripts).toSorted(([a], [b]) => a.localeCompare(b))),
    ...(Object.keys(deps).length > 0
      ? {
          dependencies: Object.fromEntries(
            Object.entries(deps).toSorted(([a], [b]) => a.localeCompare(b)),
          ),
        }
      : {}),
    ...(Object.keys(devDeps).length > 0
      ? {
          devDependencies: Object.fromEntries(
            Object.entries(devDeps).toSorted(([a], [b]) => a.localeCompare(b)),
          ),
        }
      : {}),
  };
  return `${JSON.stringify(json, null, 2)}\n`;
}

function tsconfig(pkg: PackageSpec, extra: Extra): string {
  const depth = pkg.dir.split("/").length;
  const up = "../".repeat(depth);
  const references = pkg.deps
    .map((d) => PACKAGES.find((p) => p.name === d))
    .filter((p): p is PackageSpec => p !== undefined)
    .map((p) => ({ path: `${up}${p.dir}` }));
  if (pkg.name !== "@janela/test-support") {
    references.push({ path: `${up}packages/test-support` });
  }

  const lib = ["ES2023"];
  if (extra.dom === true) lib.push("DOM", "DOM.Iterable");

  const json = {
    extends: `${up}tsconfig.base.json`,
    compilerOptions: {
      lib,
      outDir: "dist",
      rootDir: "src",
      ...(extra.jsx === true ? { jsx: "react-jsx" } : {}),
      types: extra.dom === true ? ["bun"] : ["bun"],
    },
    include: ["src/**/*"],
    exclude: ["node_modules", "dist", "generated", "native/target", "src-tauri"],
    references,
  };
  return `${JSON.stringify(json, null, 2)}\n`;
}

for (const pkg of PACKAGES) {
  const extra = EXTRAS[pkg.name];
  if (!extra) throw new Error(`no scaffold entry for ${pkg.name}`);
  const dir = join(ROOT, pkg.dir);
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "package.json"), packageJson(pkg, extra));
  await writeFile(join(dir, "tsconfig.json"), tsconfig(pkg, extra));
  console.log(`scaffolded ${pkg.dir}`);
}
