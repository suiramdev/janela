/**
 * Checks a built Janela.app against the layout, the signature and the entitlements
 * the daemon needs — the things that fail on a user's machine at install time and
 * never in a compiler.
 *
 * Four failures this exists to catch, each of which passes `cargo build` and
 * `tauri build` happily:
 *
 * 1. the sidecar unsigned, or signed without the hardened runtime — notarization
 *    rejects it, and `SMAppService.register()` refuses it;
 * 2. the entitlements missing — the daemon then runs interpreted (47x slower) or
 *    cannot `dlopen` its PTY library at all;
 * 3. the LaunchAgent plist absent from the code signature's sealed resources —
 *    `smd` refuses to load a plist whose bundle fails a static signature check
 *    (`errSecCSBadResource`, -67054);
 * 4. the sidecar in `Contents/Resources`, where Tauri's bundler does not sign it.
 *
 * Nothing here prints or exits; `verify-bundle.ts` is the command. Every check runs
 * even after an earlier one fails, so one run lists everything wrong with a bundle.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  FORBIDDEN_ENTITLEMENTS,
  FORBIDDEN_LAUNCH_AGENT_KEYS,
  LAUNCH_AGENT_LABEL,
  LAUNCH_AGENT_PLIST,
  LAUNCH_AGENT_SEALED_RESOURCE,
  MAIN_EXECUTABLE,
  MAIN_EXECUTABLE_NAME,
  MISPLACED_SIDECAR,
  REQUIRED_ENTITLEMENTS,
  SIDECAR_BUNDLE_PROGRAM,
} from "./bundle-layout.ts";

/** What the bundle was signed with, which decides how strict the signature check is. */
export type SignatureExpectation = "adhoc" | "developer-id";

export interface VerificationOptions {
  readonly expect: SignatureExpectation;
  /** Also require a stapled notarization ticket and Gatekeeper acceptance. */
  readonly notarized: boolean;
}

/**
 * Reads the same environment Tauri's bundler reads, so the gate expects exactly what
 * the build it just ran was able to do.
 *
 * `APPLE_SIGNING_IDENTITY` overrides `bundle.macOS.signingIdentity`, and Tauri
 * requires it to be set explicitly when `APPLE_CERTIFICATE` is used. Notarization
 * mirrors Tauri's own credential lookup: Apple ID + app-specific password + team, or
 * an App Store Connect API key.
 */
export function expectationFromEnvironment(
  env: Record<string, string | undefined>,
): VerificationOptions {
  const identity = env["APPLE_SIGNING_IDENTITY"];
  const developerId =
    (identity !== undefined && identity !== "" && identity !== "-") ||
    (env["APPLE_CERTIFICATE"] ?? "") !== "";
  const notarized =
    ((env["APPLE_ID"] ?? "") !== "" &&
      (env["APPLE_PASSWORD"] ?? "") !== "" &&
      (env["APPLE_TEAM_ID"] ?? "") !== "") ||
    ((env["APPLE_API_KEY"] ?? "") !== "" && (env["APPLE_API_ISSUER"] ?? "") !== "");

  return { expect: developerId ? "developer-id" : "adhoc", notarized: developerId && notarized };
}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
}

/**
 * Runs a macOS tool. A missing tool throws rather than becoming a problem: there is
 * no fallback for `codesign`, and reporting "the bundle is unsigned" because the
 * verifier could not look would be a lie.
 */
function run(command: string[], stdin?: Uint8Array): CommandResult {
  const [tool] = command;
  if (tool === undefined) throw new Error("run() needs a command");
  if (Bun.which(tool) === null) {
    throw new Error(`\`${tool}\` is not on PATH; the Xcode command line tools are required`);
  }

  const spawned =
    stdin === undefined
      ? Bun.spawnSync(command)
      : Bun.spawnSync(command, { stdin: Buffer.from(stdin) });

  return {
    exitCode: spawned.exitCode,
    stdout: spawned.stdout,
    stderr: new TextDecoder().decode(spawned.stderr),
  };
}

/** `plutil`'s JSON rendering of a plist file, or `undefined` if it is not one. */
function readPlist(path: string): Record<string, unknown> | undefined {
  const converted = run(["plutil", "-convert", "json", "-o", "-", path]);
  if (converted.exitCode !== 0) return undefined;

  return asObject(new TextDecoder().decode(converted.stdout));
}

function asObject(json: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Thin Mach-O in either endianness, or a universal binary. `/usr/bin/true` — what the
 * tests copy — is universal, and a release `janelad` is thin, so both count.
 */
const MACH_O_MAGIC = new Set([0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

function isMachO(path: string): boolean {
  const descriptor = openSync(path, "r");
  try {
    const header = Buffer.alloc(4);
    if (readSync(descriptor, header, 0, 4, 0) < 4) return false;
    return MACH_O_MAGIC.has(header.readUInt32BE(0));
  } finally {
    closeSync(descriptor);
  }
}

function checkLayout(app: string, problems: string[]): void {
  for (const relative of [MAIN_EXECUTABLE, SIDECAR_BUNDLE_PROGRAM]) {
    const path = join(app, relative);
    if (!existsSync(path)) {
      problems.push(`${relative}: missing`);
      continue;
    }
    if ((statSync(path).mode & 0o111) === 0) problems.push(`${relative}: not executable`);
    if (!isMachO(path)) problems.push(`${relative}: not a Mach-O executable`);
  }

  // The name, spelled the way launchd and dyld read it. `existsSync` cannot catch a
  // case error on a case-insensitive volume; a string comparison can.
  const info = readPlist(join(app, "Contents/Info.plist"));
  if (info === undefined) problems.push("Contents/Info.plist: missing or not a plist");
  else if (info["CFBundleExecutable"] !== MAIN_EXECUTABLE_NAME) {
    problems.push(
      `Contents/Info.plist: CFBundleExecutable is ${JSON.stringify(info["CFBundleExecutable"])}, expected ${JSON.stringify(MAIN_EXECUTABLE_NAME)}`,
    );
  }

  if (!existsSync(join(app, LAUNCH_AGENT_PLIST))) problems.push(`${LAUNCH_AGENT_PLIST}: missing`);

  // A sidecar here would ship unsigned: the bundler signs Contents/MacOS.
  if (existsSync(join(app, MISPLACED_SIDECAR))) {
    problems.push(`${MISPLACED_SIDECAR}: a Mach-O under Resources is not signed by the bundler`);
  }
}

function checkLaunchAgent(app: string, problems: string[]): void {
  const path = join(app, LAUNCH_AGENT_PLIST);
  if (!existsSync(path)) return;

  const plist = readPlist(path);
  if (plist === undefined) {
    problems.push(`${LAUNCH_AGENT_PLIST}: not a readable plist`);
    return;
  }

  const expected: ReadonlyArray<readonly [string, unknown]> = [
    ["Label", LAUNCH_AGENT_LABEL],
    ["BundleProgram", SIDECAR_BUNDLE_PROGRAM],
    ["ProcessType", "Interactive"],
  ];
  for (const [key, value] of expected) {
    if (plist[key] !== value) {
      problems.push(
        `${LAUNCH_AGENT_PLIST}: ${key} is ${JSON.stringify(plist[key])}, expected ${JSON.stringify(value)}`,
      );
    }
  }

  const keepAlive = plist["KeepAlive"];
  const successfulExit =
    typeof keepAlive === "object" && keepAlive !== null && !Array.isArray(keepAlive)
      ? (keepAlive as Record<string, unknown>)["SuccessfulExit"]
      : undefined;
  if (successfulExit !== false) {
    problems.push(
      `${LAUNCH_AGENT_PLIST}: KeepAlive.SuccessfulExit is ${JSON.stringify(successfulExit)}, expected false (restart after a crash, stay down after a deliberate exit)`,
    );
  }

  for (const key of FORBIDDEN_LAUNCH_AGENT_KEYS) {
    if (key in plist) problems.push(`${LAUNCH_AGENT_PLIST}: ${key} must not be present`);
  }
}

/**
 * The plist must be inside the app's seal. It is added by `bundle.macOS.files` before
 * the app is signed; a plist written afterwards — at registration time, say — leaves
 * the seal broken and `smd` refuses to load it.
 *
 * `CodeResources` holds `<data>` hashes, which have no JSON form, so this reads the
 * XML rather than converting it.
 */
function checkSeal(app: string, problems: string[]): void {
  const path = join(app, "Contents/_CodeSignature/CodeResources");
  if (!existsSync(path)) {
    problems.push("Contents/_CodeSignature/CodeResources: missing; the bundle is not signed");
    return;
  }

  const converted = run(["plutil", "-convert", "xml1", "-o", "-", path]);
  const xml = new TextDecoder().decode(converted.stdout);
  const sealed = xml.indexOf("<key>files2</key>");
  const entry = xml.indexOf(`<key>${LAUNCH_AGENT_SEALED_RESOURCE}</key>`);
  if (sealed < 0 || entry < sealed) {
    problems.push(`${LAUNCH_AGENT_PLIST}: not sealed by the code signature`);
  }
}

function checkSignature(
  app: string,
  relative: string,
  expect: SignatureExpectation,
  problems: string[],
): void {
  const path = join(app, relative);
  if (!existsSync(path)) return;

  // `codesign --display` writes its report to stderr.
  const displayed = run(["codesign", "--display", "--verbose=2", path]);
  if (displayed.exitCode !== 0) {
    problems.push(`${relative}: ${verdictLine(displayed.stderr)}`);
    return;
  }
  const report = displayed.stderr;

  const flags = /flags=0x[0-9a-f]+\(([^)]*)\)/.exec(report)?.[1] ?? "";
  if (!flags.split(",").includes("runtime")) {
    problems.push(`${relative}: not signed with the hardened runtime (flags=${flags || "none"})`);
  }

  if (expect === "adhoc") {
    if (!/^Signature=adhoc$/m.test(report)) {
      problems.push(`${relative}: expected an ad-hoc signature`);
    }
    return;
  }

  if (!/^Authority=Developer ID Application:/m.test(report)) {
    problems.push(`${relative}: not signed by a Developer ID Application authority`);
  }
  if (/^TeamIdentifier=not set$/m.test(report) || !/^TeamIdentifier=/m.test(report)) {
    problems.push(`${relative}: no team identifier`);
  }
  // Notarization requires a secure timestamp; `codesign` omits the line without one.
  if (!/^Timestamp=/m.test(report)) {
    problems.push(`${relative}: no secure timestamp`);
  }
}

function checkEntitlements(app: string, relative: string, problems: string[]): void {
  const path = join(app, relative);
  if (!existsSync(path)) return;

  const displayed = run(["codesign", "--display", "--entitlements", "-", "--xml", path]);
  if (displayed.exitCode !== 0) {
    problems.push(`${relative}: ${verdictLine(displayed.stderr)}`);
    return;
  }
  if (displayed.stdout.byteLength === 0) {
    problems.push(`${relative}: no entitlements at all`);
    return;
  }

  const converted = run(["plutil", "-convert", "json", "-o", "-", "-"], displayed.stdout);
  const entitlements = asObject(new TextDecoder().decode(converted.stdout));
  if (entitlements === undefined) {
    problems.push(`${relative}: entitlements are not a readable plist`);
    return;
  }

  for (const key of REQUIRED_ENTITLEMENTS) {
    if (entitlements[key] !== true) problems.push(`${relative}: ${key} is not granted`);
  }
  for (const key of FORBIDDEN_ENTITLEMENTS) {
    if (entitlements[key] === true) problems.push(`${relative}: ${key} must not be granted`);
  }
}

function checkBundleSignature(app: string, problems: string[]): void {
  const verified = run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", app]);
  if (verified.exitCode !== 0) problems.push(`the bundle: ${verdictLine(verified.stderr)}`);
}

function checkNotarization(app: string, problems: string[]): void {
  const stapled = run(["xcrun", "stapler", "validate", app]);
  if (stapled.exitCode !== 0) {
    problems.push(`the bundle: no stapled notarization ticket (${verdictLine(stapled.stderr)})`);
  }

  const assessed = run(["spctl", "--assess", "--type", "execute", "--verbose=2", app]);
  if (assessed.exitCode !== 0) {
    problems.push(`the bundle: Gatekeeper rejects it (${verdictLine(assessed.stderr)})`);
  }
}

/**
 * The last non-empty line a tool wrote, which is where its verdict is: `codesign
 * --verify --verbose=2` prints its `--prepared:`/`--validated:` progress first and
 * the reason it refused last.
 */
function verdictLine(text: string): string {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return lines[lines.length - 1] ?? "failed with no output";
}

/** Every rule the bundle breaks, in reading order. Empty means the bundle is shippable. */
export function verifyBundle(app: string, options: VerificationOptions): readonly string[] {
  if (!existsSync(app)) return [`no bundle at ${app}; run \`bun run bundle\``];

  const problems: string[] = [];
  checkLayout(app, problems);
  checkLaunchAgent(app, problems);
  checkSeal(app, problems);
  for (const executable of [MAIN_EXECUTABLE, SIDECAR_BUNDLE_PROGRAM]) {
    checkSignature(app, executable, options.expect, problems);
    checkEntitlements(app, executable, problems);
  }
  checkBundleSignature(app, problems);
  if (options.notarized) checkNotarization(app, problems);

  return problems;
}
