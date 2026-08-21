import type { ReactElement } from "react";

/**
 * Shown only when the daemon is not answering.
 *
 * Deliberately an inset strip rather than a modal: the user's terminals are still
 * running and their state is still on screen, so blocking the window would be a lie
 * about how bad the situation is.
 */
export function ConnectionBanner(): ReactElement | null {
  throw new Error(`not implemented: ConnectionBanner`);
}

// TODO: The `connecting` and `reconnecting` case — a thin, quiet strip.
// Reconnecting is routine and usually resolves within a frame or two of the daemon
// restarting. It must not shift the layout when it appears, because a terminal that
// jumps a few pixels every time the daemon restarts is worse than no banner.

// TODO: The `refused` case, which is the version-skew story and needs a sentence and
// a button.
//
// It must say what is still running — "3 sessions, 2 with live terminals" — and that
// restarting will close it, then let the user choose. **Never restart the daemon
// automatically**: it is holding live work, and an app update killing an agent
// mid-task is the exact failure ADR 0017 § Version skew exists to prevent.
//
// The copy is settled and should be used as written:
//   "Janela was updated. The background service is still running your terminals on
//    the previous version. Restart it when you are ready — this will close your
//    terminals."
