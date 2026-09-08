import { describe, expect, test } from "bun:test";

import type { TerminalID } from "@janela/core";

import { FrameError, FrameKind, encodeFrame, frameDecoder } from "./frame.ts";
import type { Frame, FrameErrorKind } from "./frame.ts";
import {
  RAW_HEADER_LENGTH,
  decodeClientMessage,
  decodeDaemonMessage,
  decodeInput,
  decodeOutput,
  encodeClientMessage,
  encodeDaemonMessage,
  encodeInput,
  encodeOutput,
} from "./message-coder.ts";

/** Every hex digit, so an endianness or offset slip shows up as wrong bytes. */
const TERMINAL_ID = "01234567-89ab-cdef-0123-456789abcdef" as TerminalID;

const HEADER_BYTES = [
  0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
];

/** The `FrameError.detail` a call produces, or a failure if it produces none. */
function detailOf(run: () => void): FrameErrorKind {
  try {
    run();
  } catch (error) {
    if (error instanceof FrameError) return error.detail;
    throw error;
  }
  throw new Error("expected a FrameError");
}

/** Round-trips a frame through the wire form, split at `split`. */
function throughTheWire(frame: Frame, split: number): Frame {
  const encoded = encodeFrame(frame);
  const decoder = frameDecoder();
  const decoded = [
    ...decoder.push(encoded.subarray(0, split)),
    ...decoder.push(encoded.subarray(split)),
  ];
  decoder.end();

  const only = decoded[0];
  if (decoded.length !== 1 || only === undefined) {
    throw new Error(`expected one frame, got ${decoded.length}`);
  }
  return only;
}

describe("raw frame header", () => {
  test("the header is a UUID's sixteen bytes and nothing else", () => {
    expect(RAW_HEADER_LENGTH).toBe(16);
  });

  test("input and output carry the id big-endian, payload immediately after", () => {
    const bytes = new Uint8Array([1, 2, 3]);

    const input = encodeInput({ terminalID: TERMINAL_ID, bytes });
    expect(input.kind).toBe(FrameKind.Input);
    expect(Array.from(input.payload)).toEqual([...HEADER_BYTES, 1, 2, 3]);

    const output = encodeOutput({ terminalID: TERMINAL_ID, bytes });
    expect(output.kind).toBe(FrameKind.Output);
    expect(Array.from(output.payload)).toEqual([...HEADER_BYTES, 1, 2, 3]);
  });

  test("decoding gives a view past the header, not a copy of the bytes", () => {
    const frame = encodeInput({ terminalID: TERMINAL_ID, bytes: new Uint8Array([7, 8]) });
    const decoded = decodeInput(frame);

    expect(decoded.terminalID).toBe(TERMINAL_ID);
    expect(decoded.bytes.buffer).toBe(frame.payload.buffer);
    expect(decoded.bytes.byteOffset).toBe(frame.payload.byteOffset + RAW_HEADER_LENGTH);
  });

  test("bytes JSON could not carry survive a split inside the header", () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x80, 0x00, 0xc0]);
    // 5 framing bytes plus 7 of the raw header: the split lands mid-UUID.
    const frame = throughTheWire(encodeOutput({ terminalID: TERMINAL_ID, bytes }), 12);
    const decoded = decodeOutput(frame);

    expect(decoded.terminalID).toBe(TERMINAL_ID);
    expect(Array.from(decoded.bytes)).toEqual(Array.from(bytes));
  });

  test("decoding is total over sixteen bytes: never a trap, never a lookup", () => {
    const nil = decodeOutput({
      kind: FrameKind.Output,
      payload: new Uint8Array(RAW_HEADER_LENGTH),
    });
    expect(nil.terminalID).toBe("00000000-0000-0000-0000-000000000000" as TerminalID);
    expect(nil.bytes.length).toBe(0);

    const ones = decodeOutput({
      kind: FrameKind.Output,
      payload: new Uint8Array(RAW_HEADER_LENGTH).fill(0xff),
    });
    expect(ones.terminalID).toBe("ffffffff-ffff-ffff-ffff-ffffffffffff" as TerminalID);
  });

  test("an uppercase id encodes to the same bytes and comes back lowercase", () => {
    const upper = TERMINAL_ID.toUpperCase() as TerminalID;
    const frame = encodeInput({ terminalID: upper, bytes: new Uint8Array(0) });

    expect(Array.from(frame.payload)).toEqual(HEADER_BYTES);
    expect(decodeInput(frame).terminalID).toBe(TERMINAL_ID);
  });

  test("a payload too short to hold a header is a protocol error", () => {
    const payload = new Uint8Array(RAW_HEADER_LENGTH - 1);
    expect(detailOf(() => void decodeOutput({ kind: FrameKind.Output, payload }))).toEqual({
      kind: "rawHeaderTooShort",
      received: 15,
    });
  });

  test("a frame of the wrong kind is a direction violation, not a coercion", () => {
    const control = { kind: FrameKind.Control, payload: new Uint8Array(RAW_HEADER_LENGTH) };
    expect(detailOf(() => void decodeInput(control))).toEqual({
      kind: "unexpectedKind",
      expected: FrameKind.Input,
      received: FrameKind.Control,
    });
  });

  test("an id that is not a UUID is a caller bug, not something to encode", () => {
    const bytes = new Uint8Array(0);
    expect(() => encodeInput({ terminalID: "not-a-uuid" as TerminalID, bytes })).toThrow(TypeError);
    expect(() =>
      encodeInput({ terminalID: "0123456g-89ab-cdef-0123-456789abcdef" as TerminalID, bytes }),
    ).toThrow(TypeError);
    expect(() =>
      encodeInput({ terminalID: "0123456789ab-cdef-0123-456789abcdefx" as TerminalID, bytes }),
    ).toThrow(TypeError);
  });
});

describe("control frame coding", () => {
  test("a client message round-trips through the wire form", () => {
    const message = {
      type: "resize",
      terminalID: TERMINAL_ID,
      size: { columns: 120, rows: 40 },
    } as const;

    expect(decodeClientMessage(throughTheWire(encodeClientMessage(message), 4))).toEqual(message);
  });

  test("a daemon message round-trips through the wire form", () => {
    const message = { type: "terminalExited", terminalID: TERMINAL_ID, code: 0 } as const;

    expect(decodeDaemonMessage(throughTheWire(encodeDaemonMessage(message), 9))).toEqual(message);
  });

  test("malformed control frames close the connection and say nothing else", () => {
    const notJSON = { kind: FrameKind.Control, payload: new TextEncoder().encode("{") };
    expect(detailOf(() => void decodeClientMessage(notJSON))).toEqual({
      kind: "malformedControl",
    });

    const notUTF8 = { kind: FrameKind.Control, payload: new Uint8Array([0xff]) };
    expect(detailOf(() => void decodeClientMessage(notUTF8))).toEqual({
      kind: "malformedControl",
    });
  });

  test("routing terminal traffic through the control path is refused", () => {
    const payload = new TextEncoder().encode(
      JSON.stringify({ type: "input", terminalID: TERMINAL_ID }),
    );

    expect(detailOf(() => void decodeClientMessage({ kind: FrameKind.Control, payload }))).toEqual({
      kind: "malformedControl",
    });
  });

  test("a raw frame is not a control frame", () => {
    const raw = encodeInput({ terminalID: TERMINAL_ID, bytes: new Uint8Array(0) });

    expect(detailOf(() => void decodeDaemonMessage(raw))).toEqual({
      kind: "unexpectedKind",
      expected: FrameKind.Control,
      received: FrameKind.Input,
    });
  });
});
