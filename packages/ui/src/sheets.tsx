import {
  supportsWorktrees,
  type Project,
  type ProjectID,
  type Session,
  type SessionID,
} from "@janela/core";
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
};

/**
 * How wide each sheet is, and whether its title shows.
 *
 * The width is the dialog's own ladder — `sm` 400, `lg` 540, `xl` 880, each a
 * notch narrower in a compact region — rather than a Tailwind `max-w` of our
 * own. Every sheet that is left sits at `lg`: each is one question, and the
 * canvas step went with the project's settings when that form became a screen
 * (`settings-window.tsx`). The step stays a per-sheet decision rather than a
 * constant, because the next sheet is as likely to be `sm` as `lg`.
 *
 * The find surfaces are a field over a list and title themselves by their
 * placeholder; a visible heading would be a second line saying the same thing.
 * The forms are read top to bottom and open on one.
 */
const SHEET_SHAPE: Record<
  SheetKind,
  { readonly size: "sm" | "lg" | "xl"; readonly titled: boolean }
> = {
  jumpList: { size: "lg", titled: false },
  commands: { size: "lg", titled: false },
  newSession: { size: "lg", titled: true },
  newBranch: { size: "lg", titled: true },
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
        size={shape.size}
        // Anchored near the top like a macOS sheet, not centred: the list below
        // a find field grows and shrinks as you type, and a centred box would
        // bounce around its midpoint while it does. The primitive's own
        // `position` does this — it also drops the vertical half-translate, so
        // there is no transform left here to fight.
        position="top"
        // A find surface is drawn flush: the command menu brings its own field,
        // the hairline under it and the hint strip, all sized to the full width
        // of the panel, so the dialog's own padding would inset a divider that
        // is meant to reach both edges. It also scrolls inside itself, which is
        // why the sheet clips rather than scrolls.
        className={cn("max-h-[80vh]", shape.titled ? "overflow-y-auto" : "overflow-hidden p-0")}
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
      return (
        <CommandPalette
          projects={projects}
          sessions={sessions}
          terminalStates={terminalStates}
          onPick={runCommand}
          onPickSession={pickSession}
          onCancel={onClose}
        />
      );

    case "newSession": {
      // The `+` or context menu's project wins over the selection's, as for the
      // branch sheet; from the header there is only the selection to go on.
      const preselected = sheet.projectID ?? selected?.projectID;
      return (
        <ConnectedNewSessionSheet
          projects={projects}
          initialProjectID={preselected}
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
  }
}

/**
 * Its own component so the overview request runs only while this sheet is the
 * open one: a hook in `SheetBody` would fire for every sheet kind. Holds which
 * project the sheet is on, because that is what the request is keyed by.
 */
function ConnectedNewSessionSheet(props: {
  readonly projects: readonly Project[];
  readonly initialProjectID: ProjectID | undefined;
  readonly sessions: readonly Session[];
  readonly onCreate: (intent: SessionCreationIntent) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const { connection, native } = useClientEnvironment();
  const [projectID, setProjectID] = useState(props.initialProjectID);
  const project = props.projects.find((candidate) => candidate.id === projectID);
  // Only a repository has branches to ask about.
  const overview = useBranchOverview(
    connection,
    project !== undefined && supportsWorktrees(project) ? project.id : undefined,
  );
  const pickDirectory = useCallback(
    () => native.pickDirectory({ title: "Choose Folder" }),
    [native],
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
