import type { Session, TerminalID, TerminalState } from "@janela/core";
import { isLive } from "@janela/core";

/**
 * The two ways a user may stop `janelad`, and the machinery that makes each one
 * state its cost first.
 *
 * Stopping the daemon terminates the user's terminals. That is never something
 * Janela does to make its own life easier — not on version skew, not on quit — so
 * both controls are explicit user choices, and an explicit choice made without
 * knowing the cost is not a choice. See ADR 0017 § When the daemon exits.
 */
export type ServiceRequest = "stop" | "stopAndUnregister";

/** What stopping the service would end, counted from the mirror. */
export interface ServiceStopCost {
  readonly sessionCount: number;
  /** Sessions with at least one live terminal — the ones with work in them. */
  readonly liveSessionCount: number;
  readonly liveTerminalCount: number;
  /**
   * ADR 0017's sentence, e.g. `3 sessions, 2 with live terminals`.
   *
   * A fragment rather than a sentence so the two controls — and #29's version-skew
   * banner, which owes the user the same fact — can embed it in their own copy
   * without three near-identical counting implementations drifting apart.
   */
  readonly sentence: string;
}

/**
 * Counts what is at stake.
 *
 * Reads `terminalStates` — what the daemon reported — and never what this client
 * did. A session with no reported state for a terminal has an idle terminal, not a
 * live one, so an unknown id is deliberately not counted as live.
 */
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

/**
 * The title of the control that starts each request.
 *
 * Verbatim from ADR 0017, which names both actions; the settings surface is where
 * "Stop and unregister" was promised to exist.
 */
export const SERVICE_REQUEST_TITLE: Record<ServiceRequest, string> = {
  stop: "Stop Background Service",
  stopAndUnregister: "Stop and Unregister",
};

/** The confirm button's label. Says what happens, not "OK". */
export const SERVICE_CONFIRM_TITLE: Record<ServiceRequest, string> = {
  stop: "Stop the service",
  stopAndUnregister: "Stop and unregister",
};

/**
 * What the user is agreeing to, stated before anything happens.
 *
 * Both strings name the terminals explicitly. "Are you sure?" is not a stated
 * cost, and the number is the part that makes someone stop and read.
 */
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
  return `${closing} Janela will also stop starting the service automatically, so terminals will not survive closing the window until you turn it back on in Login Items & Extensions.`;
}

/** Which control, if any, has shown its cost and is waiting to be confirmed. */
export interface ServiceConfirmation {
  readonly pending?: ServiceRequest;
}

export type ServiceControlEvent =
  /** The user pressed one of the two controls. Shows the cost; acts on nothing. */
  | { readonly kind: "request"; readonly request: ServiceRequest }
  | { readonly kind: "confirm"; readonly request: ServiceRequest }
  | { readonly kind: "cancel" };

export interface ServiceControlOutcome {
  readonly confirmation: ServiceConfirmation;
  /** Set only when the user has now agreed to this exact request. */
  readonly perform?: ServiceRequest;
}

export const NO_SERVICE_CONFIRMATION: ServiceConfirmation = {};

/**
 * The two-step rule, as a function so it can be tested without a window.
 *
 * The load-bearing line is the `request` case: pressing a control **performs
 * nothing**. It only reveals what pressing it again would cost. A `confirm` for a
 * request that is not the pending one is also inert, which is what stops a stale
 * click — the user pressed "Stop", read it, pressed "Stop and unregister" — from
 * performing the request they walked away from.
 */
export function serviceControlReducer(
  confirmation: ServiceConfirmation,
  event: ServiceControlEvent,
): ServiceControlOutcome {
  switch (event.kind) {
    case "request":
      return { confirmation: { pending: event.request } };
    case "confirm":
      if (confirmation.pending !== event.request) return { confirmation };
      return { confirmation: NO_SERVICE_CONFIRMATION, perform: event.request };
    case "cancel":
      return { confirmation: NO_SERVICE_CONFIRMATION };
  }
}

/**
 * How the app stops the daemon.
 *
 * A port. Registration and lifecycle are the Tauri shell's (ADR 0017, ADR 0024);
 * this package's job is to make sure neither is reached without the cost on
 * screen first.
 */
export interface BackgroundServiceControlling {
  stop(): void;
  stopAndUnregister(): void;
}
