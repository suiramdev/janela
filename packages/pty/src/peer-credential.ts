import { native, ptr, type NativePtyLibrary } from "./bindings.ts";

/**
 * Reading the peer credential of a connected Unix socket.
 *
 * ## Why this is in the PTY package
 *
 * It has nothing to do with a pseudo-terminal, and it is here anyway: `bun:ffi` is
 * gated to this package (ADR 0021) and Bun exposes no peer-credential accessor, so
 * the alternative is a second native artifact to build, sign and locate. Without
 * this reader `verifyPeer` refuses every peer as `credential-unavailable` and no
 * client can connect at all.
 *
 * ## What it does not do
 *
 * **It does not decide anything.** The bytes go up exactly as the kernel wrote
 * them, and `@janela/daemon`'s `verifyPeer` checks the version, the length and the
 * uid — one authorization rule, in the language its tests are written in.
 */

/**
 * `sizeof(struct xucred)` on macOS, measured at 76 bytes on macOS 26.
 *
 * `@janela/pty` may not import `@janela/daemon` — that edge points sideways — so
 * this duplicates `XUCRED_BYTE_LENGTH` there. The pair is kept in step by hand,
 * and a drift is visible rather than silent: this side allocates the buffer and
 * reports the length the kernel filled, so a mismatch surfaces as
 * `credential-truncated` rather than as a misread field.
 */
export const XUCRED_LENGTH = 76;

/**
 * The raw result of the two `getsockopt` calls.
 *
 * Structurally identical to `RawPeerCredential` in `@janela/daemon`, which is what
 * `socketListener` takes — the composition root passes this straight through.
 */
export interface RawPeerCredentialBytes {
  /**
   * `struct xucred` as the kernel wrote it, trimmed to the length it reported.
   *
   * Trimmed rather than padded on purpose: a short fill must stay visible, because
   * that is the only signal that the struct's fields do not mean what we think.
   * `undefined` when the call failed.
   */
  readonly xucred: Uint8Array | undefined;
  /** The peer's pid, or `undefined` when the kernel would not say. A log field only. */
  readonly pid: number | undefined;
}

/**
 * Reads the credential of the peer on `fd`.
 *
 * Never throws for a socket the kernel refuses to answer for: a closed or
 * non-socket descriptor produces `{ xucred: undefined }`, which `verifyPeer`
 * refuses. Fail-closed, and the caller does not need a `try`.
 */
export function readPeerCredential(
  fd: number,
  library: NativePtyLibrary = native,
): RawPeerCredentialBytes {
  const buffer = new Uint8Array(XUCRED_LENGTH);
  const pidOut = new Int32Array(1);
  const optlen = Number(library.jpty_peer_credential(fd, ptr(buffer), buffer.length, ptr(pidOut)));

  const rawPid = pidOut[0];
  const pid = rawPid === undefined || rawPid < 0 ? undefined : rawPid;

  // A view, not a copy: `verifyPeer` reads four fields and keeps nothing.
  return { xucred: optlen < 0 ? undefined : buffer.subarray(0, optlen), pid };
}
