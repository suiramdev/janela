import type { TerminalID } from "@janela/core";
import { Data, Match } from "effect";

import { byteAt, readUint32BE, writeUint32BE } from "./bytes.ts";

export interface Frame {
  readonly kind: FrameKind;
  readonly payload: Uint8Array;
}

export interface FrameDecoder {
  push(chunk: Uint8Array): readonly Frame[];
  end(): void;
  readonly pending: number;
}

interface Header {
  readonly length: number;
  readonly kind: FrameKind;
}

export type FrameErrorReason =
  | MalformedControl
  | PayloadTooLarge
  | RawHeaderTooShort
  | TruncatedFrame
  | UnexpectedFrameKind
  | UnknownFrameKind
  | UnknownTerminalFrame;

export const FrameKind = {
  Control: 1,
  Input: 2,
  Output: 3,
} as const;

export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind];

export const MAXIMUM_PAYLOAD_LENGTH = 8 * 1024 * 1024;

export const FRAME_HEADER_LENGTH = 5;

const MAXIMUM_FRAME_LENGTH = FRAME_HEADER_LENGTH + MAXIMUM_PAYLOAD_LENGTH;

export class PayloadTooLarge extends Data.TaggedClass("payloadTooLarge")<{
  readonly claimed: number;
}> {}

export class UnknownFrameKind extends Data.TaggedClass("unknownKind")<{
  readonly byte: number;
}> {}

export class TruncatedFrame extends Data.TaggedClass("truncated")<{
  readonly expected: number;
  readonly received: number;
}> {}

export class RawHeaderTooShort extends Data.TaggedClass("rawHeaderTooShort")<{
  readonly received: number;
}> {}

export class UnexpectedFrameKind extends Data.TaggedClass("unexpectedKind")<{
  readonly expected: FrameKind;
  readonly received: FrameKind;
}> {}

export class MalformedControl extends Data.TaggedClass("malformedControl")<Record<never, never>> {}

export class UnknownTerminalFrame extends Data.TaggedClass("unknownTerminal")<{
  readonly terminalID: TerminalID;
}> {}

export class FrameError extends Data.TaggedError("FrameError")<{
  readonly reason: FrameErrorReason;
}> {
  override get message(): string {
    return `frame error: ${frameErrorLabel(this)}`;
  }
}

export function frameErrorLabel(error: FrameError): string {
  return Match.value(error.reason).pipe(
    Match.tag("payloadTooLarge", () => "payloadTooLarge"),
    Match.tag("unknownKind", () => "unknownKind"),
    Match.tag("truncated", () => "truncated"),
    Match.tag("rawHeaderTooShort", () => "rawHeaderTooShort"),
    Match.tag("unexpectedKind", () => "unexpectedKind"),
    Match.tag("malformedControl", () => "malformedControl"),
    Match.tag("unknownTerminal", () => "unknownTerminal"),
    Match.exhaustive,
  );
}

export function encodeFrame(frame: Frame): Uint8Array {
  if (frame.payload.length > MAXIMUM_PAYLOAD_LENGTH) {
    throw new FrameError({ reason: new PayloadTooLarge({ claimed: frame.payload.length }) });
  }

  const encoded = new Uint8Array(FRAME_HEADER_LENGTH + frame.payload.length);
  writeUint32BE(encoded, 0, frame.payload.length);
  encoded[FRAME_HEADER_LENGTH - 1] = frame.kind;
  encoded.set(frame.payload, FRAME_HEADER_LENGTH);

  return encoded;
}

function validateHeader(bytes: Uint8Array, offset: number): Header {
  const length = readUint32BE(bytes, offset);

  if (length > MAXIMUM_PAYLOAD_LENGTH) {
    throw new FrameError({ reason: new PayloadTooLarge({ claimed: length }) });
  }

  const byte = byteAt(bytes, offset + FRAME_HEADER_LENGTH - 1);

  if (byte === FrameKind.Control || byte === FrameKind.Input || byte === FrameKind.Output) {
    return { length, kind: byte };
  }

  throw new FrameError({ reason: new UnknownFrameKind({ byte }) });
}

export function frameDecoder(): FrameDecoder {
  let buffer = new Uint8Array(0);
  let held = 0;
  let expected = 0;
  let expectedKind: FrameKind = FrameKind.Control;

  const reserve = (needed: number): void => {
    if (buffer.length >= needed) return;

    const doubled = Math.min(buffer.length * 2, MAXIMUM_FRAME_LENGTH);
    const grown = new Uint8Array(Math.max(needed, doubled));
    grown.set(buffer.subarray(0, held));
    buffer = grown;
  };

  return {
    push(chunk: Uint8Array): readonly Frame[] {
      const frames: Frame[] = [];
      let offset = 0;
      let returnsViewIntoBuffer = false;

      if (held > 0) {
        if (held < FRAME_HEADER_LENGTH) {
          const take = Math.min(FRAME_HEADER_LENGTH - held, chunk.length);
          buffer.set(chunk.subarray(0, take), held);
          held += take;
          offset += take;

          if (held < FRAME_HEADER_LENGTH) return frames;

          const header = validateHeader(buffer, 0);
          expected = FRAME_HEADER_LENGTH + header.length;
          expectedKind = header.kind;
          reserve(expected);
        }

        const take = Math.min(expected - held, chunk.length - offset);
        buffer.set(chunk.subarray(offset, offset + take), held);
        held += take;
        offset += take;

        if (held < expected) return frames;

        frames.push({
          kind: expectedKind,
          payload: buffer.subarray(FRAME_HEADER_LENGTH, expected),
        });
        returnsViewIntoBuffer = true;
        held = 0;
        expected = 0;
      }

      while (chunk.length - offset >= FRAME_HEADER_LENGTH) {
        const header = validateHeader(chunk, offset);
        const total = FRAME_HEADER_LENGTH + header.length;

        if (chunk.length - offset < total) {
          expected = total;
          expectedKind = header.kind;
          break;
        }

        frames.push({
          kind: header.kind,
          payload: chunk.subarray(offset + FRAME_HEADER_LENGTH, offset + total),
        });
        offset += total;
      }

      const rest = chunk.length - offset;

      if (rest > 0) {
        const needed = rest < FRAME_HEADER_LENGTH ? FRAME_HEADER_LENGTH : expected;

        if (returnsViewIntoBuffer) {
          buffer = new Uint8Array(needed);
        } else {
          reserve(needed);
        }

        buffer.set(chunk.subarray(offset), 0);
        held = rest;
      }

      return frames;
    },

    end(): void {
      if (held === 0) return;

      throw new FrameError({
        reason: new TruncatedFrame({
          expected: expected > 0 ? expected : FRAME_HEADER_LENGTH,
          received: held,
        }),
      });
    },

    get pending(): number {
      return held;
    },
  };
}
