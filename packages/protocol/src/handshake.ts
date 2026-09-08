/**
 * The first frame on every connection, in both directions.
 *
 * Nothing else is accepted until this is exchanged. The daemon may be older or
 * newer than the client — after an app update it is routinely older, and it is
 * holding the user's live terminals while being so.
 *
 * See docs/decisions/0016-daemon-protocol.md.
 */
export interface Hello {
  /** Incremented on any breaking change to messages or framing. */
  readonly protocolVersion: number;

  /**
   * Oldest version this peer can still speak. The overlap of the two ranges
   * decides whether the connection proceeds.
   */
  readonly minimumSupported: number;

  /**
   * "Janela.app", "janela-cli". Shown to the user when explaining what is
   * connected, and logged. Never used for authorisation.
   */
  readonly clientName: string;

  /**
   * Unused over the local socket, where the OS vouches for the peer. Present from
   * v1 because adding a field to a shipped protocol is a breaking change and this
   * one costs nothing to carry.
   */
  readonly credential?: Credential;
}

/**
 * Proof of identity for transports the operating system cannot vouch for.
 *
 * Empty in v1 — the Unix socket authenticates by peer uid, which is stronger than
 * anything we would invent. A network transport must populate this, and must not
 * be allowed to reuse "the OS vouched for the peer".
 */
export type Credential = { readonly kind: "bearerToken"; readonly token: string };

/**
 * Bump on any breaking change. There is no minor version: a change is either
 * compatible, in which case it needs no number, or it is not.
 *
 * ```text
 * 1  scaffold: framing and JSON control messages. Raw frames had no defined
 *    encoding at all, so nothing ever spoke it.
 * 2  `Input`/`Output` payloads begin with a 16-byte big-endian UUID header (see
 *    `RAW_HEADER_LENGTH` in message-coder.ts); `FrameDecoder.end()` reports a
 *    stream that closed mid-frame.
 * ```
 */
export const PROTOCOL_VERSION = 2;

/**
 * Oldest version we still accept.
 *
 * Also 2: a v1 peer never had a raw-frame encoding to be compatible with, so
 * there is nothing to keep working. Its `hello` is answered with `refused` /
 * `incompatibleVersion` carrying this range, the daemon keeps running and no
 * terminal is touched (ADR 0016 § Handshake, ADR 0017), and the client explains
 * the restart rather than reporting a handshake failure. Nothing after `hello`
 * is decoded from a refused peer.
 */
export const MINIMUM_SUPPORTED_VERSION = 2;

/** Whether this peer can talk to one advertising `other`. */
export function isCompatible(mine: Hello, other: Hello): boolean {
  void mine;
  void other;
  throw new Error(`not implemented: isCompatible`);
}

/**
 * Why a connection was refused.
 *
 * Refusal never terminates the daemon or its terminals. The client explains the
 * situation and offers a restart; see docs/decisions/0017-daemon-lifecycle.md.
 */
export type HandshakeRefusal =
  /**
   * No overlap between the two version ranges. Carries the daemon's range so the
   * client can say "the running service is older" rather than "handshake failed".
   */
  | {
      readonly kind: "incompatibleVersion";
      readonly daemonMinimum: number;
      readonly daemonCurrent: number;
    }
  /**
   * The peer's uid is not ours. Logged with the pid, never explained to the peer
   * in detail.
   */
  | { readonly kind: "unauthorized" }
  /** A frame arrived before the handshake completed. */
  | { readonly kind: "protocolViolation" };
