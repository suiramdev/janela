import { SocketPathTooLong } from "@janela/protocol/endpoint";
import type { UserFacingError } from "@janela/support";

import { RemovalNotConfirmed } from "./commands.ts";
import { DaemonIncompatible, DaemonNotRunning, DaemonUnreachable } from "./daemon-link.ts";

export const EXIT_STATUS = {
  done: 0,
  failed: 1,
  usage: 2,
  unreachable: 3,
  incompatible: 4,
  declined: 5,
} as const;

export function exitStatusFor(failure: UserFacingError): number {
  if (failure instanceof RemovalNotConfirmed) return EXIT_STATUS.declined;

  if (
    failure instanceof DaemonNotRunning ||
    failure instanceof DaemonUnreachable ||
    failure instanceof SocketPathTooLong
  ) {
    return EXIT_STATUS.unreachable;
  }

  if (failure instanceof DaemonIncompatible) return EXIT_STATUS.incompatible;

  return EXIT_STATUS.failed;
}
