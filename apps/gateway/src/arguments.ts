import { resolve } from "node:path";

import { Option, Schema } from "effect";

export type GatewayArguments =
  | { readonly kind: "serve"; readonly port: number; readonly webRoot: string | undefined }
  | { readonly kind: "usage"; readonly problem: string };

export const DEFAULT_PORT = 7411;

const LOWEST_PORT = 1;

const HIGHEST_PORT = 65535;

const RECOGNISED_FLAGS = ["--port", "--web-root"] as const;

const GatewayFlag = Schema.Literals(RECOGNISED_FLAGS);

const decodeFlag = Schema.decodeUnknownOption(GatewayFlag);

export const USAGE =
  "usage: janela-gateway [--port <n>] [--web-root <dir>]\n" +
  "  --port      TCP port on 127.0.0.1 (default 7411). It never binds another interface: publish it with `tailscale serve --bg <port>`.\n" +
  "  --web-root  directory holding the built browser client (apps/web/dist). Without it only /ws is served.\n";

export function parseGatewayArguments(argv: readonly string[]): GatewayArguments {
  let port = DEFAULT_PORT;
  let webRoot: string | undefined = undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    const flag = decodeFlag(argument);

    if (Option.isNone(flag)) {
      return { kind: "usage", problem: `unknown argument ${JSON.stringify(argument)}` };
    }

    const value = argv[index + 1];

    if (value === undefined) {
      return { kind: "usage", problem: `${flag.value} needs a value` };
    }

    index += 1;

    if (flag.value === "--port") {
      const parsed = Number(value);

      if (!Number.isInteger(parsed) || parsed < LOWEST_PORT || parsed > HIGHEST_PORT) {
        return {
          kind: "usage",
          problem: `--port wants an integer 1-65535, not ${JSON.stringify(value)}`,
        };
      }

      port = parsed;
    }

    if (flag.value === "--web-root") webRoot = resolve(value);
  }

  return { kind: "serve", port, webRoot };
}
