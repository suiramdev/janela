import type { TerminalID } from "@janela/core";

import { byteAt } from "./bytes.ts";
import { FrameError, FrameKind } from "./frame.ts";
import type { Frame } from "./frame.ts";
import type { ClientMessage, DaemonMessage, TerminalInput, TerminalOutput } from "./message.ts";

/**
 * Turns messages into frames and back.
 *
 * Free functions rather than methods on the message types, because the encoding is
 * a property of the *protocol version*, not of the message. When version 2 encodes
 * control frames differently, this is the only place that changes.
 */

/** UTF-8 in both directions; `fatal` so invalid bytes are a protocol error. */
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * JSON, for the reason given in ADR 0016: control traffic is rare and small, and
 * a frame you can read in a log is worth more than the bytes it costs.
 */
export function encodeClientMessage(message: ClientMessage): Frame {
  return { kind: FrameKind.Control, payload: encoder.encode(JSON.stringify(message)) };
}
export function encodeDaemonMessage(message: DaemonMessage): Frame {
  return { kind: FrameKind.Control, payload: encoder.encode(JSON.stringify(message)) };
}

/**
 * Every `ClientMessage["type"]`, as a table.
 *
 * `satisfies` makes this exhaustive at compile time: a new member of the union
 * without a row here fails `typecheck` rather than being silently undecodable.
 */
const CLIENT_MESSAGE_TYPES = {
  hello: true,
  subscribe: true,
  addProject: true,
  removeProject: true,
  updateProjectSettings: true,
  createSession: true,
  removeSession: true,
  renameSession: true,
  attach: true,
  detach: true,
  startTerminal: true,
  stopTerminal: true,
  resize: true,
  snapshotText: true,
} as const satisfies Record<ClientMessage["type"], true>;

/** Every `DaemonMessage["type"]`, on the same terms. */
const DAEMON_MESSAGE_TYPES = {
  hello: true,
  refused: true,
  state: true,
  attention: true,
  terminalExited: true,
  acknowledged: true,
  failed: true,
  text: true,
} as const satisfies Record<DaemonMessage["type"], true>;

/**
 * Decodes a control frame as far as its discriminant, and no further.
 *
 * Discriminant-level only: `{"type":"input"}` is rejected because `input` is not
 * a member of either union, which is the rule rather than an omission — keeping
 * terminal traffic out of the control path is the whole reason it is not in
 * `ClientMessage`. Field-level validation belongs to the request dispatcher,
 * which has to answer a malformed request with a `failed` reply rather than by
 * closing the connection.
 *
 * `types` is a discriminant table, taken as `object` so `Object.hasOwn` does the
 * membership test without the table needing an index signature.
 *
 * @throws {FrameError} `unexpectedKind` for a non-control frame,
 * `malformedControl` for anything else. Neither error carries the payload text:
 * it is peer-supplied and this package does not decide what is safe to log.
 */
function decodeControl<Message>(frame: Frame, types: object): Message {
  if (frame.kind !== FrameKind.Control) {
    throw new FrameError({
      kind: "unexpectedKind",
      expected: FrameKind.Control,
      received: frame.kind,
    });
  }

  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(frame.payload));
  } catch {
    // Invalid UTF-8 (`TypeError`) and invalid JSON (`SyntaxError`) are the same
    // fact to the connection: the peer is not speaking this protocol.
    throw new FrameError({ kind: "malformedControl" });
  }

  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    typeof value.type !== "string" ||
    !Object.hasOwn(types, value.type)
  ) {
    throw new FrameError({ kind: "malformedControl" });
  }
  return value as Message;
}

/**
 * @throws when the payload is not a message of the expected shape. A malformed
 * control frame closes the connection and nothing else.
 */
export function decodeClientMessage(frame: Frame): ClientMessage {
  return decodeControl<ClientMessage>(frame, CLIENT_MESSAGE_TYPES);
}
export function decodeDaemonMessage(frame: Frame): DaemonMessage {
  return decodeControl<DaemonMessage>(frame, DAEMON_MESSAGE_TYPES);
}

/**
 * Bytes of fixed-width header ahead of a raw frame's payload: the terminal id's
 * UUID, big-endian, with the terminal's bytes following immediately.
 *
 * `Input` and `Output` frames bypass the JSON path entirely, because base64
 * inside JSON would inflate the hot path by a third and add two passes per frame.
 * The header is encoded here so both sides agree in one place.
 *
 * A UUID rather than a small integer handle because a handle would need a
 * per-connection table on both sides, and the id is already the thing every other
 * message names. Measured in the migration spikes: a coalesced repaint is
 * typically 140 bytes to a few KB, so 16 bytes is under 10% on the small end. A
 * per-connection integer handle would save 12 of those bytes and cost a table, a
 * lifecycle, and a class of bug where the two sides disagree about what handle 3
 * means.
 */
export const RAW_HEADER_LENGTH = 16;

/**
 * The 256 two-character lowercase hex strings, built once at module load.
 *
 * Constant, not state: `readTerminalID` runs once per raw frame per attached
 * client, and `toString(16).padStart(2, "0")` per byte there would be 16 string
 * allocations on the hot path instead of a lookup.
 */
const HEX_PAIRS: readonly string[] = Array.from({ length: 256 }, (_unused, byte) =>
  byte.toString(16).padStart(2, "0"),
);

/**
 * The one message a malformed id gets, as a function so the template is not
 * built on the success path — this runs once per keystroke and once per repaint.
 */
function notAUUID(id: string): TypeError {
  return new TypeError(`terminal id is not a UUID: ${id}`);
}

/** Hex digit value of a character code, or -1 if it is not one. */
function nibble(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  return -1;
}

/** Character code of `-`, the UUID group separator. */
const DASH = 0x2d;

/**
 * Writes a UUID's 16 bytes into `target` at `offset`, big-endian.
 *
 * Walks the string with `charCodeAt` rather than splitting or matching it: no
 * intermediate strings, no array, nothing proportional to anything.
 *
 * @throws {TypeError} when `id` is not a canonical 8-4-4-4-12 UUID. A caller bug,
 * not a protocol error — ids reach this side already validated by `identifier()`
 * — and safe to name in the message, since an id is not private data.
 */
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

/**
 * Reads 16 bytes as a canonical lowercase UUID.
 *
 * Total over any 16 bytes: every input is some UUID, so this never traps and
 * never consults a table. The cast is the re-branding site for ids read off the
 * wire — the wire equivalent of `identifier()` in `@janela/core`, which cannot be
 * used here because validating what we just formatted ourselves would be a
 * round trip to prove nothing.
 */
function readTerminalID(source: Uint8Array, offset: number): TerminalID {
  let text = "";
  for (let index = 0; index < RAW_HEADER_LENGTH; index += 1) {
    if (index === 4 || index === 6 || index === 8 || index === 10) text += "-";
    const pair = HEX_PAIRS[byteAt(source, offset + index)];
    if (pair === undefined) {
      // Unreachable: `byteAt` returns a `Uint8Array` element, so 0..255.
      throw new RangeError(`not a byte at offset ${offset + index}`);
    }
    text += pair;
  }
  return text as TerminalID;
}

/**
 * Builds a raw frame's payload: the id's header, then the bytes.
 *
 * The id is written in place, with no intermediate allocation. The bytes are
 * copied once, because `Frame.payload` is one contiguous array — a scatter/gather
 * `Frame` would be a design change for every transport, to save one copy of a
 * few hundred bytes.
 */
function encodeRaw(terminalID: TerminalID, bytes: Uint8Array): Uint8Array {
  const payload = new Uint8Array(RAW_HEADER_LENGTH + bytes.length);
  writeTerminalID(terminalID, payload, 0);
  payload.set(bytes, RAW_HEADER_LENGTH);
  return payload;
}

/**
 * Reads the fixed-width header off a raw frame.
 *
 * Returns a view into the frame's payload rather than a copy: this runs once per
 * frame per attached client and a copy here is a copy on the hot path. The only
 * allocations are the id string, the returned record and the view object — none
 * of them proportional to the payload.
 *
 * Decoding is total: any 16 bytes are a terminal id, so this never throws for an
 * id it has not seen, because it has no way to know. **The receiver must look the
 * id up and, on a miss, throw `FrameError({ kind: "unknownTerminal", terminalID })`,
 * log the id and close that connection — never create the terminal it names.**
 *
 * @throws {FrameError} `unexpectedKind` when the frame is not the kind asked for,
 * `rawHeaderTooShort` when there is not even a header.
 */
function decodeRaw(
  frame: Frame,
  expected: FrameKind,
): { readonly terminalID: TerminalID; readonly bytes: Uint8Array } {
  if (frame.kind !== expected) {
    throw new FrameError({ kind: "unexpectedKind", expected, received: frame.kind });
  }
  if (frame.payload.length < RAW_HEADER_LENGTH) {
    throw new FrameError({ kind: "rawHeaderTooShort", received: frame.payload.length });
  }
  return {
    terminalID: readTerminalID(frame.payload, 0),
    bytes: frame.payload.subarray(RAW_HEADER_LENGTH),
  };
}

/** Wraps terminal input in an `Input` frame. Client → daemon. */
export function encodeInput(input: TerminalInput): Frame {
  return { kind: FrameKind.Input, payload: encodeRaw(input.terminalID, input.bytes) };
}

/** Wraps repaint bytes in an `Output` frame. Daemon → client. */
export function encodeOutput(output: TerminalOutput): Frame {
  return { kind: FrameKind.Output, payload: encodeRaw(output.terminalID, output.bytes) };
}

/** See `decodeRaw`: the result's `bytes` are a view, valid as long as the frame. */
export function decodeInput(frame: Frame): TerminalInput {
  return decodeRaw(frame, FrameKind.Input);
}
export function decodeOutput(frame: Frame): TerminalOutput {
  return decodeRaw(frame, FrameKind.Output);
}
