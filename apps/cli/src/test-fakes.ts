import { createStores, type ClientRequest, type Stores } from "@janela/client";
import {
  absolutePath,
  identifier,
  instant,
  type Project,
  type ProjectID,
  type Session,
  type TerminalDescriptor,
  type TerminalID,
  type TerminalState,
} from "@janela/core";

import type { CommandContext, Output } from "./commands.ts";

export interface RecordedOutput extends Output {
  readonly text: () => string;
}

export interface FakeDaemon {
  readonly context: CommandContext;
  readonly stores: Stores;
  readonly sent: ClientRequest[];
  readonly output: RecordedOutput;
}

export type Answer = (request: ClientRequest, stores: Stores) => string | undefined;

const CREATED = instant("2026-10-01T00:00:00.000Z");

export function terminal(id: string, title = "Shell"): TerminalDescriptor {
  return {
    id: identifier<"Terminal">(id),
    title,
    startsAutomatically: true,
    role: { kind: "user" },
    createdAt: CREATED,
  };
}

export function project(id: string, name: string): Project {
  return {
    id: identifier<"Project">(id),
    name,
    directory: absolutePath(`/code/${name}`),
    settings: { worktreeRoot: { kind: "siblingDirectory" }, automation: {} },
    accent: "none",
    isExpanded: true,
    addedAt: CREATED,
  };
}

export function session(
  id: string,
  name: string,
  terminals: readonly TerminalDescriptor[] = [],
  projectID: ProjectID | undefined = undefined,
): Session {
  const made: Session = {
    id: identifier<"Session">(id),
    name,
    nameOrigin: "derived",
    directory: absolutePath(`/work/${name}`),
    backing: projectID === undefined ? { kind: "folder" } : { kind: "projectDirectory" },
    terminals,
    layout: { tabs: [], focusedTabIndex: 0 },
    accent: "none",
    createdAt: CREATED,
    lastActiveAt: CREATED,
    isPinned: false,
  };

  if (projectID !== undefined) made.projectID = projectID;

  return made;
}

export function recordedOutput(): RecordedOutput {
  const chunks: string[] = [];

  return {
    line: (text) => {
      chunks.push(`${text}\n`);
    },
    write: (text) => {
      chunks.push(text);
    },
    text: () => chunks.join(""),
  };
}

export function fakeDaemon(options: {
  readonly projects?: readonly Project[];
  readonly sessions?: readonly Session[];
  readonly terminalStates?: Readonly<Record<TerminalID, TerminalState>>;
  readonly answer?: Answer;
  readonly confirm?: (question: string) => Promise<boolean>;
}): FakeDaemon {
  const stores = createStores();
  const sent: ClientRequest[] = [];
  const output = recordedOutput();

  stores.mirror.apply({
    projects: options.projects ?? [],
    sessions: options.sessions ?? [],
    terminalStates: options.terminalStates ?? {},
    isFullSnapshot: true,
  });

  const context: CommandContext = {
    connection: {
      request: (message) => {
        sent.push(message);

        return Promise.resolve(options.answer?.(message, stores));
      },
    },
    stores,
    output,
    confirm: options.confirm,
    settleTimeoutMs: 20,
  };

  return { context, stores, sent, output };
}
