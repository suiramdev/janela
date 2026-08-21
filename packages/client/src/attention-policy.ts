import type { SessionID, TerminalID } from "@janela/core";
import type { AttentionSignal } from "@janela/protocol";

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
  throw new Error(`not implemented: createAttentionPolicy`);
}

// TODO: Expire delivered entries past the coalescing window, and clear a session's
// entries when it is removed. A notification for a session that no longer exists is
// a bug the user sees.

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
