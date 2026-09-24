import {
  supportsWorktrees,
  type Project,
  type ProjectID,
  type Session,
  type SessionID,
} from "@janela/core";
import { Dialog, DialogContent, DialogHeader, DialogTitle, cn } from "@janela/design";
import type { SessionCreationIntent } from "@janela/protocol";
import { Match } from "effect";
import type { ReactElement } from "react";
import { useCallback, useRef, useState } from "react";

import type { CommandID } from "../../../../shared/config/index.ts";
import {
  type Sheet,
  commandsWithShortcuts,
  useClientEnvironment,
  useStoreValue,
} from "../../../../shared/model/index.ts";
import {
  createSessionAndSelect,
  focusedTerminalOf,
  selectSession,
} from "../../model/command-dispatch.ts";
import { CommandPalette } from "./command-palette.tsx";
import { JumpList } from "./jump-list.tsx";
import { NewSessionSheet, useBranchOverview } from "./new-session-sheet.tsx";

type SheetKind = Sheet["kind"];

const SHEET_LABEL = {
  jumpList: "Go to Session",
  commands: "Command Palette",
  newSession: "New Session",
} satisfies Record<SheetKind, string>;

const SHEET_LAYOUT = {
  jumpList: { size: "lg", titled: false },
  commands: { size: "lg", titled: false },
  newSession: { size: "lg", titled: true },
} satisfies Record<SheetKind, { readonly size: "sm" | "lg" | "xl"; readonly titled: boolean }>;

function swallowRequestFailure(): undefined {
  return undefined;
}

export function SheetHost(props: {
  readonly dispatch: (id: CommandID) => void;
}): ReactElement | null {
  const { dispatch } = props;
  const environment = useClientEnvironment();
  const { view, sessions: sessionStore } = environment;
  const sheet = useStoreValue(view, () => view.sheet);

  const close = useCallback(() => {
    view.closeSheet();

    const session = sessionStore.sessions.find(
      (candidate) => candidate.id === sessionStore.selection,
    );

    const terminal = session === undefined ? undefined : focusedTerminalOf(view, session);

    if (terminal !== undefined) view.surface(terminal)?.focus();
  }, [view, sessionStore]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) close();
    },
    [close],
  );

  const contentRef = useRef<HTMLDivElement | null>(null);

  const initialFocus = useCallback(
    () => contentRef.current?.querySelector<HTMLElement>("[data-autofocus]") ?? null,
    [],
  );

  const [lastSheet, setLastSheet] = useState(sheet);

  if (sheet !== undefined && sheet !== lastSheet) setLastSheet(sheet);

  const rendered = sheet ?? lastSheet;

  if (rendered === undefined) return null;

  const layout = SHEET_LAYOUT[rendered.kind];
  const label = SHEET_LABEL[rendered.kind];

  return (
    <Dialog key={rendered.kind} open={sheet !== undefined} onOpenChange={handleOpenChange}>
      <DialogContent
        ref={contentRef}
        aria-label={layout.titled ? undefined : label}
        initialFocus={initialFocus}
        finalFocus={false}
        showCloseButton={false}
        size={layout.size}
        position="top"
        className={cn("max-h-[80vh]", layout.titled ? "overflow-y-auto" : "overflow-hidden p-0")}
      >
        {layout.titled ? (
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
          </DialogHeader>
        ) : null}
        <SheetBody sheet={rendered} dispatch={dispatch} onClose={close} />
      </DialogContent>
    </Dialog>
  );
}

function SheetBody(props: {
  readonly sheet: Sheet;
  readonly dispatch: (id: CommandID) => void;
  readonly onClose: () => void;
}): ReactElement | null {
  const { sheet, dispatch, onClose } = props;
  const environment = useClientEnvironment();
  const { view, projects: projectStore, sessions: sessionStore, connection } = environment;

  const projects = useStoreValue(projectStore, () => projectStore.projects);
  const sessions = useStoreValue(sessionStore, () => sessionStore.sessions);
  const selection = useStoreValue(sessionStore, () => sessionStore.selection);
  const terminalStates = useStoreValue(sessionStore, () => sessionStore.terminalStates);
  const settings = useStoreValue(view, () => view.settings);

  const pickSession = useCallback(
    (sessionID: SessionID) => {
      onClose();
      view.showWorkspace();
      const session = sessionStore.sessions.find((candidate) => candidate.id === sessionID);
      const terminal = session === undefined ? undefined : focusedTerminalOf(view, session);

      if (terminal === undefined) selectSession({ sessions: sessionStore, view }, sessionID);
      else view.focusTerminal(terminal);
    },
    [onClose, sessionStore, view],
  );

  const runCommand = useCallback(
    (id: CommandID) => {
      onClose();
      dispatch(id);
    },
    [dispatch, onClose],
  );

  const createSession = useCallback(
    (intent: SessionCreationIntent) => {
      onClose();
      void createSessionAndSelect({ sessions: sessionStore, connection, view }, intent).catch(
        swallowRequestFailure,
      );
    },
    [connection, onClose, sessionStore, view],
  );

  const selected = sessions.find((session) => session.id === selection);

  return Match.value(sheet).pipe(
    Match.when({ kind: "jumpList" }, () => (
      <JumpList
        projects={projects}
        sessions={sessions}
        terminalStates={terminalStates}
        currentSelection={selection}
        onPick={pickSession}
        onCancel={onClose}
      />
    )),
    Match.when({ kind: "commands" }, () => (
      <CommandPalette
        projects={projects}
        sessions={sessions}
        terminalStates={terminalStates}
        commands={commandsWithShortcuts(settings, environment.local !== undefined)}
        onPick={runCommand}
        onPickSession={pickSession}
        onCancel={onClose}
      />
    )),
    Match.when({ kind: "newSession" }, (newSession) => (
      <ConnectedNewSessionSheet
        projects={projects}
        initialProjectID={newSession.projectID ?? selected?.projectID}
        sessions={sessions}
        onCreate={createSession}
        onCancel={onClose}
      />
    )),
    Match.exhaustive,
  );
}

function ConnectedNewSessionSheet(props: {
  readonly projects: readonly Project[];
  readonly initialProjectID: ProjectID | undefined;
  readonly sessions: readonly Session[];
  readonly onCreate: (intent: SessionCreationIntent) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const { connection, directories } = useClientEnvironment();
  const [projectID, setProjectID] = useState(props.initialProjectID);
  const project = props.projects.find((candidate) => candidate.id === projectID);

  const overview = useBranchOverview(
    connection,
    project !== undefined && supportsWorktrees(project) ? project.id : undefined,
  );

  const pickDirectory = useCallback(
    () => directories.pickDirectory({ title: "Choose Folder" }),
    [directories],
  );

  return (
    <NewSessionSheet
      projects={props.projects}
      projectID={project?.id}
      onProjectChange={setProjectID}
      overview={overview}
      sessions={props.sessions}
      onPickDirectory={pickDirectory}
      onCreate={props.onCreate}
      onCancel={props.onCancel}
    />
  );
}
