/**
 * The bundle gate, against real `codesign`.
 *
 * Nothing here is faked: the behaviour under test *is* the signing tool's, and a fake
 * would only assert that we know what `codesign` does — which is exactly the
 * knowledge that turns out to be wrong when a bundle fails on a user's machine. Each
 * fixture is a miniature Janela.app in its own temporary directory, signed inside out
 * the way Tauri's bundler signs: sidecar, app executable, then the bundle.
 */
import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { temporaryDirectory } from "@janela/test-support";

import { LAUNCH_AGENT_PLIST, MAIN_EXECUTABLE, SIDECAR_BUNDLE_PROGRAM } from "./bundle-layout.ts";
import { expectationFromEnvironment, verifyBundle } from "./bundle-verification.ts";

const ENTITLEMENTS = new URL("../src-tauri/Entitlements.plist", import.meta.url).pathname;
const LAUNCH_AGENT = new URL("../src-tauri/launchd/sh.janela.janelad.plist", import.meta.url)
  .pathname;

/** Universal Mach-O, tiny, and already on every machine that can run this test. */
const SOME_EXECUTABLE = "/usr/bin/true";

const ADHOC = { expect: "adhoc", notarized: false } as const;

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>janela</string>
  <key>CFBundleIdentifier</key><string>sh.janela.Janela</string>
  <key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`;

function plistWith(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>sh.janela.janelad</string>
  <key>BundleProgram</key><string>Contents/MacOS/janelad</string>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
${body}</dict></plist>
`;
}

function entitlementsWith(keys: readonly string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
${keys.map((key) => `  <key>${key}</key><true/>`).join("\n")}
</dict></plist>
`;
}

interface SigningOptions {
  readonly runtime?: boolean;
  readonly entitlements?: string;
}

function sign(path: string, options: SigningOptions = {}): void {
  const command = ["codesign", "--force", "-s", "-"];
  if (options.runtime !== false) command.push("--options", "runtime");
  if (options.entitlements !== undefined) command.push("--entitlements", options.entitlements);
  command.push(path);

  const signed = Bun.spawnSync(command);
  if (signed.exitCode !== 0) {
    throw new Error(`codesign failed: ${new TextDecoder().decode(signed.stderr)}`);
  }
}

/** Signs sidecar, then app executable, then the bundle — the bundler's order. */
function signInsideOut(app: string, entitlements = ENTITLEMENTS): void {
  for (const relative of [SIDECAR_BUNDLE_PROGRAM, MAIN_EXECUTABLE, ""]) {
    sign(join(app, relative), { entitlements });
  }
}

interface FixtureOptions {
  /** Contents of the LaunchAgent plist. Omitted: the one the app actually ships. */
  readonly launchAgent?: string;
  /** Leave the plist out, so a test can add it after the bundle is signed. */
  readonly withoutLaunchAgent?: boolean;
  /** Contents of `Info.plist`. Omitted: one naming the executable the bundler writes. */
  readonly infoPlist?: string;
}

function buildApp(directory: string, options: FixtureOptions = {}): string {
  const app = join(directory, "Janela.app");
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
  mkdirSync(join(app, "Contents/Library/LaunchAgents"), { recursive: true });
  writeFileSync(join(app, "Contents/Info.plist"), options.infoPlist ?? INFO_PLIST);
  copyFileSync(SOME_EXECUTABLE, join(app, MAIN_EXECUTABLE));
  copyFileSync(SOME_EXECUTABLE, join(app, SIDECAR_BUNDLE_PROGRAM));

  if (options.withoutLaunchAgent !== true) {
    if (options.launchAgent === undefined)
      copyFileSync(LAUNCH_AGENT, join(app, LAUNCH_AGENT_PLIST));
    else writeFileSync(join(app, LAUNCH_AGENT_PLIST), options.launchAgent);
  }

  return app;
}

describe("verifyBundle", () => {
  test("accepts a bundle built and signed the way tauri build builds it", async () => {
    await using temporary = await temporaryDirectory("bundle-ok");
    const app = buildApp(temporary.path);
    signInsideOut(app);

    expect(verifyBundle(app, ADHOC)).toEqual([]);
  });

  test("rejects a bundle whose Info.plist names an executable the bundler did not write", async () => {
    // The trap this defends: macOS filesystems are case-insensitive by default, so a
    // capitalised `Contents/MacOS/Janela` opens fine here and vanishes on a
    // case-sensitive volume. Only the string comparison catches it.
    await using temporary = await temporaryDirectory("bundle-name");
    const app = buildApp(temporary.path, {
      infoPlist: INFO_PLIST.replace(
        "<key>CFBundleExecutable</key><string>janela</string>",
        "<key>CFBundleExecutable</key><string>Janela</string>",
      ),
    });
    signInsideOut(app);

    const problems = verifyBundle(app, ADHOC);

    expect(problems).toContain(
      'Contents/Info.plist: CFBundleExecutable is "Janela", expected "janela"',
    );
  });

  test("rejects a sidecar signed without the hardened runtime", async () => {
    await using temporary = await temporaryDirectory("bundle-runtime");
    const app = buildApp(temporary.path);
    signInsideOut(app);
    sign(join(app, SIDECAR_BUNDLE_PROGRAM), { runtime: false, entitlements: ENTITLEMENTS });
    sign(app, { entitlements: ENTITLEMENTS });

    const problems = verifyBundle(app, ADHOC);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("janelad");
    expect(problems[0]).toContain("hardened runtime");
  });

  test("rejects a sidecar that cannot load its PTY library", async () => {
    await using temporary = await temporaryDirectory("bundle-dlopen");
    const app = buildApp(temporary.path);
    const partial = temporary.join("jit-only.plist");
    writeFileSync(partial, entitlementsWith(["com.apple.security.cs.allow-jit"]));
    signInsideOut(app);
    sign(join(app, SIDECAR_BUNDLE_PROGRAM), { entitlements: partial });
    sign(app, { entitlements: ENTITLEMENTS });

    expect(verifyBundle(app, ADHOC)).toEqual([
      "Contents/MacOS/janelad: com.apple.security.cs.disable-library-validation is not granted",
    ]);
  });

  test("rejects a sandboxed executable", async () => {
    await using temporary = await temporaryDirectory("bundle-sandbox");
    const app = buildApp(temporary.path);
    const sandboxed = temporary.join("sandboxed.plist");
    writeFileSync(
      sandboxed,
      entitlementsWith([
        "com.apple.security.cs.allow-jit",
        "com.apple.security.cs.disable-library-validation",
        "com.apple.security.app-sandbox",
      ]),
    );
    signInsideOut(app);
    sign(join(app, SIDECAR_BUNDLE_PROGRAM), { entitlements: sandboxed });
    sign(app, { entitlements: ENTITLEMENTS });

    expect(verifyBundle(app, ADHOC)).toEqual([
      "Contents/MacOS/janelad: com.apple.security.app-sandbox must not be granted",
    ]);
  });

  test("rejects a LaunchAgent that brings back socket activation", async () => {
    await using temporary = await temporaryDirectory("bundle-sockets");
    const app = buildApp(temporary.path, {
      launchAgent: plistWith(`  <key>Sockets</key><dict><key>Listener</key><dict>
    <key>SockPathName</key><string>/Users/someone/.janela/run/janelad.sock</string>
  </dict></dict>
`),
    });
    signInsideOut(app);

    expect(verifyBundle(app, ADHOC)).toEqual([
      "Contents/Library/LaunchAgents/sh.janela.janelad.plist: Sockets must not be present",
    ]);
  });

  test("rejects a LaunchAgent that points the daemon's stdio at a path", async () => {
    await using temporary = await temporaryDirectory("bundle-stdio");
    // What someone reaches for when they want the daemon's log back on launchd's
    // side. launchd expands no `~`, and this plist is sealed once for every user
    // of the machine, so the path is either shared or somebody else's. The daemon
    // owns its log instead (#45).
    const app = buildApp(temporary.path, {
      launchAgent: plistWith(`  <key>StandardErrorPath</key><string>/tmp/janelad.log</string>
`),
    });
    signInsideOut(app);

    expect(verifyBundle(app, ADHOC)).toEqual([
      "Contents/Library/LaunchAgents/sh.janela.janelad.plist: StandardErrorPath must not be present",
    ]);
  });

  test("rejects a LaunchAgent written into the bundle after signing", async () => {
    await using temporary = await temporaryDirectory("bundle-unsealed");
    const app = buildApp(temporary.path, { withoutLaunchAgent: true });
    signInsideOut(app);
    // What registration would do if it generated the plist: the seal no longer
    // covers it, and `smd` refuses to load it (errSecCSBadResource).
    copyFileSync(LAUNCH_AGENT, join(app, LAUNCH_AGENT_PLIST));

    const problems = verifyBundle(app, ADHOC);

    expect(problems).toContain(
      "Contents/Library/LaunchAgents/sh.janela.janelad.plist: not sealed by the code signature",
    );
    expect(problems.some((problem) => problem.startsWith("the bundle:"))).toBe(true);
  });

  test("reports a missing bundle instead of pretending it passed", async () => {
    await using temporary = await temporaryDirectory("bundle-missing");
    const app = temporary.join("Janela.app");

    expect(verifyBundle(app, ADHOC)).toEqual([`no bundle at ${app}; run \`bun run bundle\``]);
  });
});

describe("expectationFromEnvironment", () => {
  test("a bare environment means the ad-hoc build CI produces", () => {
    expect(expectationFromEnvironment({})).toEqual({ expect: "adhoc", notarized: false });
    expect(expectationFromEnvironment({ APPLE_SIGNING_IDENTITY: "-" })).toEqual({
      expect: "adhoc",
      notarized: false,
    });
  });

  test("release credentials mean Developer ID and a stapled ticket", () => {
    expect(
      expectationFromEnvironment({
        APPLE_SIGNING_IDENTITY: "Developer ID Application: Someone (TEAM)",
        APPLE_ID: "someone@example.com",
        APPLE_PASSWORD: "app-specific",
        APPLE_TEAM_ID: "TEAM",
      }),
    ).toEqual({ expect: "developer-id", notarized: true });
  });

  test("a signing identity without notarization credentials is not claimed as notarized", () => {
    expect(
      expectationFromEnvironment({
        APPLE_SIGNING_IDENTITY: "Developer ID Application: Someone (TEAM)",
      }),
    ).toEqual({ expect: "developer-id", notarized: false });
  });
});
