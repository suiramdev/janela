/**
 * Checks the bundle `tauri build` just produced. Runs at the end of `bun run bundle`,
 * locally and in CI.
 *
 * What it expects depends on the environment, because that is what decides what the
 * build could do: with no `APPLE_*` variables the bundle is ad-hoc signed (the
 * `signingIdentity: "-"` in `tauri.conf.json`), which still exercises the hardened
 * runtime, the entitlements and the sealed plist — the whole failure class this gate
 * exists for. With release credentials present it additionally requires a Developer ID
 * authority, a secure timestamp, a stapled ticket and Gatekeeper acceptance.
 *
 * ## Notarization scope
 *
 * Notarization and stapling happen *inside* `tauri build`: it submits with
 * `notarytool submit --wait` and staples the result unless `--skip-stapling` is
 * passed. There is no separate step here and no release workflow yet — until one
 * exists, a release is produced by running, from the repository root:
 *
 *     APPLE_SIGNING_IDENTITY="Developer ID Application: …" \
 *     APPLE_ID=… APPLE_PASSWORD=… APPLE_TEAM_ID=… bun run app:build
 *
 * `APPLE_SIGNING_IDENTITY` must be set explicitly whenever `APPLE_CERTIFICATE` is
 * used: Tauri checks that the identity is contained in the certificate's name.
 */
import { isAbsolute, join } from "node:path";

import { DEFAULT_BUNDLE_PATH, MAIN_EXECUTABLE_NAME, SIDECAR_NAME } from "./bundle-layout.ts";
import { expectationFromEnvironment, verifyBundle } from "./bundle-verification.ts";

const desktop = new URL("../", import.meta.url).pathname;
const argument = process.argv[2];
const app =
  argument === undefined
    ? join(desktop, DEFAULT_BUNDLE_PATH)
    : isAbsolute(argument)
      ? argument
      : join(process.cwd(), argument);

const options = expectationFromEnvironment(process.env);
const problems = verifyBundle(app, options);

if (problems.length > 0) {
  process.stderr.write(`${app}\n`);
  for (const problem of problems) process.stderr.write(`  ${problem}\n`);
  process.exit(1);
}

const scope = options.notarized ? `${options.expect}, notarized` : options.expect;
process.stdout.write(
  `bundle ok — ${scope} — ${MAIN_EXECUTABLE_NAME}, ${SIDECAR_NAME} hardened; sh.janela.janelad.plist sealed\n`,
);
