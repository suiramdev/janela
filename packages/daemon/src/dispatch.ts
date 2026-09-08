import type {
  GridSize,
  LaunchProfile,
  Project,
  Session,
  TerminalID,
  TerminalState,
} from "@janela/core";
import {
  FrameError,
  serializeRemovalPlan,
  type ClientMessage,
  type DaemonMessage,
  type RequestID,
  type StateUpdate,
  type SubscriptionScope,
  type UserFacingFailure,
} from "@janela/protocol";
import type { LaunchProfileService, ProjectService, SessionService } from "@janela/session";
import { UnknownTerminal } from "@janela/session";
import { UnexpectedFailure, isUserFacing, type Logger } from "@janela/support";
import type { LiveTerminal, TerminalRegistry } from "@janela/terminal";

import type { PeerCredential } from "./endpoint.ts";

/**
 * One accepted peer after its handshake. What a request dispatcher sees.
 *
 * Every method is non-blocking: a dispatcher handling a request may not be made
 * to wait on another client's socket, and `send` in particular queues rather than
 * writes.
 */
export interface ClientConnection {
  /** The `client` string given to `LiveTerminal.attach`/`detach` and the frame loop. */
  readonly id: string;
  readonly credential: PeerCredential;
  /** From the peer's Hello. For logs and UI, never authorisation. */
  readonly clientName: string;
  readonly attached: ReadonlySet<TerminalID>;
  /**
   * The attachments that carry a viewport: the only ones that receive repaints,
   * and the only ones whose `resize` means anything. A viewportless attachment is
   * in `attached` and not in here.
   */
  readonly rendering: ReadonlySet<TerminalID>;
  /**
   * Request ids this connection has not been answered for yet.
   *
   * Held per connection so one client's in-flight work can never collide with
   * another's — the ids are the peer's own numbering and two peers routinely pick
   * the same ones.
   */
  readonly inFlight: Set<RequestID>;
  subscribe(scope: SubscriptionScope): void;
  /**
   * Registers the viewport with the terminal and the frame loop.
   *
   * The loop sends `fullRepaintFor` on its next frame, before any delta, so an
   * `attach` handler does not send one itself.
   *
   * With no viewport the attachment is input and scope only: the terminal never
   * learns about the client, the frame loop never gets a registration, and the
   * negotiated size is whatever the rendering clients agreed (ADR 0016).
   */
  attach(terminal: LiveTerminal, viewport?: GridSize): GridSize | undefined;
  detach(terminalID: TerminalID): GridSize | undefined;
  /** Queues a control message. Never waits; a peer that is not reading is disconnected. */
  send(message: DaemonMessage): void;
}

/**
 * What a message *means*, which is deliberately not the server's business.
 *
 * The seam exists so the accept loop can be tested and reasoned about without the
 * request handlers, and so the handlers cannot quietly acquire a socket.
 */
export interface RequestDispatching {
  /**
   * Handles one request. `message.type` is never `"hello"`.
   *
   * Not awaited by the read loop, so a slow `createSession` never delays the next
   * keystroke — which also means it must *answer* with `acknowledged` / `failed` /
   * `text` rather than throw. A rejection is logged and the connection survives.
   */
  request(connection: ClientConnection, message: ClientMessage): Promise<void>;
  /**
   * Terminal input. The terminal exists; whether this connection is attached to
   * it is the dispatcher's check.
   *
   * `bytes` is a view into the decoder's buffer and is valid only during the
   * call. Copy it or write it through, never keep it.
   */
  input(connection: ClientConnection, terminal: LiveTerminal, bytes: Uint8Array): void;
}

export interface RequestDispatchOptions {
  readonly sessions: SessionService;
  readonly projects: ProjectService;
  readonly launchProfiles: LaunchProfileService;
  readonly terminals: TerminalRegistry;
  readonly log: Logger;
  /**
   * Publishes the world after a change nothing else announces.
   *
   * Sessions and projects reach subscribers through `StateObserving`, which their
   * services already call. Launch profiles have no observer because the wire is
   * their only writer — this is that path, and it is here rather than in
   * `@janela/session` so the brain keeps knowing nothing about subscribers.
   */
  readonly announce: () => Promise<void>;
}

/** The name of an error, for a log field. Never its message: that is peer-influenced. */
export function errorName(error: unknown): string {
  if (error instanceof FrameError) return error.detail.kind;
  return error instanceof Error ? error.name : "unknown";
}

/**
 * The whole world as one `StateUpdate`: both lists, the launch profiles with
 * their availability, and every registered terminal's state.
 *
 * Composed per announcement rather than per frame, so its cost is human-rate. It
 * exists because a client merges by id and therefore cannot express a removal:
 * the only way to say "that session is gone" is to send a complete list without
 * it (docs/decisions/0015-daemon-owned-sessions.md).
 */
export function fullStateSnapshot(world: {
  readonly projects: readonly Project[];
  readonly sessions: readonly Session[];
  readonly launchProfiles: LaunchProfileService;
  readonly terminals: TerminalRegistry;
}): StateUpdate {
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

/**
 * Turns a `ClientMessage` into calls on the services, and answers it.
 *
 * The rules that are not obvious from the switch:
 *
 * - **Every request is answered, and none of them throws.** The read loop does not
 *   await this, so a rejection would be an unhandled failure with a client waiting
 *   on a promise that will never settle.
 * - **A failure crosses the wire as `UserFacingFailure` and nothing else.** Raw
 *   stderr belongs in the log, and not even there: only the error's *name* is
 *   logged (non-negotiables 10 and 11).
 * - **Nothing here starts a process except `startTerminal`.** Attaching a viewport
 *   to an idle terminal shows an idle terminal.
 */
export function createRequestDispatch(options: RequestDispatchOptions): RequestDispatching {
  const { sessions, projects, launchProfiles, terminals, log, announce } = options;

  /** The terminal a request names, or a failure a person can read. */
  const requireTerminal = (terminalID: TerminalID): LiveTerminal => {
    const terminal = terminals.get(terminalID);
    if (terminal === undefined) throw new UnknownTerminal(terminalID);
    return terminal;
  };

  /** Runs one request and produces its reply. Throwing here becomes `failed`. */
  const answer = async (
    connection: ClientConnection,
    message: Exclude<ClientMessage, { readonly type: "hello" | "resize" }>,
    id: RequestID,
  ): Promise<DaemonMessage> => {
    switch (message.type) {
      case "subscribe": {
        const { scope } = message;
        if (scope.kind !== "state" && scope.kind !== "terminal") {
          throw new TypeError("unknown subscription scope");
        }
        connection.subscribe(scope);
        if (scope.kind === "state") {
          // Before the acknowledgement, on the same ordered queue: the mirror is
          // populated by the time the client's `request()` settles.
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
        return { type: "acknowledged", id };
      }

      case "addProject":
        await projects.addProject({
          directory: message.directory,
          ...(message.name !== undefined && { name: message.name }),
        });
        return { type: "acknowledged", id };

      case "removeProject":
        await projects.removeProject(message.projectID);
        return { type: "acknowledged", id };

      case "updateProjectSettings":
        await projects.updateSettings(message.projectID, message.settings);
        return { type: "acknowledged", id };

      case "createSession":
        // `SessionCreationIntent` mirrors `SessionCreationRequest` field for
        // field, deliberately: the wire shape is frozen by the protocol version
        // and the internal one is free to grow a field with a default.
        await sessions.createSession(message.intent);
        return { type: "acknowledged", id };

      case "removalPlan": {
        const plan = await sessions.removalPlan(message.sessionID);
        return { type: "text", id, text: serializeRemovalPlan(plan) };
      }

      case "removeSession": {
        // Recomputed here rather than taken from the client: a plan the peer held
        // may describe a session that has since gained a terminal or lost its
        // worktree. Only the answer to "also delete the directory" is theirs.
        const plan = await sessions.removalPlan(message.sessionID);
        plan.deletesDirectory = message.deletesDirectory === true;
        await sessions.removeSession(message.sessionID, plan);
        return { type: "acknowledged", id };
      }

      case "renameSession": {
        const { name } = message;
        if (typeof name !== "string") throw new TypeError("rename without a name");
        await sessions.rename(message.sessionID, name);
        return { type: "acknowledged", id };
      }

      case "attach": {
        const terminal = requireTerminal(message.terminalID);
        const { viewport } = message;
        if (viewport !== undefined && !isGridSize(viewport)) {
          throw new TypeError("attach with an impossible viewport");
        }
        // Never `start()`: attaching to an idle terminal is how a session opens
        // without spawning anything (non-negotiable #5). The frame loop owes the
        // full repaint, so nothing is sent here either.
        connection.attach(terminal, viewport);
        return { type: "acknowledged", id };
      }

      case "detach":
        // Idempotent: detaching from something never attached is a no-op, because
        // a client recovering from a reconnect should not have to remember.
        connection.detach(message.terminalID);
        return { type: "acknowledged", id };

      case "startTerminal":
        // The only path in the daemon that spawns a process on request.
        await sessions.startTerminal(message.terminalID);
        return { type: "acknowledged", id };

      case "stopTerminal":
        await sessions.stopTerminal(message.terminalID);
        return { type: "acknowledged", id };

      case "saveLaunchProfile": {
        const { profile } = message;
        if (!isLaunchProfile(profile)) throw new TypeError("save with an unusable profile");
        await launchProfiles.save(profile);
        // Profiles have no `StateObserving` path of their own: this is how the
        // save reaches every subscriber, including the client that asked.
        await announce();
        return { type: "acknowledged", id };
      }

      case "removeLaunchProfile":
        await launchProfiles.remove(message.profileID);
        await announce();
        return { type: "acknowledged", id };

      case "createTerminal": {
        const descriptor = await sessions.createTerminal(message.sessionID, {
          ...(message.profileID === undefined ? {} : { profileID: message.profileID }),
          ...(typeof message.title === "string" ? { title: message.title } : {}),
        });
        // Configured, not started: `startTerminal` is still the only spawn. The
        // id comes back because the client needs it to attach.
        return { type: "text", id, text: descriptor.id };
      }

      case "snapshotText": {
        const terminal = requireTerminal(message.terminalID);
        // No attachment required: reading what is on screen is the CLI's whole
        // job, and it never renders (ADR 0016).
        return {
          type: "text",
          id,
          text: terminal.snapshotText({ includeScrollback: message.includeScrollback === true }),
        };
      }
    }
  };

  /**
   * A resize is an attach with a new viewport.
   *
   * `LiveTerminal.attach` upserts and re-runs the size negotiation, so there is no
   * separate resize path to keep in step (#21). A connection that attached without
   * a viewport chose not to participate and is ignored rather than promoted:
   * participation is decided at attach time.
   */
  const resize = (connection: ClientConnection, terminalID: TerminalID, size: GridSize): void => {
    if (!connection.rendering.has(terminalID) || !isGridSize(size)) {
      log.debug("resize ignored", { client: connection.id, terminalID });
      return;
    }
    terminals.get(terminalID)?.attach(connection.id, size);
  };

  return {
    async request(connection: ClientConnection, message: ClientMessage): Promise<void> {
      if (message.type === "hello") {
        // The read loop refuses a second hello before we ever see it.
        log.warning("unexpected hello", { client: connection.id });
        return;
      }
      if (message.type === "resize") {
        resize(connection, message.terminalID, message.size);
        return;
      }

      const { id } = message;
      if (typeof id !== "number" || !Number.isInteger(id) || id < 0) {
        // No reply: a `failed` carrying a fabricated id would reject some *other*
        // request on a client that correlates by number.
        log.warning("request malformed", { client: connection.id, type: message.type });
        return;
      }
      if (connection.inFlight.has(id)) {
        // Answering would mis-correlate: the peer already has one request waiting
        // on this number.
        log.warning("duplicate request id", { client: connection.id, type: message.type });
        return;
      }

      connection.inFlight.add(id);
      try {
        connection.send(await answer(connection, message, id));
      } catch (error) {
        log.warning("request failed", {
          client: connection.id,
          type: message.type,
          error: errorName(error),
        });
        connection.send({ type: "failed", id, failure: wireFailure(error) });
      } finally {
        connection.inFlight.delete(id);
      }
    },

    input(connection: ClientConnection, terminal: LiveTerminal, bytes: Uint8Array): void {
      if (!connection.attached.has(terminal.id)) {
        // A race, not an attack: input in flight when a detach crossed it. The
        // connection keeps its terminals.
        log.debug("input from a connection not attached", {
          client: connection.id,
          terminalID: terminal.id,
        });
        return;
      }
      // Written through rather than copied: `send` reaches `jpty_write`
      // synchronously, so the decoder's view outlives the call it is valid for.
      terminal.send(bytes);
    },
  };
}

/**
 * A viewport a terminal can be sized to.
 *
 * Takes `unknown` because the wire carries whatever it likes: the decoder checks
 * the discriminant and stops, so `viewport` is typed and not validated.
 */
function isGridSize(size: unknown): size is GridSize {
  if (typeof size !== "object" || size === null) return false;
  const { columns, rows } = size as { readonly columns?: unknown; readonly rows?: unknown };
  return (
    typeof columns === "number" &&
    typeof rows === "number" &&
    Number.isInteger(columns) &&
    Number.isInteger(rows) &&
    columns >= 1 &&
    rows >= 1
  );
}

/**
 * A profile a client may save. Same reason as `isGridSize`: the decoder checked
 * the discriminant and nothing else, and this reaches the database.
 *
 * `name` and `iconName` are not policed beyond being strings — an empty name is a
 * bad profile, not a malformed one, and the settings surface is where a person is
 * told so. `isBuiltIn` is not read at all: the service decides it.
 */
function isLaunchProfile(value: unknown): value is LaunchProfile {
  if (typeof value !== "object" || value === null) return false;
  const profile = value as {
    readonly id?: unknown;
    readonly name?: unknown;
    readonly iconName?: unknown;
    readonly command?: unknown;
    readonly environment?: unknown;
    readonly isAgent?: unknown;
  };
  return (
    typeof profile.id === "string" &&
    profile.id.length > 0 &&
    typeof profile.name === "string" &&
    typeof profile.iconName === "string" &&
    Array.isArray(profile.command) &&
    // argv, and every element of it: a number in here reaches `execve` as a
    // stringified surprise, and `["zsh", null]` is not an argument list.
    profile.command.every((argument) => typeof argument === "string") &&
    isStringRecord(profile.environment) &&
    typeof profile.isAgent === "boolean"
  );
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

/**
 * An error, reduced to what a person may see.
 *
 * Anything that is not already user-facing becomes one sentence with no detail:
 * the underlying error may carry a path, a command line or a page of stderr, and
 * a dialog is the wrong place for all three.
 */
function wireFailure(error: unknown): UserFacingFailure {
  const shown = isUserFacing(error)
    ? error
    : new UnexpectedFailure("Couldn't complete the request.", error);
  return {
    summary: shown.summary,
    ...(shown.reason !== undefined && { reason: shown.reason }),
    ...(shown.recoverySuggestion !== undefined && {
      recoverySuggestion: shown.recoverySuggestion,
    }),
  };
}
