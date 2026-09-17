import {
  absolutePath,
  emptyLayout,
  instant,
  singleTerminalLayout,
  splitPane,
  type Project,
  type ProjectID,
  type Session,
  type SessionID,
  type SessionLayout,
  type TerminalDescriptor,
  type TerminalID,
  type TerminalState,
} from "@janela/core";

import { withFocusedTerminal } from "../../../shared/model/index.ts";

const AT = instant("2026-01-01T00:00:00.000Z");

export const NO_STATES: Readonly<Record<TerminalID, TerminalState>> = {};

export function terminalID(raw: string): TerminalID {
  // SAFETY: a fixture id is only ever compared for equality inside this package's tests, and `TerminalID` brands a string nominally — the brand adds no representation the string does not already have.
  return raw as TerminalID;
}

export function sessionID(raw: string): SessionID {
  // SAFETY: as `terminalID` above — a fixture id is compared for equality only, and `SessionID` is a nominal brand over the same string.
  return raw as SessionID;
}

export function projectID(raw: string): ProjectID {
  // SAFETY: as `terminalID` above — a fixture id is compared for equality only, and `ProjectID` is a nominal brand over the same string.
  return raw as ProjectID;
}

export function terminal(id: string, title = id): TerminalDescriptor {
  return {
    id: terminalID(id),
    title,
    startsAutomatically: false,
    role: { kind: "user" },
    createdAt: AT,
  };
}

export function session(
  id: string,
  extra: {
    readonly project?: string;
    readonly terminals?: readonly TerminalDescriptor[];
    readonly layout?: SessionLayout;
  } = {},
): Session {
  const created: Session = {
    id: sessionID(id),
    name: id,
    directory: absolutePath(`/tmp/${id}`),
    backing: { kind: "folder" },
    terminals: extra.terminals ?? [],
    layout: extra.layout ?? emptyLayout,
    accent: "none",
    createdAt: AT,
    lastActiveAt: AT,
    isPinned: false,
  };

  if (extra.project === undefined) return created;

  return { ...created, projectID: projectID(extra.project) };
}

export function project(id: string, isExpanded: boolean): Project {
  return {
    id: projectID(id),
    name: id,
    directory: absolutePath(`/repos/${id}`),
    settings: {
      worktreeRoot: { kind: "siblingDirectory" },
      automation: {},
      isForgeEnabled: false,
    },
    accent: "none",
    isExpanded,
    addedAt: AT,
  };
}

export function splitFocusing(id: TerminalID): SessionLayout {
  const split = splitPane(
    singleTerminalLayout(terminalID("t1")),
    terminalID("t1"),
    terminalID("t2"),
    "horizontal",
  );

  return withFocusedTerminal(split, id);
}
