import type { Session, TerminalID, TerminalState } from "@janela/core";
import { isLive } from "@janela/core";
import { Match } from "effect";

export type ServiceRequest = "stop" | "stopAndUnregister";

export interface ServiceStopCost {
  readonly sessionCount: number;
  readonly liveSessionCount: number;
  readonly liveTerminalCount: number;
  readonly sentence: string;
}

export interface ServiceConfirmation {
  readonly pending?: ServiceRequest;
}

export type ServiceControlEvent =
  | { readonly kind: "request"; readonly request: ServiceRequest }
  | { readonly kind: "confirm"; readonly request: ServiceRequest }
  | { readonly kind: "cancel" };

export interface ServiceControlOutcome {
  readonly confirmation: ServiceConfirmation;
  readonly perform?: ServiceRequest;
}

export const SERVICE_REQUEST_TITLE = {
  stop: "Stop the Daemon",
  stopAndUnregister: "Stop and Unregister",
} satisfies Record<ServiceRequest, string>;

export const SERVICE_CONFIRM_TITLE = {
  stop: "Stop the daemon",
  stopAndUnregister: "Stop and unregister",
} satisfies Record<ServiceRequest, string>;

export const NO_SERVICE_CONFIRMATION: ServiceConfirmation = {};

export function serviceStopCost(
  sessions: readonly Session[],
  terminalStates: Readonly<Record<TerminalID, TerminalState>>,
): ServiceStopCost {
  let liveSessionCount = 0;
  let liveTerminalCount = 0;

  for (const session of sessions) {
    let live = 0;

    for (const terminal of session.terminals) {
      const state = terminalStates[terminal.id];

      if (state !== undefined && isLive(state)) live += 1;
    }

    liveTerminalCount += live;

    if (live > 0) liveSessionCount += 1;
  }

  return {
    sessionCount: sessions.length,
    liveSessionCount,
    liveTerminalCount,
    sentence: costSentence(sessions.length, liveSessionCount),
  };
}

function costSentence(sessionCount: number, liveSessionCount: number): string {
  if (sessionCount === 0) return "No sessions";

  const sessions = sessionCount === 1 ? "1 session" : `${sessionCount} sessions`;

  if (liveSessionCount === 0) return `${sessions}, none with live terminals`;

  const live =
    liveSessionCount === 1 ? "1 with a live terminal" : `${liveSessionCount} with live terminals`;

  return `${sessions}, ${live}`;
}

export function serviceRequestCost(request: ServiceRequest, cost: ServiceStopCost): string {
  const terminals =
    cost.liveTerminalCount === 1 ? "1 live terminal" : `${cost.liveTerminalCount} live terminals`;

  const closing =
    cost.liveTerminalCount === 0
      ? `${cost.sentence}. Nothing is running, so nothing will be lost.`
      : `${cost.sentence}. Stopping it closes ${terminals}, and anything running in them ends.`;

  if (request === "stop") {
    return `${closing} Your sessions are kept and reopen idle next time.`;
  }

  return `${closing} Janela will also stop starting the daemon automatically, so terminals will not survive closing the window until you turn it back on in Login Items & Extensions.`;
}

export function serviceControlReducer(
  confirmation: ServiceConfirmation,
  event: ServiceControlEvent,
): ServiceControlOutcome {
  return Match.value(event).pipe(
    Match.when({ kind: "request" }, (requested) => ({
      confirmation: { pending: requested.request },
    })),
    Match.when({ kind: "confirm" }, (confirmed) =>
      confirmation.pending === confirmed.request
        ? { confirmation: NO_SERVICE_CONFIRMATION, perform: confirmed.request }
        : { confirmation },
    ),
    Match.when({ kind: "cancel" }, () => ({ confirmation: NO_SERVICE_CONFIRMATION })),
    Match.exhaustive,
  );
}
