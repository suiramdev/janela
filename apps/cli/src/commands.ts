import type { ClientRequest, DaemonConnection, Stores } from "@janela/client";
import {
  absolutePath,
  type AbsolutePath,
  type Project,
  type ProjectID,
  type Session,
  type SessionID,
} from "@janela/core";
import { parseRemovalPlan, type SessionCreationIntent } from "@janela/protocol";
import { UserFacingError } from "@janela/support";
import { Match } from "effect";

import type { Command, CreationTarget } from "./arguments.ts";
import {
  listingJSON,
  listingLines,
  projectLine,
  removalLines,
  sessionLines,
  type Mirrored,
} from "./listing.ts";
import { findProject, findSession, findTerminal } from "./lookup.ts";

export interface Output {
  line(text: string): void;
  write(text: string): void;
}

export interface CommandContext {
  readonly connection: Pick<DaemonConnection, "request">;
  readonly stores: Stores;
  readonly output: Output;
  readonly confirm: ((question: string) => Promise<boolean>) | undefined;
  readonly settleTimeoutMs?: number;
}

export const SETTLE_TIMEOUT_MS = 2_000;

export class NotYetVisible extends UserFacingError {
  override readonly summary: string;

  constructor(noun: "project" | "session") {
    super(`created ${noun} not yet visible`, {
      reason: `The daemon accepted the request, but the new ${noun} did not appear in its state in time.`,
      recoverySuggestion: "`janela list` shows it once it is there.",
    });

    this.summary = `The ${noun} was created, but Janela could not tell which one it is.`;
  }
}

export class RemovalNotConfirmed extends UserFacingError {
  override readonly summary = "Nothing was removed.";

  constructor() {
    super("removal not confirmed", {
      recoverySuggestion: "Run it again with --yes to remove the session at the cost shown above.",
    });
  }
}

export class DirectoryNotOurs extends UserFacingError {
  override readonly summary: string;

  constructor(directory: string) {
    super("directory not deletable", {
      reason: "Janela deletes only a worktree it created for the session.",
      recoverySuggestion: "Remove the session without --delete-directory; the directory stays.",
    });

    this.summary = `Janela will not delete ${directory}.`;
  }
}

export class TerminalNotStarted extends UserFacingError {
  override readonly summary: string;

  constructor(terminalID: string) {
    super("terminal not started", {
      reason: "A terminal that has not been started has no screen to read.",
      recoverySuggestion: `\`janela terminal start ${terminalID}\` starts it.`,
    });

    this.summary = `Terminal ${terminalID} has not been started.`;
  }
}

function mirrored(stores: Stores): Mirrored {
  return {
    projects: stores.projects.projects,
    sessions: stores.sessions.sessions,
    terminalStates: stores.sessions.terminalStates,
  };
}

function intentFor(
  target: CreationTarget,
  name: string | undefined,
  projects: readonly Project[],
): SessionCreationIntent {
  return Match.value(target).pipe(
    Match.discriminatorsExhaustive("kind")({
      directory: ({ directory }): SessionCreationIntent => {
        const intent: { kind: "standalone"; directory: AbsolutePath; name?: string } = {
          kind: "standalone",
          directory: absolutePath(directory),
        };

        if (name !== undefined) intent.name = name;

        return intent;
      },
      project: ({ project, branch }): SessionCreationIntent => {
        const intent: { kind: "inProject"; projectID: ProjectID; branch?: string; name?: string } =
          { kind: "inProject", projectID: findProject(projects, project).id };

        if (branch !== undefined) intent.branch = branch;

        if (name !== undefined) intent.name = name;

        return intent;
      },
      newBranch: ({ project, branch, startPoint }): SessionCreationIntent => {
        const intent: {
          kind: "newWorktree";
          projectID: ProjectID;
          branch: string;
          startPoint?: string;
          name?: string;
        } = { kind: "newWorktree", projectID: findProject(projects, project).id, branch };

        if (startPoint !== undefined) intent.startPoint = startPoint;

        if (name !== undefined) intent.name = name;

        return intent;
      },
    }),
  );
}

async function appearing<Item>(
  stores: Stores,
  probe: () => Item | undefined,
  timeoutMs: number,
): Promise<Item | undefined> {
  const already = probe();

  if (already !== undefined) return already;

  const { promise, resolve } = Promise.withResolvers<Item | undefined>();
  const timer = setTimeout(() => resolve(undefined), timeoutMs);
  const unsubscribe = stores.sessions.subscribe(() => {
    const found = probe();

    if (found !== undefined) resolve(found);
  });

  const found = await promise;
  clearTimeout(timer);
  unsubscribe();

  return found;
}

async function created<Item extends { readonly id: string }>(
  context: CommandContext,
  current: () => readonly Item[],
  request: ClientRequest,
): Promise<Item | undefined> {
  const before = new Set(current().map((item) => item.id));
  await context.connection.request(request);

  return appearing(
    context.stores,
    () => current().find((item) => !before.has(item.id)),
    context.settleTimeoutMs ?? SETTLE_TIMEOUT_MS,
  );
}

async function removeSession(
  context: CommandContext,
  session: Session,
  yes: boolean,
  deleteDirectory: boolean,
): Promise<void> {
  const reply = await context.connection.request({ type: "removalPlan", sessionID: session.id });

  if (reply === undefined) throw new TypeError("removalPlan answered without a plan");

  const plan = parseRemovalPlan(reply);

  if (deleteDirectory && !plan.canDeleteDirectory) throw new DirectoryNotOurs(session.directory);

  const deletesDirectory = plan.deletesDirectory || deleteDirectory;

  for (const line of removalLines(session, plan, deletesDirectory)) context.output.line(line);

  const agreed =
    yes || (context.confirm !== undefined && (await context.confirm("Remove? [y/N] ")));

  if (!agreed) throw new RemovalNotConfirmed();

  await context.connection.request({
    type: "removeSession",
    sessionID: session.id,
    deletesDirectory,
  });

  context.output.line(`removed\t${session.id}`);
}

export async function runCommand(command: Command, context: CommandContext): Promise<void> {
  const { connection, stores, output } = context;

  return Match.value(command).pipe(
    Match.discriminatorsExhaustive("kind")({
      list: async ({ json }) => {
        if (json) output.line(listingJSON(mirrored(stores)));
        else for (const line of listingLines(mirrored(stores))) output.line(line);
      },

      addProject: async ({ directory, name }) => {
        const request: { type: "addProject"; directory: AbsolutePath; name?: string } = {
          type: "addProject",
          directory: absolutePath(directory),
        };

        if (name !== undefined) request.name = name;

        const project = await created(context, () => stores.projects.projects, request);

        if (project === undefined) throw new NotYetVisible("project");

        output.line(projectLine(project));
      },

      createSession: async ({ target, name }) => {
        const intent = intentFor(target, name, stores.projects.projects);
        const session = await created(context, () => stores.sessions.sessions, {
          type: "createSession",
          intent,
        });

        if (session === undefined) throw new NotYetVisible("session");

        const settled = await appearing(
          stores,
          () =>
            stores.sessions.sessions.find(
              (candidate) => candidate.id === session.id && candidate.terminals.length > 0,
            ),
          context.settleTimeoutMs ?? SETTLE_TIMEOUT_MS,
        );

        for (const line of sessionLines(settled ?? session, stores.sessions.terminalStates)) {
          output.line(line);
        }
      },

      removeSession: async ({ session, yes, deleteDirectory }) =>
        removeSession(
          context,
          findSession(stores.sessions.sessions, session),
          yes,
          deleteDirectory,
        ),

      createTerminal: async ({ session, title }) => {
        const request: { type: "createTerminal"; sessionID: SessionID; title?: string } = {
          type: "createTerminal",
          sessionID: findSession(stores.sessions.sessions, session).id,
        };

        if (title !== undefined) request.title = title;

        const terminalID = await connection.request(request);

        if (terminalID === undefined) throw new TypeError("createTerminal answered without an id");

        output.line(terminalID);
      },

      startTerminal: async ({ terminal }) => {
        const { terminal: descriptor } = findTerminal(stores.sessions.sessions, terminal);
        await connection.request({ type: "startTerminal", terminalID: descriptor.id });
        output.line(`started\t${descriptor.id}`);
      },

      readTerminal: async ({ terminal, scrollback }) => {
        const { terminal: descriptor } = findTerminal(stores.sessions.sessions, terminal);
        const state = stores.sessions.terminalStates[descriptor.id];

        if (state === undefined || state.kind === "idle") {
          throw new TerminalNotStarted(descriptor.id);
        }

        const text = await connection.request({
          type: "snapshotText",
          terminalID: descriptor.id,
          includeScrollback: scrollback,
        });

        output.write(text === undefined || text.endsWith("\n") ? (text ?? "") : `${text}\n`);
      },
    }),
  );
}
