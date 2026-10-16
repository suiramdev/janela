import { homedir } from "node:os";
import { join } from "node:path";

import { UserFacingError } from "@janela/support";

export const MAXIMUM_SOCKET_PATH_LENGTH = 104;

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

export function defaultSocketPath(): string {
  const path = join(homedir(), ".janela", "run", "janelad.sock");
  const byteCount = Buffer.byteLength(path, "utf8");

  if (byteCount > MAXIMUM_SOCKET_PATH_LENGTH) throw new SocketPathTooLong(byteCount);

  return path;
}
