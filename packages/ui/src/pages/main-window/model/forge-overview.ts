import type { DaemonConnection } from "@janela/client";
import type { ForgeOverview, SessionForgeLink, SessionID } from "@janela/core";
import { parseForgeOverview } from "@janela/protocol";
import { Option } from "effect";

export type ForgeOverviewState =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly overview: ForgeOverview; readonly receivedAt: number }
  | { readonly kind: "unreachable" };

export type SessionLinkLookup = (sessionID: SessionID) => SessionForgeLink | undefined;

export interface ForgeOverviewStore {
  readonly state: ForgeOverviewState;
  refresh(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export const FORGE_OVERVIEW_POLL_MS = 60_000;

const LOADING: ForgeOverviewState = { kind: "loading" };

const UNREACHABLE: ForgeOverviewState = { kind: "unreachable" };

const parsedOverview = Option.liftThrowable(parseForgeOverview);

export function createForgeOverviewStore(
  connection: Pick<DaemonConnection, "request">,
  clock: () => number = Date.now,
): ForgeOverviewStore {
  let state: ForgeOverviewState = LOADING;
  let inFlight: Promise<void> | undefined;
  const listeners = new Set<() => void>();

  const publish = (next: ForgeOverviewState): void => {
    state = next;

    for (const listener of listeners) listener();
  };

  const read = async (): Promise<void> => {
    const text = await connection.request({ type: "forgeOverview" }).catch(() => undefined);
    const overview = text === undefined ? undefined : Option.getOrUndefined(parsedOverview(text));

    if (overview !== undefined) {
      publish({ kind: "loaded", overview, receivedAt: clock() });
    } else if (state.kind === "loading") {
      publish(UNREACHABLE);
    }
  };

  return {
    get state(): ForgeOverviewState {
      return state;
    },

    refresh(): Promise<void> {
      inFlight ??= read().finally(() => {
        inFlight = undefined;
      });

      return inFlight;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function sessionLinkLookup(state: ForgeOverviewState): SessionLinkLookup {
  if (state.kind !== "loaded") return () => undefined;

  const links = new Map(state.overview.sessions.map((link) => [link.sessionID, link]));

  return (sessionID) => links.get(sessionID);
}
