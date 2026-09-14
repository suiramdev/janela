import type { Project, ProjectID, ProjectSettings, Session, SessionID } from "@janela/core";
import { Dialog, DialogContent, DialogHeader, DialogTitle, cn } from "@janela/design";
import type { SessionCreationIntent } from "@janela/protocol";
import type { ReactElement } from "react";
import { useCallback, useRef, useState } from "react";

import { useClientEnvironment, useStoreValue } from "./client-environment.tsx";
import { createSessionAndSelect, focusedTerminalOf, selectSession } from "./command-dispatch.ts";
import { CommandPalette } from "./command-palette.tsx";
import type { CommandID } from "./commands.ts";
import { JumpList } from "./jump-list.tsx";
import { NewBranchSheet, type NewBranchIntent } from "./new-branch-sheet.tsx";
import { NewSessionSheet, useBranchOverview } from "./new-session-sheet.tsx";
import { ProjectSettingsSheet } from "./project-settings-sheet.tsx";
import type { Sheet } from "./view-state.ts";

/**
 * The one sheet that is open, over a scrim.
 *
 * There is never more than one — `ViewState.sheet` is a single value, not a stack —
 * because two overlapping modal surfaces in a terminal app is how you lose track of
 * which one owns the keyboard.
 *
 * Closing any of them returns focus to the terminal, which is the only reason a
 * user tolerates a modal in a tool they type into all day.
 *
 * ## What the dialog primitive owns, and what it does not
 *
 * Escape, the scrim, the focus trap and the first focus are the primitive's. Two
 * things stay here on purpose:
 *
 * - **Where focus goes on close.** A dialog returns focus to its trigger, and these
 *   sheets have none — they open from the menu bar, the palette and the sidebar.
 *   `finalFocus={false}` turns that off, and `close` sends focus to the terminal.
 * - **Which field opens focused.** The default is the first tabbable element, which
 *   is right for a find field and wrong for the branch sheet, where the project
 *   select comes first and the branch name is what you came to type. A field that
 *   wants to open focused says so with `data-autofocus`.
 */

type SheetKind = Sheet["kind"];

const SHEET_LABEL: Record<SheetKind, string> = {
  jumpList: "Go to Session",
  commands: "Command Palette",
  newSession: "New Session",
  newBranch: "New Branch Session",
  projectSettings: "Project Settings",
};

/**
 * How wide each sheet is, and whether its title shows.
 *
 * The find surfaces are a field over a list and title themselves by their
 * placeholder; a visible heading would be a second line saying the same thing.
 * The forms are read top to bottom and open on one.
 */
const SHEET_SHAPE: Record<SheetKind, { readonly width: string; readonly titled: boolean }> = {
  jumpList: { width: "sm:max-w-md", titled: false },
  commands: { width: "sm:max-w-md", titled: false },
  newSession: { width: "sm:max-w-lg", titled: true },
  newBranch: { width: "sm:max-w-lg", titled: true },
  projectSettings: { width: "sm:max-w-xl", titled: true },
};

/** A request from a sheet is best-effort, exactly as one from a view is. */
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
    // Back to the terminal: a sheet that leaves focus on a dismissed dialog costs
    // the user a click to start typing again.
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
    // `null` hands the choice back to the primitive: the first tabbable element.
    () => contentRef.current?.querySelector<HTMLElement>("[data-autofocus]") ?? null,
    [],
  );

  // The sheet that was open stays rendered while the dialog leaves: `open` flips
  // first, the exit animation plays over the old body, then the primitive
  // unmounts it. Derived during render, which is the sanctioned shape for
  // "remember the last defined value" — an effect would be a frame late.
  const [lastSheet, setLastSheet] = useState(sheet);
  if (sheet !== undefined && sheet !== lastSheet) setLastSheet(sheet);
  const rendered = sheet ?? lastSheet;

  if (rendered === undefined) return null;

  const shape = SHEET_SHAPE[rendered.kind];
  const label = SHEET_LABEL[rendered.kind];

  return (
    // Keyed by kind: a command that opens another sheet swaps the body under an
    // open dialog, and a remount is what makes the new body take first focus.
    <Dialog key={rendered.kind} open={sheet !== undefined} onOpenChange={handleOpenChange}>
      <DialogContent
        ref={contentRef}
        aria-label={shape.titled ? undefined : label}
        initialFocus={initialFocus}
        finalFocus={false}
        showCloseButton={false}
        // Anchored near the top like a macOS sheet, not centred: the list below
        // a find field grows and shrinks as you type, and a centred box would
        // bounce around its midpoint while it does.
        className={cn(
          "top-24 max-h-[80vh] translate-y-0 overflow-y-auto sm:max-w-none",
          shape.width,
        )}
      >
        {shape.titled ? (
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
  const profiles = useStoreValue(sessionStore, () => sessionStore.launchProfiles);
  const availability = useStoreValue(sessionStore, () => sessionStore.launchProfileAvailability);

  const pickSession = useCallback(
    (sessionID: SessionID) => {
      onClose();
      // Settings may be showing: the jump list is reachable from it, and picking
      // a session there means "take me to it", not "select it behind Settings".
      view.showWorkspace();
      const session = sessionStore.sessions.find((candidate) => candidate.id === sessionID);
      const terminal = session === undefined ? undefined : focusedTerminalOf(view, session);
      // Through the one focus entry point, so the pane is ready to type into.
      if (terminal === undefined) selectSession(sessionStore, sessionID);
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

  const createBranchSession = useCallback(
    (intent: NewBranchIntent) => {
      onClose();
      void createSessionAndSelect(
        { sessions: sessionStore, connection, view },
        {
          kind: "newWorktree",
          projectID: intent.projectID,
          branch: intent.branch,
          ...(intent.startPoint === undefined ? {} : { startPoint: intent.startPoint }),
        },
      ).catch(swallowRequestFailure);
    },
    [connection, onClose, sessionStore, view],
  );

  const saveProjectSettings = useCallback(
    (next: ProjectSettings) => {
      const projectID = sheet.kind === "projectSettings" ? sheet.projectID : undefined;
      onClose();
      if (projectID === undefined) return;
      connection
        .request({ type: "updateProjectSettings", projectID, settings: next })
        .catch(swallowRequestFailure);
    },
    [connection, onClose, sheet],
  );

  const selected = sessions.find((session) => session.id === selection);

  switch (sheet.kind) {
    case "jumpList":
      return (
        <JumpList
          projects={projects}
          sessions={sessions}
          terminalStates={terminalStates}
          currentSelection={selection}
          onPick={pickSession}
          onCancel={onClose}
        />
      );

    case "commands":
      return <CommandPalette onPick={runCommand} onCancel={onClose} />;

    case "newSession": {
      const subject = projects.find((candidate) => candidate.id === sheet.projectID);
      if (subject === undefined) return null;
      return (
        <ConnectedNewSessionSheet
          project={subject}
          projectID={subject.id}
          sessions={sessions}
          onCreate={createSession}
          onCancel={onClose}
        />
      );
    }

    case "newBranch": {
      // The context menu's project wins over the selection's: a right-click on a
      // project is a statement about which project, and the selection is only a
      // guess made on the menu bar's behalf.
      const preselected = sheet.projectID ?? selected?.projectID;
      return (
        <NewBranchSheet
          projects={projects}
          {...(preselected === undefined ? {} : { initialProjectID: preselected })}
          onCreate={createBranchSession}
          onCancel={onClose}
        />
      );
    }

    case "projectSettings": {
      const subject = projects.find((candidate) => candidate.id === sheet.projectID);
      // A project the mirror no longer has closes the sheet rather than rendering
      // an editor over nothing. The daemon is the source of truth, and it has
      // said this project is gone.
      if (subject === undefined) return null;
      return (
        <ProjectSettingsSheet
          project={subject}
          profiles={profiles}
          availability={availability}
          onSave={saveProjectSettings}
          onCancel={onClose}
        />
      );
    }
  }
}

/**
 * Its own component so the overview request runs only while this sheet is the
 * open one: a hook in `SheetBody` would fire for every sheet kind.
 */
function ConnectedNewSessionSheet(props: {
  readonly project: Project;
  readonly projectID: ProjectID;
  readonly sessions: readonly Session[];
  readonly onCreate: (intent: SessionCreationIntent) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const { connection } = useClientEnvironment();
  const overview = useBranchOverview(connection, props.projectID);
  return (
    <NewSessionSheet
      project={props.project}
      overview={overview}
      sessions={props.sessions}
      onCreate={props.onCreate}
      onCancel={props.onCancel}
    />
  );
}
