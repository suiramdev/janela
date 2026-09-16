#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { PACKAGES, type PackageSpec } from "./layers.ts";

interface Extra {
  readonly description: string;
  readonly deps?: Record<string, string>;
  readonly devDeps?: Record<string, string>;
  readonly scripts?: Record<string, string>;
  readonly exports?: Record<string, string>;
  readonly jsx?: boolean;
  readonly dom?: boolean;
}

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly private: boolean;
  readonly type: string;
  readonly description: string;
  readonly exports: Record<string, string>;
  readonly scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface TsconfigOptions {
  readonly lib: readonly string[];
  readonly outDir: string;
  readonly rootDir: string;
  readonly types: readonly string[];
  jsx?: string;
}

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const EXTRAS = {
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

function sortedRecord(values: Map<string, string>): Record<string, string> {
  return Object.fromEntries([...values].toSorted(([one], [other]) => one.localeCompare(other)));
}

function packageJson(pkg: PackageSpec, extra: Extra): string {
  const deps = new Map(Object.entries(extra.deps ?? {}));

  for (const dep of pkg.deps) deps.set(dep, "workspace:*");

  const devDeps = new Map(Object.entries(extra.devDeps ?? {}));

  if (pkg.name !== "@janela/test-support") {
    devDeps.set("@janela/test-support", "workspace:*");
  }

  const scripts = new Map<string, string>([
    ["typecheck", "tsc --build"],
    ["test", "bun test"],
    ...Object.entries(extra.scripts ?? {}),
  ]);

  if (!scripts.has("clean")) scripts.set("clean", "rm -rf dist *.tsbuildinfo");

  const json: PackageManifest = {
    name: pkg.name,
    version: "0.0.0",
    private: true,
    type: "module",
    description: extra.description,
    exports: extra.exports ?? { ".": "./src/index.ts" },
    scripts: sortedRecord(scripts),
  };

  if (deps.size > 0) json.dependencies = sortedRecord(deps);

  if (devDeps.size > 0) json.devDependencies = sortedRecord(devDeps);

  return `${JSON.stringify(json, null, 2)}\n`;
}

function tsconfig(pkg: PackageSpec, extra: Extra): string {
  const depth = pkg.dir.split("/").length;
  const up = "../".repeat(depth);

  const references = pkg.deps.flatMap((dep) => {
    const target = PACKAGES.find((candidate) => candidate.name === dep);

    return target === undefined ? [] : [{ path: `${up}${target.dir}` }];
  });

  if (pkg.name !== "@janela/test-support") {
    references.push({ path: `${up}packages/test-support` });
  }

  const lib = ["ES2023"];

  if (extra.dom === true) lib.push("DOM", "DOM.Iterable");

  const compilerOptions: TsconfigOptions = {
    lib,
    outDir: "dist",
    rootDir: "src",
    types: ["bun"],
  };

  if (extra.jsx === true) compilerOptions.jsx = "react-jsx";

  const json = {
    extends: `${up}tsconfig.base.json`,
    compilerOptions,
    include: ["src/**/*"],
    exclude: ["node_modules", "dist", "generated", "native/target", "src-tauri"],
    references,
  };

  return `${JSON.stringify(json, null, 2)}\n`;
}

async function main(): Promise<void> {
  const uncovered = PACKAGES.filter((pkg) => !Object.hasOwn(EXTRAS, pkg.name));

  if (uncovered.length > 0) {
    throw new Error(`no scaffold entry for ${uncovered.map((pkg) => pkg.name).join(", ")}`);
  }

  for (const [name, extra] of Object.entries(EXTRAS)) {
    const pkg = PACKAGES.find((candidate) => candidate.name === name);

    if (pkg === undefined) throw new Error(`${name} has a scaffold entry but no manifest entry`);

    const dir = join(ROOT, pkg.dir);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "package.json"), packageJson(pkg, extra));
    await writeFile(join(dir, "tsconfig.json"), tsconfig(pkg, extra));
    console.log(`scaffolded ${pkg.dir}`);
  }
}

await main();
