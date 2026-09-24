import {
  isIntegrationID,
  type AbsolutePath,
  type GridSize,
  type Project,
  type Session,
  type TerminalID,
  type TerminalState,
} from "@janela/core";
import type { IntegrationService } from "@janela/integrations";
import {
  FrameError,
  frameErrorLabel,
  serializeBranchOverview,
  serializeDirectoryListing,
  serializeForgeOverview,
  serializeIntegrationOverview,
  serializeRemovalPlan,
  type ClientMessage,
  type DaemonMessage,
  type RequestID,
  type StateUpdate,
  type SubscriptionScope,
  type UserFacingFailure,
} from "@janela/protocol";
import type {
  DirectoryBrowsing,
  ForgeOverviewing,
  NewTerminalOptions,
  ProjectService,
  SessionService,
} from "@janela/session";
import { UnknownSession, UnknownTerminal } from "@janela/session";
import { UnexpectedFailure, isUserFacing, type Logger } from "@janela/support";
import type { LiveTerminal, TerminalRegistry } from "@janela/terminal";
import { Effect, Match, Option, Result, Schema } from "effect";

import type { PeerCredential } from "./endpoint.ts";

export interface ClientConnection {
  readonly id: string;
  readonly credential: PeerCredential;
  readonly clientName: string;
  readonly attached: ReadonlySet<TerminalID>;
  readonly rendering: ReadonlySet<TerminalID>;
  readonly inFlight: Set<RequestID>;
  subscribe(scope: SubscriptionScope): void;
  attach(terminal: LiveTerminal, viewport: GridSize | undefined): GridSize | undefined;
  detach(terminalID: TerminalID): GridSize | undefined;
  send(message: DaemonMessage): void;
}

export interface RequestDispatching {
  request(connection: ClientConnection, message: ClientMessage): Promise<void>;
  input(connection: ClientConnection, terminal: LiveTerminal, bytes: Uint8Array): void;
}

export interface RequestDispatchOptions {
  readonly sessions: SessionService;
  readonly projects: ProjectService;
  readonly directories: DirectoryBrowsing;
  readonly terminals: TerminalRegistry;
  readonly integrations: IntegrationService;
  readonly forge: ForgeOverviewing;
  readonly log: Logger;
  readonly settled: (terminal: LiveTerminal) => void;
}

export interface StateWorld {
  readonly projects: readonly Project[];
  readonly sessions: readonly Session[];
  readonly terminals: TerminalRegistry;
}

type NewTerminalDraft = {
  -readonly [Field in keyof NewTerminalOptions]: NewTerminalOptions[Field];
};

type AnsweredRequest = Exclude<ClientMessage, { readonly type: "hello" | "resize" }>;

const decodeNonNegativeInteger = Schema.decodeUnknownOption(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
);

const decodeGridSize = Schema.decodeUnknownOption(
  Schema.Struct({
    columns: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    rows: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }),
);

const decodeTerminalPlacement = Schema.decodeUnknownOption(
  Schema.Struct({
    kind: Schema.Literal("split"),
    beside: Schema.String.check(Schema.isGUID()),
    axis: Schema.Literals(["horizontal", "vertical"]),
  }),
);

const decodePaneDestination = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("beside"),
      terminal: Schema.String.check(Schema.isGUID()),
      edge: Schema.Literals(["left", "right", "top", "bottom"]),
    }),
    Schema.Struct({
      kind: Schema.Literal("tab"),
      index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
    Schema.Struct({ kind: Schema.Literal("newTab") }),
  ]),
);

const decodeTitle = Schema.decodeUnknownOption(Schema.String);

const decodeVerdict = Schema.decodeUnknownOption(Schema.Boolean);

const decodeDirectory = Schema.decodeUnknownOption(
  Schema.UndefinedOr(Schema.String.check(Schema.isStartsWith("/"))),
);

const acknowledged = (id: RequestID): DaemonMessage => ({ type: "acknowledged", id });

const textReply = (id: RequestID, text: string): DaemonMessage => ({ type: "text", id, text });

export function errorName(cause: unknown): string {
  if (cause instanceof FrameError) return frameErrorLabel(cause);

  return cause instanceof Error ? cause.name : "unknown";
}

export function fullStateSnapshot(world: StateWorld): StateUpdate {
  const terminalStates: Record<TerminalID, TerminalState> = {};

  for (const session of world.sessions) {
    for (const terminal of world.terminals.inSession(session.id)) {
      terminalStates[terminal.id] = terminal.state;
    }
  }

  return {
    projects: world.projects,
    sessions: world.sessions,
    terminalStates,
    isFullSnapshot: true,
  };
}

export function createRequestDispatch(options: RequestDispatchOptions): RequestDispatching {
  const { sessions, projects, directories, terminals, integrations, forge, log, settled } = options;

  const requireTerminal = (terminalID: TerminalID): LiveTerminal => {
    const terminal = terminals.get(terminalID);

    if (terminal === undefined) throw new UnknownTerminal(terminalID);

    return terminal;
  };

  const answer = (
    connection: ClientConnection,
    message: AnsweredRequest,
    id: RequestID,
  ): Promise<DaemonMessage> =>
    Match.value(message).pipe(
      Match.discriminatorsExhaustive("type")({
        subscribe: (request) => {
          const { scope } = request;

          if (scope.kind !== "state" && scope.kind !== "terminal") {
            throw new TypeError("unknown subscription scope");
          }

          connection.subscribe(scope);

          if (scope.kind === "state") {
            connection.send({
              type: "state",
              update: fullStateSnapshot({
                projects: projects.projects,
                sessions: sessions.sessions,
                terminals,
              }),
            });
          }

          return Promise.resolve(acknowledged(id));
        },

        addProject: async (request) => {
          const details: { directory: AbsolutePath; name?: string } = {
            directory: request.directory,
          };

          if (request.name !== undefined) {
            details.name = request.name;
          }

          await projects.addProject(details);

          return acknowledged(id);
        },

        removeProject: async (request) => {
          await projects.removeProject(request.projectID);

          return acknowledged(id);
        },

        updateProjectSettings: async (request) => {
          await projects.updateSettings(request.projectID, request.settings);

          return acknowledged(id);
        },

        createSession: async (request) => {
          await sessions.createSession(request.intent);

          return acknowledged(id);
        },

        removalPlan: async (request) => {
          const plan = await sessions.removalPlan(request.sessionID);

          return textReply(id, serializeRemovalPlan(plan));
        },

        projectBranches: async (request) => {
          const overview = await sessions.branchOverview(request.projectID);

          return textReply(id, serializeBranchOverview(overview));
        },

        forgeOverview: async () => textReply(id, serializeForgeOverview(await forge.overview())),

        listDirectory: async (request) => {
          const { directory } = request;

          if (Option.isNone(decodeDirectory(directory))) {
            throw new TypeError("listDirectory with a directory that is not absolute");
          }

          const listing = await directories.list(directory);

          return textReply(id, serializeDirectoryListing(listing));
        },

        moveTab: async (request) => {
          const { from, to } = request;

          if (
            Option.isNone(decodeNonNegativeInteger(from)) ||
            Option.isNone(decodeNonNegativeInteger(to))
          ) {
            throw new TypeError("moveTab with an impossible tab index");
          }

          await sessions.moveTab(request.sessionID, from, to);

          return acknowledged(id);
        },

        moveTerminal: async (request) => {
          if (Option.isNone(decodePaneDestination(request.destination))) {
            throw new TypeError("moveTerminal with an impossible destination");
          }

          await sessions.moveTerminal(request.sessionID, request.terminalID, request.destination);

          return acknowledged(id);
        },

        removeSession: async (request) => {
          const plan = await sessions.removalPlan(request.sessionID);
          plan.deletesDirectory = request.deletesDirectory === true;
          await sessions.removeSession(request.sessionID, plan);

          return acknowledged(id);
        },

        renameSession: async (request) => {
          const name = Option.getOrUndefined(decodeTitle(request.name));

          if (name === undefined) throw new TypeError("rename without a name");

          await sessions.rename(request.sessionID, name);

          return acknowledged(id);
        },

        markSession: (request) => {
          const unread = Option.getOrUndefined(decodeVerdict(request.unread));

          if (unread === undefined) throw new TypeError("markSession without a verdict");

          if (sessions.find(request.sessionID) === undefined) {
            throw new UnknownSession(request.sessionID);
          }

          for (const terminal of terminals.inSession(request.sessionID)) {
            terminal.markAttention(unread);
            settled(terminal);
          }

          return Promise.resolve(acknowledged(id));
        },

        attach: (request) => {
          const terminal = requireTerminal(request.terminalID);
          const { viewport } = request;

          if (viewport !== undefined && Option.isNone(decodeGridSize(viewport))) {
            throw new TypeError("attach with an impossible viewport");
          }

          connection.attach(terminal, viewport);

          return Promise.resolve(acknowledged(id));
        },

        detach: (request) => {
          connection.detach(request.terminalID);

          return Promise.resolve(acknowledged(id));
        },

        startTerminal: async (request) => {
          await sessions.startTerminal(request.terminalID);

          return acknowledged(id);
        },

        stopTerminal: async (request) => {
          await sessions.stopTerminal(request.terminalID);

          return acknowledged(id);
        },

        restartTerminal: async (request) => {
          await sessions.restartTerminal(request.terminalID);

          return acknowledged(id);
        },

        createTerminal: async (request) => {
          const descriptor = await sessions.createTerminal(
            request.sessionID,
            newTerminalOptions(request),
          );

          return textReply(id, descriptor.id);
        },

        removeTerminal: async (request) => {
          await sessions.removeTerminal(request.terminalID);

          return acknowledged(id);
        },

        snapshotText: (request) => {
          const terminal = requireTerminal(request.terminalID);

          return Promise.resolve(
            textReply(
              id,
              terminal.snapshotText({ includeScrollback: request.includeScrollback === true }),
            ),
          );
        },

        integrations: async () =>
          textReply(id, serializeIntegrationOverview(await integrations.overview())),

        installIntegration: async (request) => {
          if (!isIntegrationID(request.integrationID)) {
            throw new TypeError("installIntegration with an unknown integration");
          }

          await integrations.install(request.integrationID);

          return acknowledged(id);
        },

        removeIntegration: async (request) => {
          if (!isIntegrationID(request.integrationID)) {
            throw new TypeError("removeIntegration with an unknown integration");
          }

          await integrations.remove(request.integrationID);

          return acknowledged(id);
        },
      }),
    );

  const resize = (connection: ClientConnection, terminalID: TerminalID, size: GridSize): void => {
    if (!connection.rendering.has(terminalID) || Option.isNone(decodeGridSize(size))) {
      log.debug("resize ignored", { client: connection.id, terminalID });

      return;
    }

    terminals.get(terminalID)?.attach(connection.id, size);
  };

  return {
    async request(connection: ClientConnection, message: ClientMessage): Promise<void> {
      if (message.type === "hello") {
        log.warning("unexpected hello", { client: connection.id });

        return;
      }

      if (message.type === "resize") {
        resize(connection, message.terminalID, message.size);

        return;
      }

      const { id } = message;

      if (Option.isNone(decodeNonNegativeInteger(id))) {
        log.warning("request malformed", { client: connection.id, type: message.type });

        return;
      }

      if (connection.inFlight.has(id)) {
        log.warning("duplicate request id", { client: connection.id, type: message.type });

        return;
      }

      connection.inFlight.add(id);

      await Effect.runPromise(
        Effect.tryPromise({
          try: () => answer(connection, message, id),
          catch: (cause) => cause,
        }).pipe(
          Effect.match({
            onSuccess: (reply: DaemonMessage) => {
              connection.send(reply);
            },
            onFailure: (cause) => {
              log.warning("request failed", {
                client: connection.id,
                type: message.type,
                error: errorName(cause),
              });

              connection.send({ type: "failed", id, failure: wireFailure(cause) });
            },
          }),
          Effect.ensuring(
            Effect.sync(() => {
              connection.inFlight.delete(id);
            }),
          ),
        ),
      );
    },

    input(connection: ClientConnection, terminal: LiveTerminal, bytes: Uint8Array): void {
      if (!connection.attached.has(terminal.id)) {
        log.debug("input from a connection not attached", {
          client: connection.id,
          terminalID: terminal.id,
        });

        return;
      }

      const sent = Result.try({ try: () => terminal.send(bytes), catch: errorName });

      if (Result.isFailure(sent)) {
        log.warning("input failed", {
          client: connection.id,
          error: sent.failure,
        });
      }
    },
  };
}

function newTerminalOptions(
  request: Extract<ClientMessage, { readonly type: "createTerminal" }>,
): NewTerminalOptions {
  const { placement } = request;
  const draft: NewTerminalDraft = {};

  const title = Option.getOrUndefined(decodeTitle(request.title));

  if (title !== undefined) draft.title = title;

  if (placement !== undefined) {
    if (Option.isNone(decodeTerminalPlacement(placement))) {
      throw new TypeError("createTerminal with an impossible placement");
    }

    draft.placement = placement;
  }

  return draft;
}

function wireFailure(cause: unknown): UserFacingFailure {
  const shown = isUserFacing(cause)
    ? cause
    : new UnexpectedFailure("Couldn't complete the request.", cause);

  const failure: { -readonly [Key in keyof UserFacingFailure]: UserFacingFailure[Key] } = {
    summary: shown.summary,
  };

  if (shown.reason !== undefined) {
    failure.reason = shown.reason;
  }

  if (shown.recoverySuggestion !== undefined) {
    failure.recoverySuggestion = shown.recoverySuggestion;
  }

  return failure;
}
