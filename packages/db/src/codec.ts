/**
 * Rows in, `@janela/core` values out — and back.
 *
 * This is where the three lossy mappings `repositories.ts` names are actually
 * paid for, and the rule set is what keeps a corrupt file from becoming a
 * plausible-looking lie:
 *
 * - **A discriminator with payload columns is CORRUPT when it is inconsistent.**
 *   `backingKind`, `worktreeOwnership`, `worktreeRoot`, a terminal's `role`, an
 *   automation `event`, and every argv/environment JSON column. A half-populated
 *   worktree backing is *representable* in SQL and meaningless in the domain, so
 *   it is rejected rather than guessed. Guessing here would put a session in front
 *   of a user whose "delete the worktree too" answer we invented.
 * - **A cosmetic or cached enumeration DEGRADES.** `accent` falls back to `none`,
 *   an unrecognised `forge` becomes absent, each with a warning. Refusing to load
 *   a project because a colour name is unknown is a worse outcome than a grey dot.
 * - **`layout` is REPAIRED, never thrown.** A session the user cannot open is
 *   worse than a session that lost a split — see `repairLayout`.
 *
 * Optional core fields are built conditionally rather than assigned `undefined`,
 * because `exactOptionalPropertyTypes` is on and "present but undefined" is a
 * different value from "absent" on the wire.
 *
 * Not exported from the package: these signatures name Prisma row types, and a
 * generated type above `@janela/db` is a leaked schema (ADR 0019).
 */

import type {
  AbsolutePath,
  Accent,
  AutomationCommand,
  Forge,
  Identifier,
  Instant,
  LaunchProfile,
  Pane,
  Project,
  ProjectID,
  Session,
  SessionLayout,
  TerminalDescriptor,
  TerminalID,
  TerminalRole,
  WorktreeOwnership,
  WorktreeRoot,
} from "@janela/core";
import {
  ACCENTS,
  AUTOMATION_EVENTS,
  absolutePath,
  backingViolations,
  identifier,
  instant,
  layoutViolations,
  repairLayout,
  toDate,
} from "@janela/core";
import type { Logger } from "@janela/support";

import type { Prisma } from "../generated/prisma/client.ts";
import { CorruptRecord, InvalidRecord } from "./errors.ts";

export type LaunchProfileRow = Prisma.LaunchProfileModel;
export type ProjectRow = Prisma.ProjectGetPayload<{ include: { automation: true } }>;
export type SessionRow = Prisma.SessionGetPayload<{ include: { terminals: true } }>;

// ---- Scalar column sets.
//
// Written as their own interfaces rather than as Prisma's create inputs so an
// encoder cannot silently start relying on a relation write, and so `update`
// omitting a column (`id`, `position`) is visible in the type rather than in a
// comment.

export interface LaunchProfileColumns {
  readonly name: string;
  readonly iconName: string;
  readonly command: string;
  readonly environment: string;
  readonly isAgent: boolean;
  readonly isBuiltIn: boolean;
}

export interface ProjectColumns {
  readonly name: string;
  readonly directory: string;
  readonly remoteURL: string | null;
  readonly defaultBranch: string | null;
  readonly forge: string | null;
  readonly worktreeRoot: string;
  readonly worktreeRootPath: string | null;
  readonly isForgeEnabled: boolean;
  readonly accent: string;
  readonly isExpanded: boolean;
  readonly addedAt: Date;
  readonly defaultProfileId: string | null;
}

export interface AutomationColumns {
  readonly projectId: string;
  readonly event: string;
  readonly command: string;
  readonly isEnabled: boolean;
  readonly timeoutSeconds: number;
  readonly position: number;
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
  readonly profileId: string | null;
}

// ---- Decode helpers.
//
// Each returns `undefined` on failure *and* pushes a reason, so the caller's
// "any of these is undefined" check and the accumulated reasons are always
// consistent. That pairing is what lets a decoder report every problem with a row
// at once instead of the first one, while still narrowing for the compiler.

function jsonStringArray(raw: string): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  return parsed.every((element) => typeof element === "string") ? (parsed as string[]) : undefined;
}

function jsonStringRecord(raw: string): Record<string, string> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const entries = Object.entries(parsed);
  return entries.every(([, value]) => typeof value === "string")
    ? (parsed as Record<string, string>)
    : undefined;
}

function readIdentifier<Subject extends string>(
  raw: string,
  column: string,
  reasons: string[],
): Identifier<Subject> | undefined {
  try {
    return identifier<Subject>(raw);
  } catch {
    reasons.push(`${column} is not a UUID`);
    return undefined;
  }
}

function readAbsolutePath(
  raw: string,
  column: string,
  reasons: string[],
): AbsolutePath | undefined {
  try {
    return absolutePath(raw);
  } catch {
    reasons.push(`${column} is not an absolute path`);
    return undefined;
  }
}

function readInstant(raw: Date, column: string, reasons: string[]): Instant | undefined {
  try {
    return instant(raw);
  } catch {
    reasons.push(`${column} is not an instant`);
    return undefined;
  }
}

function readArgv(raw: string, column: string, reasons: string[]): string[] | undefined {
  const parsed = jsonStringArray(raw);
  // The bug this names is the one worth naming: an argv array that round-trips
  // into a string is the quoting bug class coming back through the database, so
  // a stored `'"claude --dangerous"'` is refused rather than read as one word.
  if (parsed === undefined) reasons.push(`${column} is not a JSON array of strings`);
  return parsed;
}

/** A cosmetic enumeration: unknown degrades, and says so, rather than failing a load. */
function readAccent(raw: string, table: "Project" | "Session", id: string, log: Logger): Accent {
  const known = ACCENTS.find((accent) => accent === raw);
  if (known !== undefined) return known;
  log.warning("accent unknown, defaulted", { table, id });
  return "none";
}

// ---- Launch profile.

/** Takes an id-less profile too, because `seedBuiltIns` mints the id itself. */
export function encodeLaunchProfile(profile: Omit<LaunchProfile, "id">): LaunchProfileColumns {
  return {
    name: profile.name,
    iconName: profile.iconName,
    command: JSON.stringify(profile.command),
    environment: JSON.stringify(profile.environment),
    isAgent: profile.isAgent,
    isBuiltIn: profile.isBuiltIn,
  };
}

export function decodeLaunchProfile(row: LaunchProfileRow): LaunchProfile {
  const reasons: string[] = [];
  const id = readIdentifier<"LaunchProfile">(row.id, "id", reasons);
  const command = readArgv(row.command, "command", reasons);
  const environment = jsonStringRecord(row.environment);
  if (environment === undefined) reasons.push("environment is not a JSON object of strings");

  if (id === undefined || command === undefined || environment === undefined) {
    throw new CorruptRecord("LaunchProfile", row.id, reasons);
  }

  return {
    id,
    name: row.name,
    iconName: row.iconName,
    command,
    environment,
    isAgent: row.isAgent,
    isBuiltIn: row.isBuiltIn,
  };
}

// ---- Project.

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
    isForgeEnabled: project.settings.isForgeEnabled,
    accent: project.accent,
    isExpanded: project.isExpanded,
    addedAt: toDate(project.addedAt),
    defaultProfileId: project.settings.defaultProfileID ?? null,
  };
}

export function encodeAutomation(
  command: AutomationCommand,
  projectId: ProjectID,
  position: number,
): AutomationColumns {
  return {
    projectId,
    event: command.event,
    command: JSON.stringify(command.command),
    isEnabled: command.isEnabled,
    timeoutSeconds: command.timeoutSeconds,
    position,
  };
}

function decodeForge(raw: string, id: string, log: Logger): Forge | undefined {
  if (raw === "gitHub" || raw === "gitLab") return raw;
  // A cached display fact, not a capability: forgetting which forge this is costs
  // a badge, while refusing to load the project costs the user their sessions.
  log.warning("forge unknown, defaulted", { table: "Project", id });
  return undefined;
}

function decodeWorktreeRoot(
  kind: string,
  path: string | null,
  reasons: string[],
): WorktreeRoot | undefined {
  if (kind === "siblingDirectory") {
    if (path !== null) reasons.push("worktreeRootPath set on siblingDirectory worktreeRoot");
    else return { kind: "siblingDirectory" };
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
): AutomationCommand[] {
  const commands: AutomationCommand[] = [];

  // Sorted here as well as in the query: the repository asks for position order,
  // and this makes the decoder's indices right whoever hands it the rows.
  for (const [index, row] of rows.toSorted((a, b) => a.position - b.position).entries()) {
    const id = readIdentifier<"Automation">(row.id, `automation ${index}: id`, reasons);
    const event = AUTOMATION_EVENTS.find((candidate) => candidate === row.event);
    if (event === undefined) reasons.push(`automation ${index}: event unknown`);
    const command = readArgv(row.command, `automation ${index}: command`, reasons);
    if (id === undefined || event === undefined || command === undefined) continue;

    commands.push({
      id,
      event,
      command,
      isEnabled: row.isEnabled,
      timeoutSeconds: row.timeoutSeconds,
    });
  }

  return commands;
}

export function decodeProject(row: ProjectRow, log: Logger): Project {
  const reasons: string[] = [];
  const id = readIdentifier<"Project">(row.id, "id", reasons);
  const directory = readAbsolutePath(row.directory, "directory", reasons);
  const addedAt = readInstant(row.addedAt, "addedAt", reasons);
  const worktreeRoot = decodeWorktreeRoot(row.worktreeRoot, row.worktreeRootPath, reasons);
  const automation = decodeAutomation(row.automation, reasons);

  const defaultProfileID =
    row.defaultProfileId === null
      ? undefined
      : readIdentifier<"LaunchProfile">(row.defaultProfileId, "defaultProfileId", reasons);
  const defaultProfileMissing = row.defaultProfileId !== null && defaultProfileID === undefined;

  // Absent `git` is all three columns NULL, and nothing else. The corollary is a
  // contract for whoever registers a repository: always record `defaultBranch`,
  // or a project with a remote reads back as not a repository at all.
  const hasGit = row.remoteURL !== null || row.defaultBranch !== null || row.forge !== null;
  const forge = row.forge === null ? undefined : decodeForge(row.forge, row.id, log);

  if (
    id === undefined ||
    directory === undefined ||
    addedAt === undefined ||
    worktreeRoot === undefined ||
    defaultProfileMissing
  ) {
    throw new CorruptRecord("Project", row.id, reasons);
  }
  if (reasons.length > 0) throw new CorruptRecord("Project", row.id, reasons);

  return {
    id,
    name: row.name,
    directory,
    ...(hasGit
      ? {
          git: {
            ...(row.remoteURL === null ? {} : { remoteURL: row.remoteURL }),
            ...(row.defaultBranch === null ? {} : { defaultBranch: row.defaultBranch }),
            ...(forge === undefined ? {} : { forge }),
          },
        }
      : {}),
    settings: {
      worktreeRoot,
      automation,
      ...(defaultProfileID === undefined ? {} : { defaultProfileID }),
      isForgeEnabled: row.isForgeEnabled,
    },
    accent: readAccent(row.accent, "Project", row.id, log),
    isExpanded: row.isExpanded,
    addedAt,
  };
}

// ---- Session.

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
    // `binding.path` has no column of its own: it is the session's `directory`,
    // and `sessionViolations` refuses a value where the two disagree.
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
    profileId: terminal.profileID ?? null,
  };
}

/**
 * Why a `Session` may not be written, empty when it may.
 *
 * Checked before any I/O, so a caller's bug never lands a row that the decoder
 * would then have to refuse. The layout check is the one that matters most: it is
 * what stops a depth-7 tree being stored and silently truncated on the way back.
 */
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

/** Throws `InvalidRecord` when `session` may not be written. */
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

    const profileID =
      row.profileId === null
        ? undefined
        : readIdentifier<"LaunchProfile">(row.profileId, `${label}: profileId`, reasons);
    const override =
      row.workingDirectoryOverride === null
        ? undefined
        : readAbsolutePath(
            row.workingDirectoryOverride,
            `${label}: workingDirectoryOverride`,
            reasons,
          );

    if (id === undefined || role === undefined || createdAt === undefined) continue;
    if (row.profileId !== null && profileID === undefined) continue;
    if (row.workingDirectoryOverride !== null && override === undefined) continue;

    terminals.push({
      id,
      title: row.title,
      ...(profileID === undefined ? {} : { profileID }),
      ...(override === undefined ? {} : { workingDirectoryOverride: override }),
      startsAutomatically: row.startsAutomatically,
      role,
      createdAt,
    });
  }

  return terminals;
}

/**
 * Whether a parsed blob has the shape of a `SessionLayout`.
 *
 * Iterative, with an explicit stack: this runs on a value that came off disk and
 * may be arbitrarily deep, and a recursive validator would exhaust the stack on
 * exactly the input it exists to reject. Depth itself is not judged here —
 * `repairLayout` truncates, which is a repair rather than a refusal.
 */
function isLayoutShape(value: unknown): value is SessionLayout {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { tabs?: unknown; focusedTabIndex?: unknown };
  if (!Array.isArray(candidate.tabs)) return false;
  if (typeof candidate.focusedTabIndex !== "number") return false;

  const panes: unknown[] = [];
  for (const tab of candidate.tabs) {
    if (typeof tab !== "object" || tab === null) return false;
    const fields = tab as { root?: unknown; focusedTerminalID?: unknown; title?: unknown };
    if (typeof fields.focusedTerminalID !== "string") return false;
    if (fields.title !== undefined && typeof fields.title !== "string") return false;
    panes.push(fields.root);
  }

  while (panes.length > 0) {
    const pane = panes.pop();
    if (typeof pane !== "object" || pane === null) return false;
    const fields = pane as {
      kind?: unknown;
      id?: unknown;
      axis?: unknown;
      fraction?: unknown;
      first?: unknown;
      second?: unknown;
    };
    if (fields.kind === "terminal") {
      if (typeof fields.id !== "string") return false;
      continue;
    }
    if (fields.kind !== "split") return false;
    if (fields.axis !== "horizontal" && fields.axis !== "vertical") return false;
    if (typeof fields.fraction !== "number") return false;
    panes.push(fields.first, fields.second);
  }

  return true;
}

/** One tab per terminal, so a lost layout loses arrangement and never a terminal. */
function rebuiltLayout(ids: readonly TerminalID[]): SessionLayout {
  const tabs = ids.map((id) => {
    const root: Pane = { kind: "terminal", id };
    return { root, focusedTerminalID: id };
  });
  return { tabs, focusedTabIndex: 0 };
}

function decodeLayout(
  raw: string,
  ids: readonly TerminalID[],
  sessionID: string,
  log: Logger,
): SessionLayout {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }

  let layout: SessionLayout;
  if (isLayoutShape(parsed)) {
    layout = parsed;
  } else {
    log.warning("layout unreadable, rebuilt", { sessionID });
    layout = rebuiltLayout(ids);
  }

  // Logged before the repair, because after it there is nothing left to see. The
  // strings are `layoutViolations`' own, which carry ids, counts and fractions —
  // shapes, not content.
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
    row.worktreeIncludedPaths === null ? undefined : jsonStringArray(row.worktreeIncludedPaths);
  if (includedPaths === undefined) {
    reasons.push("worktreeIncludedPaths is not a JSON array of strings");
  }

  if (ownership === undefined || includedPaths === undefined) return undefined;

  return {
    kind: "worktree",
    binding: {
      ...(row.worktreeBranch === null ? {} : { branch: row.worktreeBranch }),
      ...(row.worktreeBaseCommit === null ? {} : { baseCommit: row.worktreeBaseCommit }),
      // No column: the worktree's path *is* the session's directory.
      path: directory,
      ownership,
      includedPaths,
    },
  };
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
    ...(projectID === undefined ? {} : { projectID }),
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

  // The backing/project pairing is checked on the assembled value rather than on
  // the columns, because it is a rule about the domain and `@janela/core` owns it.
  const violations = backingViolations(session);
  if (violations.length > 0) throw new CorruptRecord("Session", row.id, violations);

  return session;
}
