import type { DaemonConnection } from "@janela/client";
import {
  type GridSize,
  type TerminalDescriptor,
  type TerminalID,
  type TerminalState,
} from "@janela/core";

export function shouldStartOnAttach(
  descriptor: TerminalDescriptor | undefined,
  state: TerminalState | undefined,
): boolean {
  if (descriptor?.startsAutomatically !== true) return false;

  return state === undefined || state.kind === "idle";
}

export function attachPane(
  connection: Pick<DaemonConnection, "request" | "onOutput">,
  terminalID: TerminalID,
  feed: (bytes: Uint8Array) => void,
  viewport: GridSize,
): () => void {
  const unsubscribe = connection.onOutput(terminalID, feed);
  connection.request({ type: "attach", terminalID, viewport }).catch(swallowRequestFailure);

  return () => {
    unsubscribe();
    connection.request({ type: "detach", terminalID }).catch(swallowRequestFailure);
  };
}

function swallowRequestFailure(): undefined {
  return undefined;
}
