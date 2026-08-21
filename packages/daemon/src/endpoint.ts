import { UserFacingError } from "@janela/support";

/**
 * Where the daemon listens, and who is allowed to talk to it.
 *
 * Two unglamorous constraints shape everything here, and both are easy to get wrong
 * in a way that only fails on someone else's machine.
 */

/**
 * Maximum bytes in `sockaddr_un.sun_path`, measured on macOS 26.
 *
 * This is why the socket does not live beside the database in Application Support:
 * that path is already 73 bytes for a 15-character home directory and grows with
 * the username, which leaves too little headroom. See
 * docs/decisions/0016-daemon-protocol.md.
 */
export const MAXIMUM_SOCKET_PATH_LENGTH = 104;

/**
 * `~/.janela/run/janelad.sock` — 40 bytes for a typical home directory.
 *
 * @throws {SocketPathTooLong} when the home directory is long enough that even this
 *   path does not fit. Rare, and worth failing loudly for: a truncated `sun_path`
 *   does not error, it silently addresses a *different* socket, which is a far worse
 *   outcome than not starting.
 */
export function defaultSocketPath(): string {
  throw new Error(`not implemented: defaultSocketPath`);
}

/**
 * Mode for the directory containing the socket.
 *
 * The socket is a capability: anything that can connect can start processes as this
 * user. `0700` on the directory is the primary defence, and the peer-uid check is
 * the second.
 */
export const SOCKET_DIRECTORY_MODE = 0o700;

export class SocketPathTooLong extends UserFacingError {
  readonly byteCount: number;

  override readonly summary = "Janela can't create its background service socket.";

  constructor(byteCount: number) {
    super("socket path too long", {
      reason:
        `The socket path is ${byteCount} bytes and the system limit is ` +
        `${MAXIMUM_SOCKET_PATH_LENGTH}.`,
      recoverySuggestion: "This can happen when your home directory path is unusually long.",
    });
    this.byteCount = byteCount;
  }
}

/**
 * What the operating system says about the process on the other end.
 *
 * Populated by the listener before the handshake. `pid` is for logs only.
 */
export interface PeerCredential {
  readonly uid: number;
  /** Reusable, and therefore never an authorisation input. */
  readonly pid: number;
}

// TODO: Verify the peer and reject any connection whose uid is not our own.
//
// On a Unix socket this is `getsockopt(SOL_LOCAL, LOCAL_PEERCRED)`, whose `struct
// xucred` is 76 bytes on macOS 26 and whose `cr_version` must equal
// XUCRED_VERSION before any other field is trusted. Record LOCAL_PEERPID for the
// log only — a pid is reusable and must never be an authorisation input.
//
// This is not an escalation boundary: a process running as the user could already
// run anything as the user. It is the boundary that keeps a *different* user on a
// shared Mac out. Same posture as tmux, and worth stating explicitly rather than
// discovering later. See docs/decisions/0016-daemon-protocol.md.
//
// Note where this now runs. `bun:ffi` is gated to @janela/pty, so this package
// cannot call `getsockopt` itself. The listener obtains the credential from the
// platform layer that owns the descriptor and passes it in — which keeps the one
// FFI surface in the system at one. If Bun's socket API grows a peer-credential
// accessor, use it and delete this note.
export function isAuthorized(credential: PeerCredential): boolean {
  void credential;
  throw new Error(`not implemented: isAuthorized`);
}
