import { describe, expect, test } from "bun:test";

import { Effect, Option, Result } from "effect";

import {
  FRAME_HEADER_LENGTH,
  FrameError,
  FrameKind,
  MAXIMUM_PAYLOAD_LENGTH,
  PayloadTooLarge,
  TruncatedFrame,
  UnknownFrameKind,
  encodeFrame,
  frameDecoder,
} from "./frame.ts";
import type { Frame, FrameErrorReason } from "./frame.ts";
import { MINIMUM_SUPPORTED_VERSION, PROTOCOL_VERSION } from "./handshake.ts";

describe("framing bounds", () => {
  test("an unbounded length prefix is a memory-exhaustion bug waiting for a bad packet", () => {
    expect(MAXIMUM_PAYLOAD_LENGTH).toBe(8 * 1024 * 1024);
  });

  test("header is length u32 plus kind u8", () => {
    expect(FRAME_HEADER_LENGTH).toBe(5);
  });

  test("exactly three frame kinds; a fourth high-frequency one needs an argument", () => {
    expect(Object.keys(FrameKind)).toEqual(["Control", "Input", "Output"]);
  });
});

describe("protocol versioning", () => {
  test("there is no minor version: a change is compatible or it is not", () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(MINIMUM_SUPPORTED_VERSION).toBeLessThanOrEqual(PROTOCOL_VERSION);
  });

  test("two client messages and two snapshot fields left the wire: version 14, speaking 14 only", () => {
    expect(PROTOCOL_VERSION).toBe(14);
    expect(MINIMUM_SUPPORTED_VERSION).toBe(14);
  });
});

interface Decoded {
  readonly kind: FrameKind;
  readonly payload: readonly number[];
}

function decodeAll(chunks: readonly Uint8Array[]): readonly Decoded[] {
  const decoder = frameDecoder();
  const decoded: Decoded[] = [];

  for (const chunk of chunks) {
    for (const frame of decoder.push(chunk)) {
      decoded.push({ kind: frame.kind, payload: Array.from(frame.payload) });
    }
  }

  decoder.end();

  return decoded;
}

function reasonOf(run: () => void): FrameErrorReason {
  const outcome = Effect.runSync(Effect.result(Effect.try({ try: run, catch: (cause) => cause })));
  const failure = Result.getFailure(outcome);

  if (Option.isNone(failure)) throw new Error("expected a FrameError");

  const error = failure.value;

  if (!(error instanceof FrameError)) throw error;

  return error.reason;
}

function header(length: number, kind: number): Uint8Array {
  return new Uint8Array([
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
    kind,
  ]);
}

describe("framing", () => {
  test("a frame is a big-endian length, a kind byte, then the payload", () => {
    const encoded = encodeFrame({ kind: FrameKind.Output, payload: new Uint8Array([0xde, 0xad]) });

    expect(Array.from(encoded)).toEqual([0, 0, 0, 2, 3, 0xde, 0xad]);
  });

  test("a socket splits where it likes: every boundary decodes identically", () => {
    const frames: readonly Frame[] = [
      { kind: FrameKind.Output, payload: new Uint8Array(40).fill(0xaa) },
      { kind: FrameKind.Control, payload: new Uint8Array([0x68, 0x69]) },
      { kind: FrameKind.Input, payload: new Uint8Array(19).fill(0xab) },
      { kind: FrameKind.Output, payload: new Uint8Array(0) },
    ];
    const encoded = frames.map((frame) => encodeFrame(frame));
    const stream = new Uint8Array(encoded.reduce((total, one) => total + one.length, 0));
    let at = 0;

    for (const one of encoded) {
      stream.set(one, at);
      at += one.length;
    }

    const whole = decodeAll([stream]);

    expect(whole).toEqual(
      frames.map((frame) => ({ kind: frame.kind, payload: Array.from(frame.payload) })),
    );

    for (let split = 0; split <= stream.length; split += 1) {
      expect(decodeAll([stream.subarray(0, split), stream.subarray(split)])).toEqual(whole);
    }

    for (let first = 0; first <= stream.length; first += 1) {
      for (let second = first; second <= stream.length; second += 1) {
        const chunks = [
          stream.subarray(0, first),
          stream.subarray(first, second),
          stream.subarray(second),
        ];

        expect(decodeAll(chunks)).toEqual(whole);
      }
    }

    expect(decodeAll(Array.from(stream, (byte) => new Uint8Array([byte])))).toEqual(whole);
  });

  test("a decoded payload is a view into the caller's chunk, not a copy", () => {
    const chunk = encodeFrame({ kind: FrameKind.Control, payload: new Uint8Array([1, 2, 3]) });
    const decoded = frameDecoder().push(chunk);

    expect(decoded.length).toBe(1);
    expect(decoded[0]?.payload.buffer).toBe(chunk.buffer);
    expect(decoded[0]?.payload.byteOffset).toBe(FRAME_HEADER_LENGTH);
  });

  test("an over-long claim is rejected before a byte of it is buffered", () => {
    const claimed = MAXIMUM_PAYLOAD_LENGTH + 1;
    const decoder = frameDecoder();

    expect(reasonOf(() => void decoder.push(header(claimed, FrameKind.Output)))).toEqual(
      new PayloadTooLarge({ claimed }),
    );
    expect(decoder.pending).toBe(0);
  });

  test("a length prefix with the high bit set is over-long, not negative", () => {
    expect(reasonOf(() => void frameDecoder().push(header(0xffffffff, FrameKind.Input)))).toEqual(
      new PayloadTooLarge({ claimed: 0xffffffff }),
    );
  });

  test("an unknown kind byte is a failed handshake, not a frame to skip", () => {
    expect(reasonOf(() => void frameDecoder().push(header(0, 9)))).toEqual(
      new UnknownFrameKind({ byte: 9 }),
    );
  });

  test("encoding never emits a frame a peer is required to reject", () => {
    const payload = new Uint8Array(MAXIMUM_PAYLOAD_LENGTH + 1);

    expect(reasonOf(() => void encodeFrame({ kind: FrameKind.Output, payload }))).toEqual(
      new PayloadTooLarge({ claimed: payload.length }),
    );
  });

  test("a stream that closes mid-frame is truncation, not an empty read", () => {
    const partial = frameDecoder();
    partial.push(
      encodeFrame({ kind: FrameKind.Input, payload: new Uint8Array(10) }).subarray(0, 8),
    );

    expect(partial.pending).toBe(8);
    expect(reasonOf(() => partial.end())).toEqual(
      new TruncatedFrame({ expected: 15, received: 8 }),
    );

    const headerOnly = frameDecoder();
    headerOnly.push(new Uint8Array([0, 0]));

    expect(headerOnly.pending).toBe(2);
    expect(reasonOf(() => headerOnly.end())).toEqual(
      new TruncatedFrame({ expected: FRAME_HEADER_LENGTH, received: 2 }),
    );

    const onABoundary = frameDecoder();
    onABoundary.push(encodeFrame({ kind: FrameKind.Control, payload: new Uint8Array([1]) }));

    expect(onABoundary.pending).toBe(0);
    expect(() => onABoundary.end()).not.toThrow();
  });
});
