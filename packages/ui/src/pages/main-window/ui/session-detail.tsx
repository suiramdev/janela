import {
  emptyLayout,
  focusedTab,
  type Axis,
  type PaneDestination,
  type SessionID,
  type TerminalDescriptor,
  type TerminalID,
} from "@janela/core";
import { Empty, EmptyHeader, EmptyTitle } from "@janela/design";
import { useCallback, useEffect, useState, type ReactElement } from "react";

import {
  type PanePath,
  type TabCloseScope,
  resolveLocalLayout,
  tabsInCloseScope,
  useClientEnvironment,
  useStoreValue,
  withFocusedTab,
  withFocusedTerminal,
  withSplitFraction,
} from "../../../shared/model/index.ts";
import { ContentCard, PANE_REGION, ShowSidebarBar } from "../../../shared/ui/index.ts";
import {
  closeTerminals,
  createTerminal,
  moveTerminal,
  splitTerminal,
} from "../model/command-dispatch.ts";
import { closeQuestionScope, tabTerminals } from "../model/tab-rows.ts";
import { EmptySessionScreen } from "./empty-session.tsx";
import { PaneView } from "./pane-view.tsx";
import { TabStrip } from "./tab-strip.tsx";

const SESSION_NOT_FOUND = (
  <Empty className="h-full">
    <EmptyHeader>
      <EmptyTitle>Session not found</EmptyTitle>
    </EmptyHeader>
  </Empty>
);

const NO_TERMINALS: readonly TerminalDescriptor[] = [];

const ROOT_PATH: PanePath = [];

export function SessionDetail(props: { readonly sessionID: SessionID }): ReactElement {
  const sessionID = props.sessionID;
  const environment = useClientEnvironment();
  const { confirmations, connection, onFocusedTerminalChange, view } = environment;
  const sessions = useStoreValue(environment.sessions, () => environment.sessions.sessions);
  const states = useStoreValue(environment.sessions, () => environment.sessions.terminalStates);
  const isConnected = useStoreValue(connection, () => connection.status.kind === "connected");
  const layouts = useStoreValue(view, () => view.layouts);

  const session = sessions.find((candidate) => candidate.id === sessionID);
  const mirrorLayout = session?.layout ?? emptyLayout;
  const terminals = session?.terminals ?? NO_TERMINALS;
  const terminalIDs = terminals.map((terminal) => terminal.id);

  const layout = resolveLocalLayout(layouts.get(sessionID), mirrorLayout, terminalIDs).local;

  const focusTerminal = useCallback(
    (id: TerminalID) => {
      view.applyLayout(sessionID, (current) => withFocusedTerminal(current, id));
    },
    [view, sessionID],
  );

  const focusTab = useCallback(
    (index: number) => {
      view.applyLayout(sessionID, (current) => withFocusedTab(current, index));
    },
    [view, sessionID],
  );

  const setFraction = useCallback(
    (path: PanePath, fraction: number) => {
      view.applyLayout(sessionID, (current) => withSplitFraction(current, path, fraction));
    },
    [view, sessionID],
  );

  const newTerminal = useCallback(() => {
    void createTerminal(connection, sessionID).catch(swallowRequestFailure);
  }, [connection, sessionID]);

  const splitTab = useCallback(
    (index: number, axis: Axis) => {
      const target = layout.tabs[index];

      if (target === undefined) return;

      view.applyLayout(sessionID, (current) => withFocusedTab(current, index));
      void splitTerminal(connection, sessionID, target.focusedTerminalID, axis).catch(
        swallowRequestFailure,
      );
    },
    [connection, layout, sessionID, view],
  );

  const splitPane = useCallback(
    (id: TerminalID, axis: Axis) => {
      void splitTerminal(connection, sessionID, id, axis).catch(swallowRequestFailure);
    },
    [connection, sessionID],
  );

  const moveTab = useCallback(
    (from: number, to: number) => {
      void connection
        .request({ type: "moveTab", sessionID, from, to })
        .catch(swallowRequestFailure);
    },
    [connection, sessionID],
  );

  const [draggedTerminalID, setDraggedTerminalID] = useState<TerminalID | undefined>(undefined);

  const dropTerminal = useCallback(
    (destination: PaneDestination) => {
      if (draggedTerminalID === undefined) return;

      setDraggedTerminalID(undefined);
      void moveTerminal(connection, sessionID, draggedTerminalID, destination).catch(
        swallowRequestFailure,
      );
    },
    [connection, draggedTerminalID, sessionID],
  );

  const closeTabs = useCallback(
    (index: number, scope: TabCloseScope) => {
      const indices = tabsInCloseScope(layout.tabs.length, index, scope);
      const closing = indices.flatMap((at) => tabTerminals(layout, at));

      if (session === undefined || closing.length === 0) return;

      void closeTerminals(
        { sessions: environment.sessions, connection, confirmations },
        session,
        closing,
        closeQuestionScope(scope),
      ).catch(swallowRequestFailure);
    },
    [confirmations, connection, environment.sessions, layout, session],
  );

  const closePane = useCallback(
    (id: TerminalID) => {
      if (session === undefined) return;

      void closeTerminals(
        { sessions: environment.sessions, connection, confirmations },
        session,
        [id],
        "pane",
      ).catch(swallowRequestFailure);
    },
    [confirmations, connection, environment.sessions, session],
  );

  const tab = focusedTab(layout);
  const focusedTerminalID = tab?.focusedTerminalID;

  useEffect(() => {
    onFocusedTerminalChange?.(focusedTerminalID);
  }, [onFocusedTerminalChange, focusedTerminalID]);

  useEffect(
    () => () => {
      onFocusedTerminalChange?.(undefined);
    },
    [onFocusedTerminalChange],
  );

  if (session === undefined) {
    return (
      <>
        <ShowSidebarBar />
        <ContentCard>{SESSION_NOT_FOUND}</ContentCard>
      </>
    );
  }

  if (tab === undefined) return <EmptySessionScreen onNewTerminal={newTerminal} />;

  return (
    <>
      <TabStrip
        layout={layout}
        terminals={terminals}
        onFocusTab={focusTab}
        onNewTerminal={newTerminal}
        onSplitTab={splitTab}
        onMoveTab={moveTab}
        onCloseTabs={closeTabs}
        draggedTerminalID={draggedTerminalID}
        onDropTerminal={dropTerminal}
      />
      <div className={PANE_REGION}>
        <PaneView
          pane={tab.root}
          path={ROOT_PATH}
          focusedTerminalID={tab.focusedTerminalID}
          terminals={terminals}
          states={states}
          connection={connection}
          isConnected={isConnected}
          onFocusTerminal={focusTerminal}
          onFraction={setFraction}
          onClosePane={closePane}
          onSplitPane={splitPane}
          onNewTerminal={newTerminal}
          draggedTerminalID={draggedTerminalID}
          onDragTerminal={setDraggedTerminalID}
          onDropTerminal={dropTerminal}
        />
      </div>
    </>
  );
}

function swallowRequestFailure(): undefined {
  return undefined;
}
