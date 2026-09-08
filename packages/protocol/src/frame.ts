import type { TerminalID } from "@janela/core";

import { byteAt, readUint32BE, writeUint32BE } from "./bytes.ts";

/**
 * One unit on the wire.
 *
 * Length-prefixed rather than delimited, because terminal payloads are arbitrary
 * bytes and there is no byte we could reserve as a separator.
 *
 * ```text
 * ┌────────────┬─────────┬──────────────────────┐
 * │ length u32 │ kind u8 │ payload              │
 * │ big-endian │         │ JSON, or raw bytes   │
 * └────────────┴─────────┴──────────────────────┘
 * ```
 *
 * `length` counts the payload only. See docs/decisions/0016-daemon-protocol.md.
 */
export interface Frame {
  readonly kind: FrameKind;
  readonly payload: Uint8Array;
}

/**
 * What the payload is, so a reader knows whether to decode it.
 *
 * Deliberately tiny. Control traffic is rare and small, so it pays JSON's cost
 * for readability in logs; terminal traffic is the hot path and is never encoded
 * at all. A third high-frequency kind would be a design smell worth an argument
 * first.
 */
export const FrameKind = {
  /** A control message, JSON-encoded. */
  Control: 1,
  /** Terminal input, client → daemon. Raw bytes. */
  Input: 2,
  /** Terminal output — repaint sequences, daemon → client. Raw bytes. */
  Output: 3,
} as const;

export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind];

/**
 * Largest payload we will accept, in bytes.
 *
 * An unbounded length prefix read off a socket is a memory-exhaustion bug waiting
 * for a malformed first packet. 8 MB is far above any legitimate frame — a full
 * repaint of a very large grid measured well under 1 MB in the migration spikes —
 * and far below anything that would hurt.
 */
export const MAXIMUM_PAYLOAD_LENGTH = 8 * 1024 * 1024;

/** Bytes of framing overhead ahead of every payload. */
export const FRAME_HEADER_LENGTH = 5;

/**
 * What went wrong reading a frame.
 *
 * Every case here is fatal to the *connection* and to nothing else. A daemon that
 * dies because one client sent nonsense would take the user's terminals with it.
 */
export type FrameErrorKind =
  /** `length` exceeded `MAXIMUM_PAYLOAD_LENGTH`. */
  | { readonly kind: "payloadTooLarge"; readonly claimed: number }
  /**
   * The `kind` byte is not one we know. Not forward-compatible on purpose: a peer
   * that speaks a kind we do not know has failed the handshake's job.
   */
  | { readonly kind: "unknownKind"; readonly byte: number }
  /** The peer went away mid-frame. */
  | { readonly kind: "truncated"; readonly expected: number; readonly received: number }
  /** A raw frame's payload is shorter than `RAW_HEADER_LENGTH`. */
  | { readonly kind: "rawHeaderTooShort"; readonly received: number }
  /**
   * A frame of one kind reached the decoder for another — a direction violation
   * (a client sent `Output`) or a caller bug on this side.
   */
  | { readonly kind: "unexpectedKind"; readonly expected: FrameKind; readonly received: FrameKind }
  /**
   * A control frame that is not UTF-8 JSON, or whose `type` is not a member of
   * the union. The offending text is deliberately absent: it is peer-supplied.
   */
  | { readonly kind: "malformedControl" }
  /**
   * A raw frame named a terminal this side does not hold.
   *
   * Thrown by the *receiver* — the daemon's accept loop, the client's mirror —
   * never by the decoder, which has no table to look in. Close the connection and
   * log the id; never create the terminal it names.
   */
  | { readonly kind: "unknownTerminal"; readonly terminalID: TerminalID };

export class FrameError extends Error {
  readonly detail: FrameErrorKind;

  constructor(detail: FrameErrorKind) {
    super(`frame error: ${detail.kind}`);
    this.name = "FrameError";
    this.detail = detail;
  }
}

/**
 * Largest a whole frame can be, header included. The decoder's buffer bound.
 */
const MAXIMUM_FRAME_LENGTH = FRAME_HEADER_LENGTH + MAXIMUM_PAYLOAD_LENGTH;

/**
 * Serialises one frame, header included.
 *
 * One contiguous buffer and therefore one copy of the payload, because Bun's
 * sockets do not coalesce writes: a header write followed by a payload write is
 * two syscalls per frame, and at repaint rates that costs more than the copy.
 *
 * @throws {FrameError} `payloadTooLarge` — we never emit a frame a peer is
 * required to reject.
 */
export function encodeFrame(frame: Frame): Uint8Array {
  if (frame.payload.length > MAXIMUM_PAYLOAD_LENGTH) {
    throw new FrameError({ kind: "payloadTooLarge", claimed: frame.payload.length });
  }

  const encoded = new Uint8Array(FRAME_HEADER_LENGTH + frame.payload.length);
  writeUint32BE(encoded, 0, frame.payload.length);
  encoded[FRAME_HEADER_LENGTH - 1] = frame.kind;
  encoded.set(frame.payload, FRAME_HEADER_LENGTH);
  return encoded;
}

/**
 * Incremental frame reader.
 *
 * Stateful because a socket delivers arbitrary chunk boundaries: a frame header
 * can arrive split across two reads, and a reader that assumes otherwise works
 * until the day it does not.
 */
export interface FrameDecoder {
  /**
   * Feeds bytes and returns whatever complete frames they completed.
   *
   * Returned frames are *views*: a frame that completed inside `chunk` aliases
   * `chunk`, and one that completed across chunks aliases the decoder's own
   * buffer. Either way they are valid only until the next `push` — the same rule
   * as `TerminalBytes` in `@janela/pty`. Consume or copy before pushing again.
   *
   * @throws {FrameError} when a length prefix exceeds the bound or a kind byte is
   * unknown. The caller closes the connection; nothing else is affected. A
   * decoder that has thrown is finished — discard it with the connection.
   */
  push(chunk: Uint8Array): readonly Frame[];
  /**
   * Signals that the peer closed the stream.
   *
   * @throws {FrameError} `truncated` when a frame was in progress. `expected` is
   * the frame's full size, header included, once the header has arrived, and
   * `FRAME_HEADER_LENGTH` while it has not; `received` is `pending`.
   */
  end(): void;
  /** Bytes buffered awaiting completion. Bounded by `MAXIMUM_PAYLOAD_LENGTH`. */
  readonly pending: number;
}

/** What a validated frame header said. */
interface Header {
  readonly length: number;
  readonly kind: FrameKind;
}

/**
 * Reads and checks the five header bytes at `offset`, which must be present.
 *
 * Called the moment the fifth byte is available and *before* any buffer is grown
 * for the body: an over-long claim is an error, never an allocation.
 */
function validateHeader(bytes: Uint8Array, offset: number): Header {
  const length = readUint32BE(bytes, offset);
  if (length > MAXIMUM_PAYLOAD_LENGTH) {
    throw new FrameError({ kind: "payloadTooLarge", claimed: length });
  }

  const byte = byteAt(bytes, offset + FRAME_HEADER_LENGTH - 1);
  if (byte === FrameKind.Control || byte === FrameKind.Input || byte === FrameKind.Output) {
    return { length, kind: byte };
  }
  throw new FrameError({ kind: "unknownKind", byte });
}

export function frameDecoder(): FrameDecoder {
  /** Bytes of a frame that has not completed yet. Grows, never shrinks. */
  let buffer = new Uint8Array(0);
  /** How much of `buffer` is meaningful. */
  let held = 0;
  /** Full size of the frame in progress, or 0 while its header is incomplete. */
  let expected = 0;
  /** The frame in progress' kind, known as soon as `expected` is. */
  let expectedKind: FrameKind = FrameKind.Control;

  /** Grows `buffer` to hold `needed` bytes, carrying the `held` bytes over. */
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
      /** Whether a frame returned by this call aliases `buffer`. */
      let aliased = false;

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
        aliased = true;
        held = 0;
        expected = 0;
      }

      while (chunk.length - offset >= FRAME_HEADER_LENGTH) {
        const header = validateHeader(chunk, offset);
        const total = FRAME_HEADER_LENGTH + header.length;
        if (chunk.length - offset < total) {
          // Header checked, body still coming: remember what to buffer for.
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
        // `expected` is non-zero only if the loop above broke, which needs five
        // bytes; a shorter remainder is a header we do not know the size of yet.
        const needed = rest < FRAME_HEADER_LENGTH ? FRAME_HEADER_LENGTH : expected;
        if (aliased) {
          // A frame that completed inside `buffer` is being returned from this
          // call, and buffering the remainder there would overwrite the payload
          // we just handed out. One allocation, only on this boundary.
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
        kind: "truncated",
        expected: expected > 0 ? expected : FRAME_HEADER_LENGTH,
        received: held,
      });
    },

    get pending(): number {
      return held;
    },
  };
}
