import type { ConnectionStatus } from "@janela/client";
import type { Session, SessionID } from "@janela/core";
import { Alert, AlertAction, AlertDescription, AlertTitle, Button, Spinner } from "@janela/design";
import type { ReactElement } from "react";

import { useClientEnvironment, useStoreValue } from "./client-environment.tsx";

/**
 * What the banner is, in each state.
 *
 * A model rather than three branches inside the component, because the interesting
 * claims — that a routine reconnect is one quiet line, and that version skew is a
 * sentence plus a cost plus a choice — are claims about this function.
 */
export type BannerModel =
  | { readonly kind: "none" }
  | { readonly kind: "strip"; readonly text: string }
  /** The cost line is not in here: it needs the session list, and this takes a status. */
  | { readonly kind: "refused" };

/**
 * The settled copy, used as written.
 *
 * It names what happened, what is still true, and what restarting costs — in that
 * order, because a user deciding whether to kill their own terminals needs the cost
 * before the button.
 */
export const VERSION_SKEW_COPY =
  "Janela was updated. The background service is still running your terminals on the previous version. Restart it when you are ready — this will close your terminals.";

/**
 * The retry attempt is deliberately not shown.
 *
 * Reconnecting is routine and usually resolves within a frame or two of the daemon
 * restarting; a counter would turn a non-event into something to watch.
 */
export function bannerModel(status: ConnectionStatus): BannerModel {
  switch (status.kind) {
    case "idle":
    case "connected":
      return { kind: "none" };
    case "connecting":
      return { kind: "strip", text: "Connecting…" };
    case "reconnecting":
      return { kind: "strip", text: "Reconnecting…" };
    case "refused":
      return { kind: "refused" };
  }
}

/**
 * What restarting the daemon would cost, in the user's terms.
 *
 * "Live" is the daemon's word, not ours: `SessionStore.isRunning` is derived from
 * reported terminal states, so this counts what the daemon said is running rather
 * than what this client hopes.
 */
export function runningSummary(
  sessions: readonly Session[],
  isRunning: (id: SessionID) => boolean,
): string {
  if (sessions.length === 0) return "No sessions";
  const live = sessions.filter((session) => isRunning(session.id)).length;
  const sessionPart = sessions.length === 1 ? "1 session" : `${sessions.length} sessions`;
  const livePart = live === 1 ? "1 with a live terminal" : `${live} with live terminals`;
  return `${sessionPart}, ${livePart}`;
}

/**
 * Shown only when the daemon is not answering.
 *
 * Deliberately an inset strip rather than a modal: the user's terminals are still
 * running and their state is still on screen, so blocking the window would be a lie
 * about how bad the situation is.
 *
 * Absolutely positioned inside `MainWindow`'s `relative` root — that is the
 * no-layout-shift guarantee. It overlays; it never inserts. A terminal that jumped
 * a few pixels every time the daemon restarted would be worse than no banner.
 */
export function ConnectionBanner(): ReactElement | null {
  const environment = useClientEnvironment();
  const { connection } = environment;
  const status = useStoreValue(connection, () => connection.status);
  const sessions = useStoreValue(environment.sessions, () => environment.sessions.sessions);

  const model = bannerModel(status);
  if (model.kind === "none") return null;

  if (model.kind === "strip") {
    return (
      // `<output>` carries `role="status"` implicitly, and the polite live region
      // is what makes a reconnect announce itself without interrupting. The
      // spinner is hidden from it: the sentence is the announcement.
      <output
        aria-live="polite"
        className="border-border bg-muted text-muted-foreground absolute inset-x-0 top-0 flex items-center justify-center gap-2 border-b px-2 py-1 text-xs"
      >
        <Spinner aria-hidden="true" className="size-3" />
        {model.text}
      </output>
    );
  }

  return (
    // The action is a sentence rather than an icon, so it sits below the copy
    // instead of in the corner `AlertAction` reserves for one — hence `static` on
    // the action, and hence both of the primitive's `has-[action]` rules (a
    // `relative` box and a reserved right gutter) being overridden here rather
    // than fought with specificity.
    <Alert
      variant="destructive"
      className="absolute inset-x-0 top-0 z-10 rounded-none has-data-[slot=alert-action]:absolute has-data-[slot=alert-action]:pr-2.5"
    >
      <AlertTitle>{VERSION_SKEW_COPY}</AlertTitle>
      <AlertDescription>
        {runningSummary(sessions, (id) => environment.sessions.isRunning(id))}
      </AlertDescription>
      <AlertAction className="static mt-2">
        <Button variant="outline" size="sm" onClick={environment.restartDaemon}>
          Restart the background service
        </Button>
      </AlertAction>
    </Alert>
  );
}
