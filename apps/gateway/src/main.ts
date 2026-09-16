import { defaultSocketPath } from "@janela/daemon/endpoint";
import { FRAME_HEADER_LENGTH, MAXIMUM_PAYLOAD_LENGTH } from "@janela/protocol";
import { TERMINAL_WATER_MARKS, log } from "@janela/support";
import { processRunner } from "@janela/support/process";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { Match, Predicate } from "effect";

import { USAGE, parseGatewayArguments } from "./arguments.ts";
import { isAllowedOrigin, staticResponse } from "./http.ts";
import { launchAgentKickstart } from "./kickstart.ts";
import { installStderrLogSink } from "./log-sink.ts";
import { openRelay, type Relay } from "./relay.ts";

interface Attachment {
  relay: Relay | undefined;
}

const EXIT_REFUSED_ARGUMENT = 2;

const EXIT_START_FAILED = 1;

const WEBSOCKET_PATH = "/ws";

const READ_METHODS = new Set(["GET", "HEAD"]);

const FORBIDDEN = 403;

const UPGRADE_REQUIRED = 426;

const METHOD_NOT_ALLOWED = 405;

const UNSUPPORTED_DATA = 1003;

function main(): void {
  Match.value(parseGatewayArguments(process.argv.slice(2))).pipe(
    Match.discriminatorsExhaustive("kind")({
      usage: ({ problem }) => {
        process.stderr.write(`janela-gateway: ${problem}\n${USAGE}`);
        process.exit(EXIT_REFUSED_ARGUMENT);
      },
      serve: ({ port, webRoot }) => {
        serve(port, webRoot);
      },
    }),
  );
}

function serve(port: number, webRoot: string | undefined): void {
  installStderrLogSink();

  const logger = log("app");
  const socketPath = defaultSocketPath();
  const uid = process.getuid?.();

  if (uid === undefined) {
    process.stderr.write("janela-gateway: this platform reports no uid\n");
    process.exit(EXIT_START_FAILED);
  }

  const kickstart = launchAgentKickstart({
    run: processRunner().run,
    uid,
    now: Date.now,
    log: logger,
  });

  const websocket: WebSocketHandler<Attachment> = {
    maxPayloadLength: FRAME_HEADER_LENGTH + MAXIMUM_PAYLOAD_LENGTH,
    backpressureLimit: TERMINAL_WATER_MARKS.highWater,
    closeOnBackpressureLimit: false,
    perMessageDeflate: false,
    sendPings: true,
    open: (ws: ServerWebSocket<Attachment>) => {
      ws.data.relay = openRelay(
        {
          send: (bytes) => ws.send(bytes),
          close: (code, reason) => ws.close(code, reason),
        },
        { socketPath, onDaemonUnreachable: kickstart, log: log("protocol") },
      );
    },
    message: (ws: ServerWebSocket<Attachment>, data: string | Buffer) => {
      if (Predicate.isString(data)) {
        ws.close(UNSUPPORTED_DATA, "binary only");

        return;
      }

      ws.data.relay?.deliver(data instanceof Uint8Array ? data : new Uint8Array(data));
    },
    drain: (ws: ServerWebSocket<Attachment>) => {
      ws.data.relay?.drained();
    },
    close: (ws: ServerWebSocket<Attachment>) => {
      ws.data.relay?.close();
    },
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    websocket,
    fetch: (request: Request, target: Server<Attachment>) => {
      const url = new URL(request.url);

      if (url.pathname === WEBSOCKET_PATH) {
        if (!isAllowedOrigin(request.headers.get("origin"), request.headers.get("host"))) {
          return new Response("origin not allowed", { status: FORBIDDEN });
        }

        if (target.upgrade(request, { data: { relay: undefined } })) return undefined;

        return new Response("upgrade required", { status: UPGRADE_REQUIRED });
      }

      if (!READ_METHODS.has(request.method)) {
        return new Response("method not allowed", { status: METHOD_NOT_ALLOWED });
      }

      return staticResponse(webRoot, url.pathname);
    },
  });

  logger.info("listening", { port: server.port ?? port, webRoot: webRoot !== undefined });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void server.stop(true);
      process.exit(0);
    });
  }
}

if (import.meta.main) {
  main();
}
