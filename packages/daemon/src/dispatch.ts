import type { GridSize, Project, Session, TerminalID, TerminalState } from "@janela/core";
import {
  FrameError,
  frameErrorLabel,
  serializeBranchOverview,
  serializeDirectoryListing,
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
  LaunchProfileService,
  NewTerminalOptions,
  ProjectService,
  SessionService,
} from "@janela/session";
import { UnknownTerminal } from "@janela/session";
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
  attach(terminal: LiveTerminal, viewport?: GridSize): GridSize | undefined;
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
  readonly launchProfiles: LaunchProfileService;
  readonly directories: DirectoryBrowsing;
  readonly terminals: TerminalRegistry;
  readonly log: Logger;
  readonly announce: () => Promise<void>;
}

export interface StateWorld {
  readonly projects: readonly Project[];
  readonly sessions: readonly Session[];
  readonly launchProfiles: LaunchProfileService;
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

const decodeLaunchProfile = Schema.decodeUnknownOption(
  Schema.Struct({
    id: Schema.String.check(Schema.isNonEmpty()),
    name: Schema.String,
    iconName: Schema.String,
    command: Schema.Array(Schema.String),
    environment: Schema.Record(Schema.String, Schema.String),
    isAgent: Schema.Boolean,
  }),
);

const decodeTitle = Schema.decodeUnknownOption(Schema.String);

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
    launchProfiles: world.launchProfiles.profiles,
    launchProfileAvailability: world.launchProfiles.availability,
    isFullSnapshot: true,
  };
}

export function createRequestDispatch(options: RequestDispatchOptions): RequestDispatching {
  const { sessions, projects, launchProfiles, directories, terminals, log, announce } = options;

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
                launchProfiles,
                terminals,
              }),
            });
          }

          return Promise.resolve(acknowledged(id));
        },

        addProject: async (request) => {
          await projects.addProject({
            directory: request.directory,
            ...(request.name !== undefined && { name: request.name }),
          });

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

        saveLaunchProfile: async (request) => {
          const { profile } = request;

          if (Option.isNone(decodeLaunchProfile(profile))) {
            throw new TypeError("save with an unusable profile");
          }

          await launchProfiles.save(profile);
          await announce();

          return acknowledged(id);
        },

        removeLaunchProfile: async (request) => {
          await launchProfiles.remove(request.profileID);
          await announce();

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
  const { placement, profileID } = request;
  const draft: NewTerminalDraft = {};

  if (profileID !== undefined) draft.profileID = profileID;

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

  return {
    summary: shown.summary,
    ...(shown.reason !== undefined && { reason: shown.reason }),
    ...(shown.recoverySuggestion !== undefined && {
      recoverySuggestion: shown.recoverySuggestion,
    }),
  };
}
