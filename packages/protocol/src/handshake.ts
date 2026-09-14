/**
 * The first frame on every connection, in both directions.
 *
 * Nothing else is accepted until this is exchanged. The daemon may be older or
 * newer than the client — after an app update it is routinely older, and it is
 * holding the user's live terminals while being so.
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
 * 5  A repaint carries the negotiated grid: `fullRepaint` emits
 *    `CSI 8 ; rows ; cols t` between its RIS and the screen, and a client is
 *    re-sent one whenever the negotiation moves or overrules its viewport. The
 *    size travels in the raw output frame rather than as a control message
 *    because it belongs to the same ordered stream as the bytes it describes —
 *    a size arriving out of band would paint one geometry's screen into
 *    another's grid.
 * 6  `projectBranches` and `moveTab` join `ClientMessage`, and
 *    `SessionCreationIntent`'s `inProject` case gains an optional `branch` to
 *    check out in the project's own directory. A "new session" dialog can then
 *    offer a branch and a place to put it, and a tab drag survives the next
 *    state snapshot because the daemon owns the order.
 * ```
 */
export const PROTOCOL_VERSION = 6;

/**
 * Oldest version we still accept.
 *
 * Also 6, because a v5 peer does not degrade — it *disconnects*. Its
 * `decodeClientMessage` matches the discriminant against an exhaustive table
 * (`CLIENT_MESSAGE_TYPES` in message-coder.ts) and throws `malformedControl`
 * for anything absent from it, and the daemon's read loop turns that into a
 * closed connection rather than a `failed` reply: the strictness is deliberate,
 * because it is what keeps terminal traffic out of the control path. So a v6
 * client meeting a v5 daemon would lose its connection the moment a user opened
 * the new-session dialog, with no reply to correlate and no explanation. A
 * refusal a person can read beats a socket that drops on a menu click.
 *
 * As at v5: a v5 peer's `hello` is answered with `refused` /
 * `incompatibleVersion` carrying this range, the daemon keeps running and no
 * terminal is touched; a v6 client meeting a v5 daemon refuses on its own side
 * and tells the skew story — "the background service is older", whose only
 * button is "Restart the background service" — rather than reporting a
 * handshake failure. Nothing after `hello` is decoded from a refused peer.
 */
export const MINIMUM_SUPPORTED_VERSION = 6;

/**
 * Whether the two version ranges overlap: each side's current version must be at
 * least the other's minimum.
 *
 * Symmetric, and deliberately not "the versions are equal": after an app update
 * the daemon is routinely the older peer and must keep serving the terminals it
 * is holding while it says so.
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
 * situation and offers a restart.
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
