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
