import type { ConnectionStatus } from "@janela/client";
import type { Session, SessionID } from "@janela/core";
import { Alert, AlertAction, AlertDescription, AlertTitle, Button, Spinner } from "@janela/design";
import { Match } from "effect";
import type { ReactElement } from "react";
import { useCallback } from "react";

import { useClientEnvironment, useStoreValue } from "../../../shared/model/index.ts";

export type BannerModel =
  | { readonly kind: "none" }
  | { readonly kind: "strip"; readonly text: string }
  | { readonly kind: "refused" };

export const VERSION_SKEW_COPY =
  "Janela was updated. The background service is still running your terminals on the previous version. Restart it when you are ready — this will close your terminals.";

function swallowRefusal(): undefined {
  return undefined;
}

export function bannerModel(status: ConnectionStatus): BannerModel {
  return Match.value(status).pipe(
    Match.when({ kind: "idle" }, () => ({ kind: "none" }) satisfies BannerModel),
    Match.when({ kind: "connected" }, () => ({ kind: "none" }) satisfies BannerModel),
    Match.when(
      { kind: "connecting" },
      () => ({ kind: "strip", text: "Connecting…" }) satisfies BannerModel,
    ),
    Match.when(
      { kind: "reconnecting" },
      () => ({ kind: "strip", text: "Reconnecting…" }) satisfies BannerModel,
    ),
    Match.when({ kind: "refused" }, () => ({ kind: "refused" }) satisfies BannerModel),
    Match.exhaustive,
  );
}

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

export function ConnectionBanner(): ReactElement | null {
  const environment = useClientEnvironment();
  const { connection, confirmations, restartDaemon } = environment;
  const status = useStoreValue(connection, () => connection.status);
  const sessions = useStoreValue(environment.sessions, () => environment.sessions.sessions);
  const cost = runningSummary(sessions, (id) => environment.sessions.isRunning(id));

  const restart = useCallback(() => {
    void confirmations
      .confirm({
        title: "Restart the background service?",
        message: `${cost}. Restarting closes every terminal janelad is running, and the programs in them end.`,
        confirmLabel: "Restart and Close Terminals",
      })
      .then((agreed) => {
        if (agreed) restartDaemon();

        return undefined;
      }, swallowRefusal);
  }, [confirmations, cost, restartDaemon]);

  const model = bannerModel(status);

  if (model.kind === "none") return null;

  if (model.kind === "strip") {
    return (
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
    <Alert
      variant="destructive"
      className="absolute inset-x-0 top-0 z-10 rounded-none has-data-[slot=alert-action]:absolute has-data-[slot=alert-action]:pr-2.5"
    >
      <AlertTitle>{VERSION_SKEW_COPY}</AlertTitle>
      <AlertDescription>{cost}</AlertDescription>
      <AlertAction className="static mt-2">
        <Button variant="outline" size="sm" onClick={restart}>
          Restart the background service
        </Button>
      </AlertAction>
    </Alert>
  );
}
