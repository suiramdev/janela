import { native, ptr, type NativePtyLibrary } from "./bindings.ts";

export interface RawPeerCredentialBytes {
  readonly xucred: Uint8Array | undefined;
  readonly pid: number | undefined;
}

export const XUCRED_LENGTH = 76;

export function readPeerCredential(
  fd: number,
  library: NativePtyLibrary = native,
): RawPeerCredentialBytes {
  const buffer = new Uint8Array(XUCRED_LENGTH);
  const pidOut = new Int32Array(1);
  const filledLength = Number(
    library.jpty_peer_credential(fd, ptr(buffer), buffer.length, ptr(pidOut)),
  );
  const reportedPid = pidOut[0];
  const pid = reportedPid === undefined || reportedPid < 0 ? undefined : reportedPid;

  if (filledLength < 0) {
    return { xucred: undefined, pid };
  }

  return { xucred: buffer.subarray(0, filledLength), pid };
}
