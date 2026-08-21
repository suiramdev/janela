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
  | { readonly kind: "truncated"; readonly expected: number; readonly received: number };

export class FrameError extends Error {
  readonly detail: FrameErrorKind;

  constructor(detail: FrameErrorKind) {
    super(`frame error: ${detail.kind}`);
    this.name = "FrameError";
    this.detail = detail;
  }
}

/** Serialises one frame, header included. */
export function encodeFrame(frame: Frame): Uint8Array {
  void frame;
  throw new Error(`not implemented: encodeFrame`);
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
   * @throws {FrameError} when a length prefix exceeds the bound or a kind byte is
   * unknown. The caller closes the connection; nothing else is affected.
   */
  push(chunk: Uint8Array): readonly Frame[];
  /** Bytes buffered awaiting completion. Bounded by `MAXIMUM_PAYLOAD_LENGTH`. */
  readonly pending: number;
}

export function frameDecoder(): FrameDecoder {
  throw new Error(`not implemented: frameDecoder`);
}
