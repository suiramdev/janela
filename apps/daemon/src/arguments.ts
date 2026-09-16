import { Option, Schema } from "effect";

export type DaemonArguments =
  | { readonly kind: "version" }
  | { readonly kind: "serve"; readonly foreground: boolean }
  | { readonly kind: "usage"; readonly problem: string };

const RECOGNISED_FLAGS = ["--foreground", "--version"] as const;

const DaemonFlag = Schema.Literals(RECOGNISED_FLAGS);

const decodeFlag = Schema.decodeUnknownOption(DaemonFlag);

export const USAGE =
  "usage: janelad [--foreground] [--version]\n" +
  "  --foreground  serve without launchd; the log is also mirrored to stderr\n" +
  "  --version     print the version and exit\n" +
  "There is no --socket: set HOME to move the socket and the database together (docs/development.md § The daemon).\n";

export function parseDaemonArguments(argv: readonly string[]): DaemonArguments {
  let foreground = false;
  let version = false;

  for (const argument of argv) {
    const flag = decodeFlag(argument);

    if (Option.isNone(flag)) {
      return { kind: "usage", problem: `unknown argument ${JSON.stringify(argument)}` };
    }

    if (flag.value === "--foreground") foreground = true;

    if (flag.value === "--version") version = true;
  }

  if (version) return { kind: "version" };

  return { kind: "serve", foreground };
}
