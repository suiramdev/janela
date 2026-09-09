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
 * 3  `removalPlan` joins `ClientMessage`; `attach.viewport` becomes optional,
 *    meaning input and scope without rendering; every state announcement is a
 *    full snapshot, because merge-by-id cannot express a removal;
 *    `saveLaunchProfile`, `removeLaunchProfile` and `createTerminal` join it too,
 *    and `StateUpdate` carries the launch profiles with their availability.
 * 4  `createTerminal.placement` (a split, persisted by the daemon), and
 *    `removeTerminal` and `restartTerminal` join `ClientMessage`.
 * ```
 */
export const PROTOCOL_VERSION = 4;

/**
 * Oldest version we still accept.
 *
 * Also 4, because neither v4 change degrades: a v3 daemon meeting a
 * `removeTerminal` falls off the end of its dispatch switch and answers nothing,
 * so the client waits forever for a reply that is never coming, and a v3 daemon
 * meeting `createTerminal.placement` would silently ignore it and open a tab
 * where the user asked for a split.
 * A v3 peer's `hello` is answered with `refused` / `incompatibleVersion` carrying
 * this range, the daemon keeps running and no terminal is touched (ADR 0016 §
 * Handshake, ADR 0017); a v4 client meeting a v3 daemon refuses on its own side
 * and tells the skew story — "the background service is older", whose only
 * button is "Restart the background service" — rather than reporting a handshake
 * failure. Nothing after `hello` is decoded from a refused peer.
 */
export const MINIMUM_SUPPORTED_VERSION = 4;

/**
 * Whether the two version ranges overlap: each side's current version must be at
 * least the other's minimum.
 *
 * Symmetric, and deliberately not "the versions are equal": after an app update
 * the daemon is routinely the older peer and must keep serving the terminals it
 * is holding while it says so (ADR 0016 § Handshake).
 */
export function isCompatible(mine: Hello, other: Hello): boolean {
  return (
    other.protocolVersion >= mine.minimumSupported && mine.protocolVersion >= other.minimumSupported
  );
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
