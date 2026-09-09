/**
 * A second client, for the survival proof.
 *
 * `docs/survival-proof.md` needs a client whose viewport a human chooses, so
 * that step 5 — two clients on one terminal, the PTY sized to the smaller — can
 * be exercised against the *running app* rather than only in a test. The app's
 * own window cannot do it: its viewport is whatever the window measures.
 *
 * This is a client, and it is deliberately the smallest one that can exist: a
 * Unix socket, `@janela/protocol`'s framing, and nothing else. It uses no
 * `@janela/client`, so what it proves is the protocol rather than our client
 * library. A future `janela` CLI is this, grown up.
 *
 * ```
 * bun run scripts/survival-probe.ts                       # what is running
 * bun run scripts/survival-probe.ts --attach <id> --columns 40 --rows 12
 * bun run scripts/survival-probe.ts --attach <id> --send 'stty size\n'
 * bun run scripts/survival-probe.ts --attach <id> --protocol-version 5
 * ```
 *
 * It never creates, starts, stops or removes anything. The most it does is
 * attach a viewport, which the daemon undoes when the socket closes.
 */

import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import type { GridSize, TerminalID } from "@janela/core";
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

/**
 * The same path `@janela/daemon`'s `defaultSocketPath()` computes, spelled out
 * rather than imported: a client may not depend on a daemon package, and this
 * script is held to the layering rule even though the gate does not walk
 * `scripts/`.
 */
const SOCKET_PATH = join(homedir(), ".janela", "run", "janelad.sock");

interface Options {
  readonly attach: TerminalID | undefined;
  readonly viewport: GridSize;
  readonly send: string | undefined;
  readonly hold: number;
  readonly protocolVersion: number;
  readonly socketPath: string;
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
    attach: attach === undefined || attach === "true" ? undefined : (attach as TerminalID),
    viewport: { columns: number("columns", 80), rows: number("rows", 24) },
    // `\n` typed at a shell is the Return key; a caller writing `--send 'x\n'`
    // means the two characters, so they are translated here rather than
    // requiring a literal newline inside a shell argument.
    send: values.get("send")?.replaceAll(String.raw`\n`, "\n"),
    hold: number("hold", values.get("attach") === undefined ? 1 : 30),
    protocolVersion: number("protocol-version", PROTOCOL_VERSION),
    socketPath: values.get("socket") ?? SOCKET_PATH,
  };
}

const options = parse(process.argv.slice(2));
const socket = await new Promise<Socket>((resolve, reject) => {
  const opening = connect(options.socketPath);
  opening.once("connect", () => resolve(opening));
  opening.once("error", reject);
}).catch((error: unknown) => {
  console.error(`Could not reach ${options.socketPath}: ${String(error)}`);
  console.error("Is janelad running? See docs/survival-proof.md § Starting a daemon by hand.");
  process.exit(1);
});

const decoder = frameDecoder();
const decodeText = new TextDecoder();
let state: StateUpdate | undefined;
let repaintBytes = 0;
let repaints = 0;
let firstRepaint: string | undefined;

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
    // Copied at the point of decode: the payload is a view valid only until the
    // next push.
    if (firstRepaint === undefined) firstRepaint = decodeText.decode(new Uint8Array(output.bytes));
  }
});

function report(message: DaemonMessage): void {
  switch (message.type) {
    case "hello":
      console.log(
        `daemon speaks ${message.hello.protocolVersion} (minimum ${message.hello.minimumSupported}), calls itself ${message.hello.clientName}`,
      );
      return;
    case "refused":
      console.log(`REFUSED: ${JSON.stringify(message.refusal)}`);
      return;
    case "state":
      state = message.update;
      return;
    case "terminalExited":
      console.log(`terminal ${message.terminalID} exited with ${message.code}`);
      return;
    case "failed":
      console.log(`request ${message.id} failed: ${message.failure.summary}`);
      return;
    case "text":
      console.log(message.text);
      return;
    default:
      return;
  }
}

let lastRequestID = 0;
const send = (message: ClientMessage): void => {
  socket.write(encodeFrame(encodeClientMessage(message)));
};
const nextID = (): RequestID => {
  lastRequestID += 1;
  return lastRequestID as RequestID;
};
const pause = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

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
    "If the daemon also sent no hello, this is the swallowed-connection defect in\n" +
      "docs/survival-proof.md § Defects: run this again.",
  );
  process.exit(1);
}

if (options.attach === undefined) {
  console.log(`\n${state.sessions.length} session(s):`);
  for (const session of state.sessions) {
    console.log(`  ${session.name}  ${session.directory}`);
    for (const terminal of session.terminals) {
      const status = state.terminalStates[terminal.id]?.kind ?? "idle";
      console.log(`    ${terminal.id}  ${status.padEnd(14)} ${terminal.title}`);
    }
  }
  console.log("\nAttach to one with --attach <id> --columns <n> --rows <n>");
  socket.destroy();
  process.exit(0);
}

const terminalID = options.attach;
const status = state.terminalStates[terminalID]?.kind ?? "idle";
console.log(
  `attaching to ${terminalID} (${status}) at ${options.viewport.columns}x${options.viewport.rows}`,
);
if (status !== "running") {
  // Never started here: starting a process is the app's or the user's decision,
  // and a probe that spawns a shell would be a poor guest.
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
