import type { SessionID, TerminalID } from "@janela/core";
import type { AttentionSignal } from "@janela/protocol";
import type { Logger } from "@janela/support";

import type { SessionStore } from "./stores.ts";

/**
 * Decides whether a terminal's signal deserves the user's attention.
 *
 * ## Why this is in the client
 *
 * The daemon detects the signal — it owns the emulator, so it is what sees a BEL.
 * But it has no idea which terminal the user is looking at, whether any window is
 * frontmost, or whether a human is present at all. Those facts live here, in the
 * process that has a window.
 *
 * So the daemon emits a *fact* and this decides what it means. Shipping focus state
 * to the daemon so it could decide would be a chatty protocol serving no one. See
 * docs/decisions/0011-notifications.md.
 */
export interface AttentionPolicy {
  /**
   * Whether this signal should reach the notification centre.
   *
   * In-app state — the pane indicator and the sidebar badge — is updated
   * **regardless** of what this returns. The sidebar is the primary channel and it
   * needs no permission; this decides only whether to interrupt.
   */
  shouldDeliver(signal: AttentionSignal, context: AttentionContext): boolean;

  /** Called when a session is removed, so its pending entries go with it. */
  forgetSession(id: SessionID): void;
}

/** What the client knows that the daemon does not. */
export interface AttentionContext {
  readonly isApplicationActive: boolean;
  readonly selectedSessionID?: SessionID;
  readonly focusedTerminalID?: TerminalID;
}

/**
 * Coalescing window, in seconds. A build that rings the bell four times is one
 * notification; the alternative trains users to dismiss without reading.
 */
export const COALESCING_WINDOW_SECONDS = 5;

/**
 * A command must have run at least this long before its failure is worth
 * interrupting for. Short commands failing is normal work, not an event.
 */
export const LONG_RUNNING_THRESHOLD_SECONDS = 10;

/**
 * The rules, stated once so the implementation cannot quietly drift from them:
 *
 * - Already delivered → no. Two windows must not double-notify.
 * - The user is looking straight at it (app active, session selected, terminal
 *   focused) → no.
 * - A bare BEL → badge, but do not interrupt. Programs ring it for reasons the user
 *   has not agreed are important.
 * - An OSC 9 / OSC 777 notification → deliver. The program asked for a notification
 *   by name, and that is consent.
 * - A finished prompt → deliver only when it failed *and* ran longer than
 *   `LONG_RUNNING_THRESHOLD_SECONDS`.
 */
export function createAttentionPolicy(): AttentionPolicy {
  /**
   * One entry per terminal that was delivered inside the window.
   *
   * Ids and a number — never the signal, and never `kind.body` or `kind.title`.
   * A policy that held onto notification text would be a policy that leaks it the
   * first time someone logs its state (AGENTS.md non-negotiable 11).
   *
   * Bounded by the terminals that signalled inside the window, because every call
   * prunes and `forgetSession` removes the rest.
   */
  const delivered = new Map<TerminalID, { readonly sessionID: SessionID; readonly at: number }>();

  return {
    shouldDeliver(signal: AttentionSignal, context: AttentionContext): boolean {
      // Daemon time against daemon time: the daemon stamps `occurredAt`, so two
      // clients on two machines with two clocks agree about the window, and this
      // needs no clock of its own to be testable.
      const now = Date.parse(signal.occurredAt);

      for (const [terminalID, entry] of delivered) {
        const elapsed = now - entry.at;
        // An unparseable stamp expires immediately rather than sticking forever:
        // a `NaN` comparison is false for every operator, so nothing else would
        // ever remove it.
        if (Number.isNaN(elapsed) || elapsed >= COALESCING_WINDOW_MS) delivered.delete(terminalID);
      }

      // Already delivered inside the window. Covers a duplicate `signal.id` from a
      // second delivery path and a chatty program's four bells with one rule.
      if (delivered.has(signal.terminalID)) return false;

      // The user is looking straight at it. Not recorded, because nothing was
      // delivered — if they switch away and it rings again, that is news.
      if (
        context.isApplicationActive &&
        context.selectedSessionID === signal.sessionID &&
        context.focusedTerminalID === signal.terminalID
      ) {
        return false;
      }

      if (!isWorthInterrupting(signal)) return false;

      delivered.set(signal.terminalID, { sessionID: signal.sessionID, at: now });
      return true;
    },

    forgetSession(id: SessionID): void {
      for (const [terminalID, entry] of delivered) {
        if (entry.sessionID === id) delivered.delete(terminalID);
      }
    },
  };
}

/** The coalescing window, in the units `Date.parse` returns. */
const COALESCING_WINDOW_MS = COALESCING_WINDOW_SECONDS * 1_000;

/**
 * The kind rules, separated from the focus and coalescing rules because they are
 * the part a product decision changes.
 */
function isWorthInterrupting(signal: AttentionSignal): boolean {
  switch (signal.kind.kind) {
    case "bell":
      // Badge only. A program ringing the bell has not said why.
      return false;
    case "notification":
      // The program asked for a notification by name, and that is consent.
      return true;
    case "promptFinished":
      return (
        signal.kind.exitCode !== undefined &&
        signal.kind.exitCode !== 0 &&
        signal.kind.durationSeconds >= LONG_RUNNING_THRESHOLD_SECONDS
      );
  }
}

/**
 * How a delivered signal reaches the user.
 *
 * Implemented in `apps/desktop` over the platform's notification API, because that
 * is an app-level capability and `@janela/client` must stay testable — and
 * browser-reachable — without one. The policy above is unit-tested against a
 * recording fake; this is a thin adapter with nothing worth testing.
 */
export interface AttentionDelivering {
  deliver(input: {
    readonly signal: AttentionSignal;
    readonly sessionName: string;
    readonly terminalTitle: string;
  }): Promise<void>;

  /** Withdraws anything still on screen for a session, e.g. when it is deleted. */
  withdraw(sessionID: SessionID): Promise<void>;
}

/**
 * Where signals come from.
 *
 * `DaemonConnection` satisfies this structurally. Named as one method rather than
 * taken whole so the routing below can be tested without a transport, a handshake
 * or a mirror — which is the same reason the policy takes no connection either.
 */
export interface AttentionSource {
  onAttention(handler: (signal: AttentionSignal) => void): () => void;
}

export interface AttentionRoutingOptions {
  readonly source: AttentionSource;
  /** Read for the names a notification carries, and watched for removals. */
  readonly sessions: SessionStore;
  readonly policy: AttentionPolicy;
  readonly delivery: AttentionDelivering;
  /** Whether this client's window is frontmost. A fact only the app holds. */
  readonly isApplicationActive: () => boolean;
  /** The focused pane's terminal, as the view last reported it. */
  readonly focusedTerminalID: () => TerminalID | undefined;
  readonly log?: Logger;
}

export interface AttentionRouting {
  /** Unsubscribes from both the signals and the mirror. */
  stop(): void;
}

/**
 * Joins the three halves: the daemon's fact, this client's decision, and the app's
 * delivery.
 *
 * ## Why this is here and not in the app
 *
 * Every rule it applies is about mirrored state and focus, and none of it needs a
 * notification API — so putting it beside the policy keeps the app's part an
 * adapter, and keeps this testable in a browser (ADR 0011, ADR 0023). The app
 * supplies two facts it alone holds and one object that can post a notification.
 *
 * ## What it does *not* do
 *
 * It never touches the stores. In-app attention — the pane indicator and the
 * sidebar badge — is `TerminalState.needsAttention`, which the daemon computes and
 * pushes; it is already on screen before this runs and it stays there whatever the
 * policy returns. The sidebar is the primary channel and needs no permission; a
 * notification is the secondary, best-effort one.
 *
 * ## Removals
 *
 * A session leaving the mirror withdraws its notifications and clears its policy
 * entries, in that order. Nothing else notices a removal: the policy cannot see the
 * mirror, and without this it would hold one entry per terminal that signalled
 * inside the coalescing window.
 */
export function routeAttention(options: AttentionRoutingOptions): AttentionRouting {
  const log = options.log ?? silentLogger;
  const { sessions, policy, delivery } = options;

  /**
   * The session ids last seen in the mirror. Bounded by the mirror itself, and
   * replaced wholesale on every change rather than accumulated.
   */
  let known = new Set<SessionID>(sessions.sessions.map((session) => session.id));

  /**
   * An adapter's rejection is logged and dropped.
   *
   * It reaches us inside the connection's read pump, where an unhandled rejection
   * would take the pump with it — a notification that failed to post must not cost
   * the user their terminal output. Only the error's *name*: a notification API
   * failure can quote the content it failed to post.
   */
  const settle = (work: Promise<void>, message: string): void => {
    void work.catch((error: unknown) => {
      // The name only. A notification API's failure can quote the content it
      // failed to post, and that content is the user's (non-negotiable 11).
      log.warning(message, { error: error instanceof Error ? error.name : "unknown" });
    });
  };

  const unsubscribeSignals = options.source.onAttention((signal: AttentionSignal): void => {
    const active = options.isApplicationActive();
    const selected = sessions.selection;
    const focused = options.focusedTerminalID();

    // Composed conditionally: with `exactOptionalPropertyTypes`, an explicit
    // `selectedSessionID: undefined` is not the same type as an absent key.
    const context: AttentionContext = {
      isApplicationActive: active,
      ...(selected === undefined ? {} : { selectedSessionID: selected }),
      ...(focused === undefined ? {} : { focusedTerminalID: focused }),
    };

    if (!policy.shouldDeliver(signal, context)) return;

    const session = sessions.sessions.find((candidate) => candidate.id === signal.sessionID);
    const terminal = session?.terminals.find((candidate) => candidate.id === signal.terminalID);
    if (session === undefined || terminal === undefined) {
      // A signal for something this mirror cannot name is a notification that would
      // land the user nowhere — worse than none (ADR 0011). The badge is unaffected:
      // it is the daemon's `TerminalState`, not ours.
      log.debug("attention for an unmirrored terminal", {
        sessionID: signal.sessionID,
        terminalID: signal.terminalID,
      });
      return;
    }

    settle(
      delivery.deliver({
        signal,
        sessionName: session.name,
        terminalTitle: terminal.title,
      }),
      "attention delivery failed",
    );
  });

  const unsubscribeMirror = sessions.subscribe((): void => {
    const current = new Set<SessionID>(sessions.sessions.map((session) => session.id));

    for (const id of known) {
      if (current.has(id)) continue;
      // Withdraw first: `forgetSession` is the policy's bookkeeping and cannot
      // fail, while a notification left on screen for a session that no longer
      // exists is a bug the user sees.
      settle(delivery.withdraw(id), "attention withdrawal failed");
      policy.forgetSession(id);
    }

    known = current;
  });

  return {
    stop(): void {
      unsubscribeSignals();
      unsubscribeMirror();
    },
  };
}

/**
 * The default when a caller injects nothing, for the same reason `nullLogSink` is.
 *
 * A local copy of `connection.ts`'s: both are four lines, and exporting one from
 * the other would make a private default part of this package's surface.
 */
const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  notice: () => {},
  warning: () => {},
  error: () => {},
};
