import type { TerminalID } from "@janela/core";
import { Option, Schema } from "effect";

import { byteAt } from "./bytes.ts";
import {
  FrameError,
  FrameKind,
  MalformedControl,
  RawHeaderTooShort,
  UnexpectedFrameKind,
} from "./frame.ts";
import type { Frame } from "./frame.ts";
import type { ClientMessage, DaemonMessage, TerminalInput, TerminalOutput } from "./message.ts";

interface ControlDiscriminant {
  readonly type: string;
}

interface RawFrame {
  readonly terminalID: TerminalID;
  readonly bytes: Uint8Array;
}

export const RAW_HEADER_LENGTH = 16;

const encoder = new TextEncoder();

const decoder = new TextDecoder("utf-8", { fatal: true });

const decodeUtf8 = Option.liftThrowable((payload: Uint8Array): string => decoder.decode(payload));

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const DASH = 0x2d;

const HEX_PAIRS: readonly string[] = Array.from({ length: 256 }, (_unused, byte) =>
  byte.toString(16).padStart(2, "0"),
);

const exhaustiveLiterals =
  <const Union extends string>() =>
  <const Members extends readonly Union[]>(
    members: Members & ([Exclude<Union, Members[number]>] extends [never] ? unknown : never),
  ): Members =>
    members;

const CLIENT_MESSAGE_TYPES = exhaustiveLiterals<ClientMessage["type"]>()([
  "hello",
  "subscribe",
  "addProject",
  "removeProject",
  "updateProjectSettings",
  "createSession",
  "removeSession",
  "removalPlan",
  "projectBranches",
  "listDirectory",
  "moveTab",
  "moveTerminal",
  "renameSession",
  "markSession",
  "attach",
  "detach",
  "startTerminal",
  "stopTerminal",
  "restartTerminal",
  "resize",
  "saveLaunchProfile",
  "removeLaunchProfile",
  "createTerminal",
  "removeTerminal",
  "snapshotText",
  "integrations",
  "installIntegration",
  "removeIntegration",
]);

const DAEMON_MESSAGE_TYPES = exhaustiveLiterals<DaemonMessage["type"]>()([
  "hello",
  "refused",
  "state",
  "attention",
  "terminalExited",
  "acknowledged",
  "failed",
  "text",
]);

const ClientControl = Schema.Struct({ type: Schema.Literals(CLIENT_MESSAGE_TYPES) });

const DaemonControl = Schema.Struct({ type: Schema.Literals(DAEMON_MESSAGE_TYPES) });

export function encodeClientMessage(message: ClientMessage): Frame {
  return { kind: FrameKind.Control, payload: encoder.encode(JSON.stringify(message)) };
}

export function encodeDaemonMessage(message: DaemonMessage): Frame {
  return { kind: FrameKind.Control, payload: encoder.encode(JSON.stringify(message)) };
}

function decodeControl<Message extends ControlDiscriminant>(
  frame: Frame,
  envelope: Schema.Codec<ControlDiscriminant, unknown>,
): Message {
  if (frame.kind !== FrameKind.Control) {
    throw new FrameError({
      reason: new UnexpectedFrameKind({ expected: FrameKind.Control, received: frame.kind }),
    });
  }

  const parsed = Option.flatMap(decodeUtf8(frame.payload), decodeJson);
  const accepted = Option.flatMap(parsed, Schema.decodeUnknownOption(envelope));

  if (Option.isNone(accepted)) {
    throw new FrameError({ reason: new MalformedControl() });
  }

  /* SAFETY: the payload is JSON and its `type` is one of this union's
     discriminants — the two facts a connection-fatal decision needs. The
     remaining fields are validated by the request dispatcher, which answers a
     malformed request with `failed` rather than by closing the connection.
     docs/packages/protocol.md § message-coder.ts records why the split is here. */
  return Option.getOrThrow(parsed) as Message;
}

export function decodeClientMessage(frame: Frame): ClientMessage {
  return decodeControl<ClientMessage>(frame, ClientControl);
}

export function decodeDaemonMessage(frame: Frame): DaemonMessage {
  return decodeControl<DaemonMessage>(frame, DaemonControl);
}

function notAUUID(id: string): TypeError {
  return new TypeError(`terminal id is not a UUID: ${id}`);
}

function nibble(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;

  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;

  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;

  return -1;
}

function writeTerminalID(id: TerminalID, target: Uint8Array, offset: number): void {
  if (id.length !== 36) throw notAUUID(id);

  let cursor = 0;

  for (let index = 0; index < RAW_HEADER_LENGTH; index += 1) {
    if (cursor === 8 || cursor === 13 || cursor === 18 || cursor === 23) {
      if (id.charCodeAt(cursor) !== DASH) throw notAUUID(id);

      cursor += 1;
    }

    const high = nibble(id.charCodeAt(cursor));
    const low = nibble(id.charCodeAt(cursor + 1));

    if (high < 0 || low < 0) throw notAUUID(id);

    target[offset + index] = (high << 4) | low;
    cursor += 2;
  }
}

function readTerminalID(source: Uint8Array, offset: number): TerminalID {
  let text = "";

  for (let index = 0; index < RAW_HEADER_LENGTH; index += 1) {
    if (index === 4 || index === 6 || index === 8 || index === 10) text += "-";

    const pair = HEX_PAIRS[byteAt(source, offset + index)];

    if (pair === undefined) {
      throw new RangeError(`not a byte at offset ${offset + index}`);
    }

    text += pair;
  }

  /* SAFETY: `text` was built here from sixteen `HEX_PAIRS` lookups with
     separators at 4, 6, 8 and 10, so it is canonical lowercase 8-4-4-4-12 — the
     exact form `identifier()` in @janela/core accepts. The brand is nominal, so
     re-validating would prove nothing this loop has not already established. */
  return text as TerminalID;
}

function encodeRaw(terminalID: TerminalID, bytes: Uint8Array): Uint8Array {
  const payload = new Uint8Array(RAW_HEADER_LENGTH + bytes.length);
  writeTerminalID(terminalID, payload, 0);
  payload.set(bytes, RAW_HEADER_LENGTH);

  return payload;
}

function decodeRaw(frame: Frame, expected: FrameKind): RawFrame {
  if (frame.kind !== expected) {
    throw new FrameError({
      reason: new UnexpectedFrameKind({ expected, received: frame.kind }),
    });
  }

  if (frame.payload.length < RAW_HEADER_LENGTH) {
    throw new FrameError({
      reason: new RawHeaderTooShort({ received: frame.payload.length }),
    });
  }

  return {
    terminalID: readTerminalID(frame.payload, 0),
    bytes: frame.payload.subarray(RAW_HEADER_LENGTH),
  };
}

export function encodeInput(input: TerminalInput): Frame {
  return { kind: FrameKind.Input, payload: encodeRaw(input.terminalID, input.bytes) };
}

export function encodeOutput(output: TerminalOutput): Frame {
  return { kind: FrameKind.Output, payload: encodeRaw(output.terminalID, output.bytes) };
}

export function decodeInput(frame: Frame): TerminalInput {
  return decodeRaw(frame, FrameKind.Input);
}

export function decodeOutput(frame: Frame): TerminalOutput {
  return decodeRaw(frame, FrameKind.Output);
}
