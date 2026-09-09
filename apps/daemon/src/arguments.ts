/**
 * `janelad`'s command line, parsed rather than sniffed.
 *
 * The defect this closes (#49) was not a missing flag: it was that `main` asked
 * `argv.includes("--foreground")` and nothing else, so `janelad --socket
 * /tmp/dev.sock --foreground` bound the *real* user socket and served the real
 * database while a developer believed they were isolated. Any argument the daemon
 * cannot honour must therefore stop it, before it opens anything.
 *
 * There is deliberately no `--socket`. It would move the socket and leave the
 * database where it was, so two daemons would restore the same sessions into two
 * sets of terminals — a worse footgun than the one being removed. `HOME` moves the
 * socket, the database and the log together, which is what the survival proof does
 * (#31) and what `USAGE` points at.
 */

/** What the command line asked for. Exhaustive: `main` switches on `kind`. */
export type DaemonArguments =
  /** `--version`: print it and touch nothing else. */
  | { readonly kind: "version" }
  /** Serve. `foreground` also mirrors every log record to stderr. */
  | { readonly kind: "serve"; readonly foreground: boolean }
  /** Refused. `problem` names the offending argument; `main` exits 2. */
  | { readonly kind: "usage"; readonly problem: string };

/**
 * Printed on refusal, so the answer to "how do I point it somewhere else?" is in
 * the same output as the refusal.
 */
export const USAGE =
  "usage: janelad [--foreground] [--version]\n" +
  "  --foreground  serve without launchd; the log is also mirrored to stderr\n" +
  "  --version     print the version and exit\n" +
  "There is no --socket: set HOME to move the socket and the database together (docs/development.md § The daemon).\n";

export function parseDaemonArguments(argv: readonly string[]): DaemonArguments {
  let foreground = false;
  let version = false;
  for (const argument of argv) {
    if (argument === "--foreground") {
      foreground = true;
      continue;
    }
    if (argument === "--version") {
      version = true;
      continue;
    }
    // The first unknown argument, not a list: one is enough to stop, and naming
    // exactly the one that was refused is what makes the message actionable.
    return { kind: "usage", problem: `unknown argument ${JSON.stringify(argument)}` };
  }

  // `--version` wins wherever it appears, as it did when this was two `includes`
  // calls in order: CI runs `./janelad --version` to prove the compiled binary
  // carries its own runtime, and that must never start serving.
  if (version) return { kind: "version" };
  return { kind: "serve", foreground };
}
