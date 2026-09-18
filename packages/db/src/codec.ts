import type {
  AbsolutePath,
  Accent,
  AutomationEvent,
  AutomationScript,
  AutomationScripts,
  Axis,
  Forge,
  GitDescriptor,
  Identifier,
  Instant,
  LayoutTab,
  Pane,
  Project,
  ProjectID,
  ProjectSettings,
  Session,
  SessionLayout,
  TerminalDescriptor,
  TerminalID,
  TerminalRole,
  WorktreeBinding,
  WorktreeOwnership,
  WorktreeRoot,
} from "@janela/core";
import {
  ACCENTS,
  AUTOMATION_EVENTS,
  MAXIMUM_PANE_DEPTH,
  absolutePath,
  backingViolations,
  identifier,
  instant,
  layoutViolations,
  repairLayout,
  toDate,
} from "@janela/core";
import type { Logger } from "@janela/support";
import { Option, Schema } from "effect";

import type { Prisma } from "../generated/prisma/client.ts";
import { CorruptRecord, InvalidRecord } from "./errors.ts";

export type ProjectRow = Prisma.ProjectGetPayload<{ include: { automation: true } }>;
export type SessionRow = Prisma.SessionGetPayload<{ include: { terminals: true } }>;

export interface ProjectColumns {
  readonly name: string;
  readonly directory: string;
  readonly remoteURL: string | null;
  readonly defaultBranch: string | null;
  readonly forge: string | null;
  readonly worktreeRoot: string;
  readonly worktreeRootPath: string | null;
  readonly accent: string;
  readonly isExpanded: boolean;
  readonly addedAt: Date;
}

export interface AutomationColumns {
  readonly projectId: string;
  readonly event: string;
  readonly script: string;
  readonly timeoutSeconds: number;
}

export interface SessionColumns {
  readonly projectId: string | null;
  readonly name: string;
  readonly directory: string;
  readonly backingKind: string;
  readonly worktreeBranch: string | null;
  readonly worktreeBaseCommit: string | null;
  readonly worktreeOwnership: string | null;
  readonly worktreeIncludedPaths: string | null;
  readonly layout: string;
  readonly accent: string;
  readonly createdAt: Date;
  readonly lastActiveAt: Date;
  readonly isPinned: boolean;
}

export interface TerminalColumns {
  readonly sessionId: string;
  readonly title: string;
  readonly workingDirectoryOverride: string | null;
  readonly startsAutomatically: boolean;
  readonly role: string;
  readonly position: number;
  readonly createdAt: Date;
}

type StoredPane =
  | { readonly kind: "terminal"; readonly id: string }
  | {
      readonly kind: "split";
      readonly axis: Axis;
      readonly fraction: number;
      readonly first: StoredPane;
      readonly second: StoredPane;
    };

interface StoredTab {
  readonly title?: string;
  readonly root: StoredPane;
  readonly focusedTerminalID: string;
}

interface StoredLayout {
  readonly tabs: readonly StoredTab[];
  readonly focusedTabIndex: number;
}

interface DecodedTab {
  title?: string;
  root: Pane;
  focusedTerminalID: TerminalID;
}

const DEEPEST_BRANDED_LEVEL = MAXIMUM_PANE_DEPTH + 1;

const IdentifierColumn = Schema.String.check(Schema.isGUID());

const decodeIdentifierColumn = Schema.decodeUnknownOption(IdentifierColumn);

const decodeAbsolutePathColumn = Schema.decodeUnknownOption(
  Schema.String.check(Schema.isStartsWith("/")),
);

const decodeStringArrayColumn = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

const StoredTerminalPane = Schema.Struct({
  kind: Schema.Literal("terminal"),
  id: IdentifierColumn,
});

const StoredSplitPane = Schema.Struct({
  kind: Schema.Literal("split"),
  axis: Schema.Literals(["horizontal", "vertical"]),
  fraction: Schema.Number,
  first: Schema.suspend((): Schema.Codec<StoredPane> => StoredPaneSchema),
  second: Schema.suspend((): Schema.Codec<StoredPane> => StoredPaneSchema),
});

const StoredPaneSchema: Schema.Codec<StoredPane> = Schema.Union([
  StoredTerminalPane,
  StoredSplitPane,
]);

const StoredLayoutSchema = Schema.Struct({
  tabs: Schema.Array(
    Schema.Struct({
      title: Schema.optionalKey(Schema.String),
      root: StoredPaneSchema,
      focusedTerminalID: IdentifierColumn,
    }),
  ),
  focusedTabIndex: Schema.Number,
});

const decodeLayoutColumn = Option.liftThrowable(
  Schema.decodeUnknownOption(Schema.fromJsonString(StoredLayoutSchema)),
);

function readIdentifier<Subject extends string>(
  raw: string,
  column: string,
  reasons: string[],
): Identifier<Subject> | undefined {
  const decoded = decodeIdentifierColumn(raw);

  if (Option.isNone(decoded)) {
    reasons.push(`${column} is not a UUID`);

    return undefined;
  }

  return identifier<Subject>(decoded.value);
}

function readAbsolutePath(
  raw: string,
  column: string,
  reasons: string[],
): AbsolutePath | undefined {
  const decoded = decodeAbsolutePathColumn(raw);

  if (Option.isNone(decoded)) {
    reasons.push(`${column} is not an absolute path`);

    return undefined;
  }

  return absolutePath(decoded.value);
}

function readInstant(raw: Date, column: string, reasons: string[]): Instant | undefined {
  if (Number.isNaN(raw.getTime())) {
    reasons.push(`${column} is not an instant`);

    return undefined;
  }

  return instant(raw);
}

function readAccent(raw: string, table: "Project" | "Session", id: string, log: Logger): Accent {
  const known = ACCENTS.find((accent) => accent === raw);

  if (known !== undefined) return known;

  log.warning("accent unknown, defaulted", { table, id });

  return "none";
}

export function encodeProject(project: Project): ProjectColumns {
  const root = project.settings.worktreeRoot;

  return {
    name: project.name,
    directory: project.directory,
    remoteURL: project.git?.remoteURL ?? null,
    defaultBranch: project.git?.defaultBranch ?? null,
    forge: project.git?.forge ?? null,
    worktreeRoot: root.kind,
    worktreeRootPath: root.kind === "custom" ? root.directory : null,
    accent: project.accent,
    isExpanded: project.isExpanded,
    addedAt: toDate(project.addedAt),
  };
}

export function encodeAutomation(
  automation: AutomationScripts,
  projectId: ProjectID,
): readonly AutomationColumns[] {
  return AUTOMATION_EVENTS.flatMap((event) => {
    const entry = automation[event];

    return entry === undefined
      ? []
      : [{ projectId, event, script: entry.script, timeoutSeconds: entry.timeoutSeconds }];
  });
}

function decodeForge(raw: string, id: string, log: Logger): Forge | undefined {
  if (raw === "gitHub" || raw === "gitLab") return raw;

  log.warning("forge unknown, defaulted", { table: "Project", id });

  return undefined;
}

function decodeWorktreeRoot(
  kind: string,
  path: string | null,
  reasons: string[],
): WorktreeRoot | undefined {
  if (kind === "siblingDirectory") {
    if (path === null) return { kind: "siblingDirectory" };

    reasons.push("worktreeRootPath set on siblingDirectory worktreeRoot");

    return undefined;
  }

  if (kind === "custom") {
    if (path === null) {
      reasons.push("worktreeRootPath missing on custom worktreeRoot");

      return undefined;
    }

    const directory = readAbsolutePath(path, "worktreeRootPath", reasons);

    return directory === undefined ? undefined : { kind: "custom", directory };
  }

  reasons.push("worktreeRoot is not siblingDirectory or custom");

  return undefined;
}

function decodeAutomation(
  rows: readonly ProjectRow["automation"][number][],
  reasons: string[],
): AutomationScripts {
  const scripts: Partial<Record<AutomationEvent, AutomationScript>> = {};

  for (const row of rows) {
    const event = AUTOMATION_EVENTS.find((candidate) => candidate === row.event);

    if (event === undefined) {
      reasons.push(`automation ${row.event}: event unknown`);

      continue;
    }

    scripts[event] = { script: row.script, timeoutSeconds: row.timeoutSeconds };
  }

  return scripts;
}

export function decodeProject(row: ProjectRow, log: Logger): Project {
  const reasons: string[] = [];
  const id = readIdentifier<"Project">(row.id, "id", reasons);
  const directory = readAbsolutePath(row.directory, "directory", reasons);
  const addedAt = readInstant(row.addedAt, "addedAt", reasons);
  const worktreeRoot = decodeWorktreeRoot(row.worktreeRoot, row.worktreeRootPath, reasons);
  const automation = decodeAutomation(row.automation, reasons);

  const hasGit = row.remoteURL !== null || row.defaultBranch !== null || row.forge !== null;
  const forge = row.forge === null ? undefined : decodeForge(row.forge, row.id, log);

  if (
    id === undefined ||
    directory === undefined ||
    addedAt === undefined ||
    worktreeRoot === undefined
  ) {
    throw new CorruptRecord("Project", row.id, reasons);
  }

  if (reasons.length > 0) throw new CorruptRecord("Project", row.id, reasons);

  const settings: ProjectSettings = {
    worktreeRoot,
    automation,
  };

  const project: Project = {
    id,
    name: row.name,
    directory,
    settings,
    accent: readAccent(row.accent, "Project", row.id, log),
    isExpanded: row.isExpanded,
    addedAt,
  };

  if (hasGit) {
    const git: GitDescriptor = {};

    if (row.remoteURL !== null) git.remoteURL = row.remoteURL;

    if (row.defaultBranch !== null) git.defaultBranch = row.defaultBranch;

    if (forge !== undefined) git.forge = forge;

    project.git = git;
  }

  return project;
}

export function encodeSession(session: Session): SessionColumns {
  const binding = session.backing.kind === "worktree" ? session.backing.binding : undefined;

  return {
    projectId: session.projectID ?? null,
    name: session.name,
    directory: session.directory,
    backingKind: session.backing.kind,
    worktreeBranch: binding?.branch ?? null,
    worktreeBaseCommit: binding?.baseCommit ?? null,
    worktreeOwnership: binding?.ownership ?? null,
    worktreeIncludedPaths: binding === undefined ? null : JSON.stringify(binding.includedPaths),
    layout: JSON.stringify(session.layout),
    accent: session.accent,
    createdAt: toDate(session.createdAt),
    lastActiveAt: toDate(session.lastActiveAt),
    isPinned: session.isPinned,
  };
}

export function encodeTerminal(
  terminal: TerminalDescriptor,
  sessionId: string,
  position: number,
): TerminalColumns {
  return {
    sessionId,
    title: terminal.title,
    workingDirectoryOverride: terminal.workingDirectoryOverride ?? null,
    startsAutomatically: terminal.startsAutomatically,
    role: terminal.role.kind === "user" ? "user" : terminal.role.event,
    position,
    createdAt: toDate(terminal.createdAt),
  };
}

export function sessionViolations(session: Session): readonly string[] {
  const reasons = [...backingViolations(session)];
  const ids = session.terminals.map((terminal) => terminal.id);

  if (new Set(ids).size !== ids.length) reasons.push("terminals contain a duplicate id");

  reasons.push(...layoutViolations(session.layout, ids));

  if (session.backing.kind === "worktree" && session.backing.binding.path !== session.directory) {
    reasons.push("worktree binding path differs from the session directory");
  }

  return reasons;
}

export function requireWritableSession(session: Session): void {
  const reasons = sessionViolations(session);

  if (reasons.length > 0) throw new InvalidRecord("Session", session.id, reasons);
}

function decodeRole(raw: string, label: string, reasons: string[]): TerminalRole | undefined {
  if (raw === "user") return { kind: "user" };

  const event = AUTOMATION_EVENTS.find((candidate) => candidate === raw);

  if (event !== undefined) return { kind: "automation", event };

  reasons.push(`${label}: role unknown`);

  return undefined;
}

function decodeTerminals(
  rows: readonly SessionRow["terminals"][number][],
  reasons: string[],
): TerminalDescriptor[] {
  const terminals: TerminalDescriptor[] = [];

  for (const [index, row] of rows.toSorted((a, b) => a.position - b.position).entries()) {
    const label = `terminal ${index}`;
    const id = readIdentifier<"Terminal">(row.id, `${label}: id`, reasons);
    const role = decodeRole(row.role, label, reasons);
    const createdAt = readInstant(row.createdAt, `${label}: createdAt`, reasons);

    const override =
      row.workingDirectoryOverride === null
        ? undefined
        : readAbsolutePath(
            row.workingDirectoryOverride,
            `${label}: workingDirectoryOverride`,
            reasons,
          );

    if (id === undefined || role === undefined || createdAt === undefined) continue;

    if (row.workingDirectoryOverride !== null && override === undefined) continue;

    const descriptor: TerminalDescriptor = {
      id,
      title: row.title,
      startsAutomatically: row.startsAutomatically,
      role,
      createdAt,
    };

    if (override !== undefined) descriptor.workingDirectoryOverride = override;

    terminals.push(descriptor);
  }

  return terminals;
}

function leftmostTerminalID(pane: StoredPane): TerminalID {
  let node = pane;

  while (node.kind === "split") node = node.first;

  return identifier<"Terminal">(node.id);
}

function brandPane(pane: StoredPane, level: number): Pane {
  if (pane.kind === "terminal") return { kind: "terminal", id: identifier<"Terminal">(pane.id) };

  if (level >= DEEPEST_BRANDED_LEVEL) return { kind: "terminal", id: leftmostTerminalID(pane) };

  return {
    kind: "split",
    axis: pane.axis,
    fraction: pane.fraction,
    first: brandPane(pane.first, level + 1),
    second: brandPane(pane.second, level + 1),
  };
}

function brandLayout(stored: StoredLayout): SessionLayout {
  const tabs = stored.tabs.map((tab): LayoutTab => {
    const decoded: DecodedTab = {
      root: brandPane(tab.root, 1),
      focusedTerminalID: identifier<"Terminal">(tab.focusedTerminalID),
    };

    if (tab.title !== undefined) decoded.title = tab.title;

    return decoded;
  });

  return { tabs, focusedTabIndex: stored.focusedTabIndex };
}

function rebuiltLayout(ids: readonly TerminalID[]): SessionLayout {
  const tabs = ids.map((id) => {
    const root: Pane = { kind: "terminal", id };

    return { root, focusedTerminalID: id };
  });

  return { tabs, focusedTabIndex: 0 };
}

function readLayout(
  raw: string,
  ids: readonly TerminalID[],
  sessionID: string,
  log: Logger,
): SessionLayout {
  const stored = Option.flatten(decodeLayoutColumn(raw));

  if (Option.isSome(stored)) return brandLayout(stored.value);

  log.warning("layout unreadable, rebuilt", { sessionID });

  return rebuiltLayout(ids);
}

function decodeLayout(
  raw: string,
  ids: readonly TerminalID[],
  sessionID: string,
  log: Logger,
): SessionLayout {
  const layout = readLayout(raw, ids, sessionID, log);

  for (const reason of layoutViolations(layout, ids)) {
    log.warning("layout repaired", { sessionID, reason });
  }

  return repairLayout(layout, ids);
}

function decodeBacking(
  row: SessionRow,
  directory: AbsolutePath,
  reasons: string[],
): Session["backing"] | undefined {
  const worktreeColumns: readonly (readonly [string, string | null])[] = [
    ["worktreeBranch", row.worktreeBranch],
    ["worktreeBaseCommit", row.worktreeBaseCommit],
    ["worktreeOwnership", row.worktreeOwnership],
    ["worktreeIncludedPaths", row.worktreeIncludedPaths],
  ];

  if (row.backingKind === "folder" || row.backingKind === "projectDirectory") {
    for (const [column, value] of worktreeColumns) {
      if (value !== null) reasons.push(`${column} set on ${row.backingKind} backing`);
    }

    return reasons.length > 0 ? undefined : { kind: row.backingKind };
  }

  if (row.backingKind !== "worktree") {
    reasons.push("backingKind is not folder, projectDirectory or worktree");

    return undefined;
  }

  const ownership: WorktreeOwnership | undefined =
    row.worktreeOwnership === "managed" || row.worktreeOwnership === "adopted"
      ? row.worktreeOwnership
      : undefined;

  if (ownership === undefined) reasons.push("worktreeOwnership is not managed or adopted");

  const includedPaths =
    row.worktreeIncludedPaths === null
      ? Option.none<readonly string[]>()
      : decodeStringArrayColumn(row.worktreeIncludedPaths);

  if (Option.isNone(includedPaths)) {
    reasons.push("worktreeIncludedPaths is not a JSON array of strings");
  }

  if (ownership === undefined || Option.isNone(includedPaths)) return undefined;

  const binding: WorktreeBinding = {
    path: directory,
    ownership,
    includedPaths: includedPaths.value,
  };

  if (row.worktreeBranch !== null) binding.branch = row.worktreeBranch;

  if (row.worktreeBaseCommit !== null) binding.baseCommit = row.worktreeBaseCommit;

  return { kind: "worktree", binding };
}

export function decodeSession(row: SessionRow, log: Logger): Session {
  const reasons: string[] = [];
  const id = readIdentifier<"Session">(row.id, "id", reasons);
  const directory = readAbsolutePath(row.directory, "directory", reasons);
  const createdAt = readInstant(row.createdAt, "createdAt", reasons);
  const lastActiveAt = readInstant(row.lastActiveAt, "lastActiveAt", reasons);
  const terminals = decodeTerminals(row.terminals, reasons);

  const projectID =
    row.projectId === null
      ? undefined
      : readIdentifier<"Project">(row.projectId, "projectId", reasons);
  const projectMissing = row.projectId !== null && projectID === undefined;

  const backing = directory === undefined ? undefined : decodeBacking(row, directory, reasons);

  if (
    id === undefined ||
    directory === undefined ||
    createdAt === undefined ||
    lastActiveAt === undefined ||
    backing === undefined ||
    projectMissing
  ) {
    throw new CorruptRecord("Session", row.id, reasons);
  }

  if (reasons.length > 0) throw new CorruptRecord("Session", row.id, reasons);

  const session: Session = {
    id,
    name: row.name,
    directory,
    backing,
    terminals,
    layout: decodeLayout(
      row.layout,
      terminals.map((terminal) => terminal.id),
      row.id,
      log,
    ),
    accent: readAccent(row.accent, "Session", row.id, log),
    createdAt,
    lastActiveAt,
    isPinned: row.isPinned,
  };

  if (projectID !== undefined) session.projectID = projectID;

  const violations = backingViolations(session);

  if (violations.length > 0) throw new CorruptRecord("Session", row.id, violations);

  return session;
}
