import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import { identifier, type GridSize, type TerminalID } from "@janela/core";
import {
  decodeDaemonMessage,
  decodeOutput,
  encodeClientMessage,
  encodeFrame,
  encodeInput,
  frameDecoder,
  FrameKind,
  PROTOCOL_VERSION,
  type ClientMessage,
  type DaemonMessage,
  type RequestID,
  type StateUpdate,
} from "@janela/protocol";
import { Match } from "effect";

interface Options {
  readonly attach: TerminalID | undefined;
  readonly viewport: GridSize;
  readonly send: string | undefined;
  readonly hold: number;
  readonly protocolVersion: number;
  readonly socketPath: string;
}

const SOCKET_PATH = join(homedir(), ".janela", "run", "janelad.sock");

function openSocket(path: string): Promise<Socket> {
  const { promise, resolve, reject } = Promise.withResolvers<Socket>();
  const opening = connect(path);

  opening.once("connect", () => resolve(opening));
  opening.once("error", reject);

  return promise;
}

function pause(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();

  setTimeout(resolve, milliseconds);

  return promise;
}

function parse(argv: readonly string[]): Options {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];

    if (flag === undefined || !flag.startsWith("--")) continue;

    const next = argv[index + 1];
    values.set(flag.slice(2), next !== undefined && !next.startsWith("--") ? next : "true");
  }

  const number = (name: string, fallback: number): number => {
    const raw = values.get(name);

    if (raw === undefined) return fallback;

    const parsed = Number.parseInt(raw, 10);

    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`--${name} wants a whole number`);

    return parsed;
  };

  const attach = values.get("attach");

  return {
    attach: attach === undefined || attach === "true" ? undefined : identifier<"Terminal">(attach),
    viewport: { columns: number("columns", 80), rows: number("rows", 24) },
    send: values.get("send")?.replaceAll(String.raw`\n`, "\n"),
    hold: number("hold", values.get("attach") === undefined ? 1 : 30),
    protocolVersion: number("protocol-version", PROTOCOL_VERSION),
    socketPath: values.get("socket") ?? SOCKET_PATH,
  };
}

async function run(): Promise<void> {
  const options = parse(process.argv.slice(2));

  const socket = await openSocket(options.socketPath).catch((cause: unknown) => {
    console.error(`Could not reach ${options.socketPath}: ${String(cause)}`);
    console.error("Is janelad running? See docs/survival-proof.md § Starting a daemon by hand.");
    process.exit(1);
  });

  const decoder = frameDecoder();
  const decodeText = new TextDecoder();

  let state: StateUpdate | undefined;
  let repaintBytes = 0;
  let repaints = 0;
  let firstRepaint: string | undefined;
  let lastRequestID = 0;

  const report = (message: DaemonMessage): void => {
    Match.value(message).pipe(
      Match.when({ type: "hello" }, ({ hello }) => {
        console.log(
          `daemon speaks ${hello.protocolVersion} (minimum ${hello.minimumSupported}), calls itself ${hello.clientName}`,
        );
      }),
      Match.when({ type: "refused" }, ({ refusal }) => {
        console.log(`REFUSED: ${JSON.stringify(refusal)}`);
      }),
      Match.when({ type: "state" }, ({ update }) => {
        state = update;
      }),
      Match.when({ type: "terminalExited" }, (exited) => {
        console.log(`terminal ${exited.terminalID} exited with ${exited.code}`);
      }),
      Match.when({ type: "failed" }, (failed) => {
        console.log(`request ${failed.id} failed: ${failed.failure.summary}`);
      }),
      Match.when({ type: "text" }, ({ text }) => {
        console.log(text);
      }),
      Match.orElse(() => undefined),
    );
  };

  const send = (message: ClientMessage): void => {
    socket.write(encodeFrame(encodeClientMessage(message)));
  };

  const nextID = (): RequestID => {
    lastRequestID += 1;

    // SAFETY: `lastRequestID` is a positive integer counter this process owns, and `RequestID` brands a number nominally — the brand adds no representation the number does not already have.
    return lastRequestID as RequestID;
  };

  socket.on("data", (chunk: Buffer) => {
    for (const frame of decoder.push(new Uint8Array(chunk))) {
      if (frame.kind === FrameKind.Control) {
        const message: DaemonMessage = decodeDaemonMessage(frame);
        report(message);

        continue;
      }

      const output = decodeOutput(frame);
      repaints += 1;
      repaintBytes += output.bytes.length;

      if (firstRepaint === undefined) {
        firstRepaint = decodeText.decode(new Uint8Array(output.bytes));
      }
    }
  });

  send({
    type: "hello",
    hello: {
      protocolVersion: options.protocolVersion,
      minimumSupported: options.protocolVersion,
      clientName: "janela-survival-probe",
    },
  });

  send({ type: "subscribe", id: nextID(), scope: { kind: "state" } });

  await pause(500);

  if (state === undefined) {
    console.log("No state announcement arrived.");

    console.log(
      "The daemon sent no state. If it also sent no hello, it is not the start-up\n" +
        "race any more — #43 fixed that, and the daemon answers a connection accepted\n" +
        "mid-start — so look at whether a daemon is running at all.",
    );

    process.exit(1);
  }

  const announced = state;

  if (options.attach === undefined) {
    console.log(`\n${announced.sessions.length} session(s):`);

    for (const session of announced.sessions) {
      console.log(`  ${session.name}  ${session.directory}`);

      for (const terminal of session.terminals) {
        const status = announced.terminalStates[terminal.id]?.kind ?? "idle";
        console.log(`    ${terminal.id}  ${status.padEnd(14)} ${terminal.title}`);
      }
    }

    console.log("\nAttach to one with --attach <id> --columns <n> --rows <n>");
    socket.destroy();
    process.exit(0);
  }

  const terminalID = options.attach;
  const status = announced.terminalStates[terminalID]?.kind ?? "idle";

  console.log(
    `attaching to ${terminalID} (${status}) at ${options.viewport.columns}x${options.viewport.rows}`,
  );

  if (status !== "running") {
    console.log("Not running. This probe never starts a terminal — start it in the app first.");
  }

  send({ type: "attach", id: nextID(), terminalID, viewport: options.viewport });

  await pause(300);

  if (options.send !== undefined) {
    socket.write(
      encodeFrame(encodeInput({ terminalID, bytes: new TextEncoder().encode(options.send) })),
    );

    await pause(700);
  }

  send({ type: "snapshotText", id: nextID(), terminalID, includeScrollback: false });

  await pause(300);

  console.log(
    `\n${repaints} repaint(s), ${repaintBytes} byte(s); first begins with RIS: ${
      firstRepaint?.startsWith("\u001bc") === true
    }`,
  );

  console.log(
    `holding the attachment for ${options.hold}s — look at the app's window now, then it detaches.`,
  );

  await pause(options.hold * 1000);

  send({ type: "detach", id: nextID(), terminalID });

  await pause(200);

  socket.destroy();

  process.exit(0);
}

await run();
