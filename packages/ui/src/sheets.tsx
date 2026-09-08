import type { LaunchProfile, LaunchProfileID, SessionID } from "@janela/core";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { useClientEnvironment, useStoreValue } from "./client-environment.tsx";
import { createSessionAndSelect, focusedTerminalOf, selectSession } from "./command-dispatch.ts";
import { CommandPalette } from "./command-palette.tsx";
import type { CommandID } from "./commands.ts";
import type { GlobalSettings } from "./global-settings.ts";
import { JumpList } from "./jump-list.tsx";
import { LaunchProfilePicker } from "./launch-profile-picker.tsx";
import { NewBranchSheet, type NewBranchIntent } from "./new-branch-sheet.tsx";
import { SettingsWindow } from "./settings-window.tsx";
import * as style from "./styles.ts";

/**
 * The one sheet that is open, over a scrim.
 *
 * There is never more than one — `ViewState.sheet` is a single value, not a stack —
 * because two overlapping modal surfaces in a terminal app is how you lose track of
 * which one owns the keyboard.
 *
 * Closing any of them returns focus to the terminal, which is the only reason a
 * user tolerates a modal in a tool they type into all day.
 */

const SHEET_LABEL = {
  jumpList: "Go to Session",
  commands: "Command Palette",
  profilePicker: "New Terminal",
  newBranch: "New Branch Session",
  settings: "Settings",
} as const;

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

  const isOpen = sheet !== undefined;
  useEffect(() => {
    if (!isOpen) return;
    // Escape belongs to the modal, not to whichever field happens to have focus:
    // a sheet you cannot dismiss from the keyboard is a sheet that has taken the
    // keyboard away from the terminal.
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape" || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen, close]);

  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const kind = sheet?.kind;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (kind === undefined || dialog === null) return;
    // Only when the sheet has not already claimed the keyboard: the two lists and
    // the branch sheet focus their own input, and overriding that would put the
    // caret somewhere the user did not ask for. The launch-profile picker is a
    // listbox with no field, and without this it would need a Tab to reach —
    // which is a mouse-free path only in the technical sense.
    if (dialog.contains(document.activeElement)) return;
    const focusable = dialog.querySelector<HTMLElement>(
      'input, [role="listbox"], button, select, [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();
  }, [kind]);

  if (sheet === undefined) return null;

  return (
    <div style={style.SHEET_SCRIM}>
      {/* The scrim as a control, so dismissing by clicking away is a real button
          with a real accessible name rather than a click handler on a backdrop. */}
      <button type="button" aria-label="Dismiss" style={style.SHEET_SCRIM_BUTTON} onClick={close} />
      <dialog ref={dialogRef} open aria-label={SHEET_LABEL[sheet.kind]} style={style.SHEET_BODY}>
        <SheetBody dispatch={dispatch} onClose={close} />
      </dialog>
    </div>
  );
}

function SheetBody(props: {
  readonly dispatch: (id: CommandID) => void;
  readonly onClose: () => void;
}): ReactElement | null {
  const { dispatch, onClose } = props;
  const environment = useClientEnvironment();
  const { view, projects: projectStore, sessions: sessionStore, connection } = environment;

  const sheet = useStoreValue(view, () => view.sheet);
  const projects = useStoreValue(projectStore, () => projectStore.projects);
  const sessions = useStoreValue(sessionStore, () => sessionStore.sessions);
  const selection = useStoreValue(sessionStore, () => sessionStore.selection);
  const terminalStates = useStoreValue(sessionStore, () => sessionStore.terminalStates);
  const profiles = useStoreValue(sessionStore, () => sessionStore.launchProfiles);
  const availability = useStoreValue(sessionStore, () => sessionStore.launchProfileAvailability);
  const settings = useStoreValue(view, () => view.settings);

  const pickSession = useCallback(
    (sessionID: SessionID) => {
      onClose();
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

  const pickProfile = useCallback(
    (profileID: LaunchProfileID) => {
      const sessionID = sheet?.kind === "profilePicker" ? sheet.sessionID : undefined;
      onClose();
      if (sessionID === undefined) return;
      connection
        .request({ type: "createTerminal", sessionID, profileID })
        .catch(swallowRequestFailure);
    },
    [connection, onClose, sheet],
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

  const changeSettings = useCallback(
    (next: GlobalSettings) => {
      view.setSettings(next);
      environment.settings.save(next).catch(swallowRequestFailure);
    },
    [environment, view],
  );

  const profileEditing = useMemo(
    () => ({
      save: (profile: LaunchProfile): void => {
        connection.request({ type: "saveLaunchProfile", profile }).catch(swallowRequestFailure);
      },
      remove: (profileID: LaunchProfileID): void => {
        connection.request({ type: "removeLaunchProfile", profileID }).catch(swallowRequestFailure);
      },
    }),
    [connection],
  );

  const selected = sessions.find((session) => session.id === selection);
  const project = projects.find((candidate) => candidate.id === selected?.projectID);

  if (sheet === undefined) return null;

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

    case "profilePicker":
      return (
        <LaunchProfilePicker
          profiles={profiles}
          availability={availability}
          {...(project?.settings.defaultProfileID === undefined
            ? {}
            : { projectDefaultID: project.settings.defaultProfileID })}
          {...(settings.defaultProfileID === undefined
            ? {}
            : { globalDefaultID: settings.defaultProfileID })}
          onPick={pickProfile}
          onCancel={onClose}
        />
      );

    case "newBranch":
      return (
        <NewBranchSheet
          projects={projects}
          {...(selected?.projectID === undefined ? {} : { initialProjectID: selected.projectID })}
          onCreate={createBranchSession}
          onCancel={onClose}
        />
      );

    case "settings":
      return (
        <SettingsWindow
          settings={settings}
          onChangeSettings={changeSettings}
          profiles={profiles}
          availability={availability}
          profileEditing={profileEditing}
          sessions={sessions}
          terminalStates={terminalStates}
          service={environment.service}
        />
      );
  }
}
