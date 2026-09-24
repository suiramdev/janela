import type { Project, Session } from "@janela/core";
import type { ReactElement, ReactNode } from "react";
import { createContext, useContext, useEffect, useMemo } from "react";

import { useClientEnvironment, useStoreValue } from "../../../shared/model/index.ts";
import {
  FORGE_OVERVIEW_POLL_MS,
  createForgeOverviewStore,
  sessionLinkLookup,
  type ForgeOverviewState,
  type ForgeOverviewStore,
  type SessionLinkLookup,
} from "../model/forge-overview.ts";

const DETACHED = createForgeOverviewStore({ request: () => Promise.resolve(undefined) });

const ForgeOverviewContext = createContext<ForgeOverviewStore>(DETACHED);

export function ForgeOverviewProvider(props: {
  readonly store: ForgeOverviewStore;
  readonly children?: ReactNode;
}): ReactElement {
  return (
    <ForgeOverviewContext.Provider value={props.store}>
      {props.children}
    </ForgeOverviewContext.Provider>
  );
}

export function useForgeOverview(): {
  readonly store: ForgeOverviewStore;
  readonly state: ForgeOverviewState;
  readonly link: SessionLinkLookup;
} {
  const store = useContext(ForgeOverviewContext);
  const state = useStoreValue(store, () => store.state);
  const link = useMemo(() => sessionLinkLookup(state), [state]);

  return { store, state, link };
}

export function usePolledForgeOverview(): ForgeOverviewStore {
  const { connection, sessions, projects } = useClientEnvironment();
  const store = useMemo(() => createForgeOverviewStore(connection), [connection]);
  const isConnected = useStoreValue(connection, () => connection.status.kind === "connected");

  useEffect(() => {
    if (!isConnected) return undefined;

    let known = membership(projects.projects, sessions.sessions);

    const refreshOnMembership = (): void => {
      const next = membership(projects.projects, sessions.sessions);

      if (next === known) return;

      known = next;
      void store.refresh();
    };

    void store.refresh();

    const timer = setInterval(() => {
      void store.refresh();
    }, FORGE_OVERVIEW_POLL_MS);

    const stopSessions = sessions.subscribe(refreshOnMembership);
    const stopProjects = projects.subscribe(refreshOnMembership);

    return () => {
      clearInterval(timer);
      stopSessions();
      stopProjects();
    };
  }, [store, isConnected, sessions, projects]);

  return store;
}

function membership(projects: readonly Project[], sessions: readonly Session[]): string {
  return [...projects.map((project) => project.id), ...sessions.map((session) => session.id)].join(
    ",",
  );
}
