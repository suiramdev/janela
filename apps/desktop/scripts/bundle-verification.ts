import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

import { Effect, Option, Predicate, Schema } from "effect";

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

export type SignatureExpectation = "adhoc" | "developer-id";

export type PlistValue = string | number | boolean | null | readonly PlistValue[] | PlistDictionary;

export interface PlistDictionary {
  readonly [key: string]: PlistValue;
}

export interface VerificationOptions {
  readonly expect: SignatureExpectation;
  readonly notarized: boolean;
}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
}

const MACH_O_MAGIC = new Set([0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

const PlistValueSchema: Schema.Codec<PlistValue> = Schema.suspend(() =>
  Schema.Union([
    Schema.String,
    Schema.Number,
    Schema.Boolean,
    Schema.Null,
    Schema.Array(PlistValueSchema),
    Schema.Record(Schema.String, PlistValueSchema),
  ]),
);

const decodePlist = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, PlistValueSchema)),
);

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

function run(command: string[], stdin: Uint8Array | undefined = undefined): CommandResult {
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

function readPlist(path: string): PlistDictionary | undefined {
  const converted = run(["plutil", "-convert", "json", "-o", "-", path]);

  if (converted.exitCode !== 0) return undefined;

  return Option.getOrUndefined(decodePlist(new TextDecoder().decode(converted.stdout)));
}

function isMachO(path: string): boolean {
  const descriptor = openSync(path, "r");

  return Effect.runSync(
    Effect.ensuring(
      Effect.sync(() => {
        const header = Buffer.alloc(4);

        if (readSync(descriptor, header, 0, 4, 0) < 4) return false;

        return MACH_O_MAGIC.has(header.readUInt32BE(0));
      }),
      Effect.sync(() => {
        closeSync(descriptor);
      }),
    ),
  );
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

  const info = readPlist(join(app, "Contents/Info.plist"));

  if (info === undefined) problems.push("Contents/Info.plist: missing or not a plist");
  else if (info["CFBundleExecutable"] !== MAIN_EXECUTABLE_NAME) {
    problems.push(
      `Contents/Info.plist: CFBundleExecutable is ${JSON.stringify(info["CFBundleExecutable"])}, expected ${JSON.stringify(MAIN_EXECUTABLE_NAME)}`,
    );
  }

  if (!existsSync(join(app, LAUNCH_AGENT_PLIST))) problems.push(`${LAUNCH_AGENT_PLIST}: missing`);

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
    Predicate.isReadonlyObject(keepAlive) && !Array.isArray(keepAlive)
      ? keepAlive["SuccessfulExit"]
      : undefined;

  if (successfulExit !== false) {
    problems.push(
      `${LAUNCH_AGENT_PLIST}: KeepAlive.SuccessfulExit is ${JSON.stringify(successfulExit)}, expected false (restart after a crash, stay down after a deliberate exit)`,
    );
  }

  for (const key of FORBIDDEN_LAUNCH_AGENT_KEYS) {
    if (Object.hasOwn(plist, key)) {
      problems.push(`${LAUNCH_AGENT_PLIST}: ${key} must not be present`);
    }
  }
}

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
  const entitlements = Option.getOrUndefined(
    decodePlist(new TextDecoder().decode(converted.stdout)),
  );

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

function verdictLine(text: string): string {
  const lines = text.split("\n").filter((line) => line.trim() !== "");

  return lines[lines.length - 1] ?? "failed with no output";
}

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
