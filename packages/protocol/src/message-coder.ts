import type { Frame } from "./frame.ts";
import type { ClientMessage, DaemonMessage, TerminalInput, TerminalOutput } from "./message.ts";

/**
 * Turns messages into frames and back.
 *
 * Free functions rather than methods on the message types, because the encoding is
 * a property of the *protocol version*, not of the message. When version 2 encodes
 * control frames differently, this is the only place that changes.
 */

/**
 * JSON, for the reason given in ADR 0016: control traffic is rare and small, and
 * a frame you can read in a log is worth more than the bytes it costs.
 */
export function encodeClientMessage(message: ClientMessage): Frame {
  void message;
  throw new Error(`not implemented: encodeClientMessage`);
}
export function encodeDaemonMessage(message: DaemonMessage): Frame {
  void message;
  throw new Error(`not implemented: encodeDaemonMessage`);
}

/**
 * @throws when the payload is not a message of the expected shape. A malformed
 * control frame closes the connection and nothing else.
 */
export function decodeClientMessage(frame: Frame): ClientMessage {
  void frame;
  throw new Error(`not implemented: decodeClientMessage`);
}
export function decodeDaemonMessage(frame: Frame): DaemonMessage {
  void frame;
  throw new Error(`not implemented: decodeDaemonMessage`);
}

// TODO: `input` and `output` frames bypass the JSON path entirely — they carry
// raw bytes with the terminal id in a small fixed-width header, because base64
// inside JSON would inflate the hot path by a third and add two passes per frame.
// Encode that header here so both sides agree in one place.
//
// The header is 16 bytes: the terminal id's UUID, big-endian, with the payload
// following immediately. A UUID rather than a small integer handle because a
// handle would need a per-connection table on both sides, and the id is already
// the thing every other message names.
//
// Measured in the migration spikes: a coalesced repaint is typically 140 bytes to
// a few KB, so a 16-byte header is under 10% on the small end. A per-connection
// integer handle would save 12 of those bytes and cost a table, a lifecycle and a
// class of bug where the two sides disagree about what handle 3 means.

/** Wraps terminal input in an `Input` frame. Client → daemon. */
export function encodeInput(input: TerminalInput): Frame {
  void input;
  throw new Error(`not implemented: encodeInput`);
}

/** Wraps repaint bytes in an `Output` frame. Daemon → client. */
export function encodeOutput(output: TerminalOutput): Frame {
  void output;
  throw new Error(`not implemented: encodeOutput`);
}

/**
 * Reads the fixed-width header off a raw frame.
 *
 * Returns a view into the frame's payload rather than a copy: this runs once per
 * frame per attached client and a copy here is a copy on the hot path.
 */
export function decodeInput(frame: Frame): TerminalInput {
  void frame;
  throw new Error(`not implemented: decodeInput`);
}
export function decodeOutput(frame: Frame): TerminalOutput {
  void frame;
  throw new Error(`not implemented: decodeOutput`);
}
