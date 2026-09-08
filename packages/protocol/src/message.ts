import type {
  AbsolutePath,
  GridSize,
  Instant,
  Project,
  ProjectID,
  ProjectSettings,
  Session,
  SessionID,
  TerminalID,
  TerminalState,
} from "@janela/core";

import type { HandshakeRefusal, Hello } from "./handshake.ts";

/** Correlates a request with its reply. */
export type RequestID = number & { readonly __brand: "RequestID" };

export function nextRequestID(): RequestID {
  throw new Error(`not implemented: nextRequestID`);
}

/**
 * What a client can say.
 *
 * Note what is *not* here: nothing lets a client read or write the database, and
 * nothing lets it start a process directly. Every capability is expressed as an
 * intent the daemon validates. If the CLI cannot do it through this union, neither
 * can the app — see docs/decisions/0015-daemon-owned-sessions.md § Rules.
 */
export type ClientMessage =
  /** Always first. Anything else before it is a protocol violation. */
  | { readonly type: "hello"; readonly hello: Hello }
  /**
   * Ask to be told about changes. Scoped, so a CLI listing sessions does not
   * subscribe to terminal output it will never render.
   */
  | { readonly type: "subscribe"; readonly id: RequestID; readonly scope: SubscriptionScope }

  // ---- Projects and sessions
  | {
      readonly type: "addProject";
      readonly id: RequestID;
      readonly directory: AbsolutePath;
      readonly name?: string;
    }
  | { readonly type: "removeProject"; readonly id: RequestID; readonly projectID: ProjectID }
  | {
      readonly type: "updateProjectSettings";
      readonly id: RequestID;
      readonly projectID: ProjectID;
      readonly settings: ProjectSettings;
    }
  | {
      readonly type: "createSession";
      readonly id: RequestID;
      readonly intent: SessionCreationIntent;
    }
  | {
      readonly type: "removeSession";
      readonly id: RequestID;
      readonly sessionID: SessionID;
      readonly deletesDirectory: boolean;
    }
  | {
      readonly type: "renameSession";
      readonly id: RequestID;
      readonly sessionID: SessionID;
      readonly name: string;
    }
  /**
   * What removing this session would do, so a client can describe it before
   * asking. The reply is `text` carrying `serializeRemovalPlan` JSON — parse it
   * with `parseRemovalPlan`.
   */
  | { readonly type: "removalPlan"; readonly id: RequestID; readonly sessionID: SessionID }

  // ---- Terminals
  /**
   * Attach to a terminal's output. `viewport` participates in the size
   * negotiation described in docs/decisions/0016-daemon-protocol.md.
   *
   * Absent, the attachment is input and scope only: the client may type and is
   * subscribed to the terminal, but receives no repaints and takes no part in
   * size negotiation. That is the CLI's reading path — ADR 0016, "a client
   * attaching with no viewport does not participate". Participation is chosen
   * here; attach again with a viewport to change it.
   */
  | {
      readonly type: "attach";
      readonly id: RequestID;
      readonly terminalID: TerminalID;
      readonly viewport?: GridSize;
    }
  | { readonly type: "detach"; readonly id: RequestID; readonly terminalID: TerminalID }
  /**
   * Start a configured-but-idle terminal. Attaching does not start anything; that
   * would make opening a session spawn processes.
   */
  | { readonly type: "startTerminal"; readonly id: RequestID; readonly terminalID: TerminalID }
  | { readonly type: "stopTerminal"; readonly id: RequestID; readonly terminalID: TerminalID }
  | { readonly type: "resize"; readonly terminalID: TerminalID; readonly size: GridSize }
  /** What is on screen, as text. The reason a CLI is useful to an agent. */
  | {
      readonly type: "snapshotText";
      readonly id: RequestID;
      readonly terminalID: TerminalID;
      readonly includeScrollback: boolean;
    };

/**
 * Keyboard input is deliberately absent from `ClientMessage`.
 *
 * It is the one high-frequency client message, and it travels as a raw frame with
 * a fixed-width header rather than inside JSON — see `message-coder.ts`. Keeping
 * it out of this union is what stops someone routing it through the control path
 * "just for now".
 */
export interface TerminalInput {
  readonly terminalID: TerminalID;
  readonly bytes: Uint8Array;
}

/** What the daemon can say. */
export type DaemonMessage =
  | { readonly type: "hello"; readonly hello: Hello }
  | { readonly type: "refused"; readonly refusal: HandshakeRefusal }
  /**
   * Projects, sessions and terminal status. Sent unsolicited to subscribers, so a
   * session created by the CLI appears in the app without the app asking.
   */
  | { readonly type: "state"; readonly update: StateUpdate }
  /**
   * A terminal wants attention. A fact, not a decision — policy lives in the
   * client. See docs/decisions/0011-notifications.md.
   */
  | { readonly type: "attention"; readonly signal: AttentionSignal }
  | {
      readonly type: "terminalExited";
      readonly terminalID: TerminalID;
      readonly code: number;
    }
  /** Reply to a request that succeeded and has no payload of its own. */
  | { readonly type: "acknowledged"; readonly id: RequestID }
  /** Reply to a request that failed. Carries text safe to show a person. */
  | { readonly type: "failed"; readonly id: RequestID; readonly failure: UserFacingFailure }
  | { readonly type: "text"; readonly id: RequestID; readonly text: string };

/**
 * Terminal output is likewise absent from `DaemonMessage`, and for the same
 * reason: repaint sequences are the hot path and travel as raw frames.
 */
export interface TerminalOutput {
  readonly terminalID: TerminalID;
  readonly bytes: Uint8Array;
}

/** How much a client wants to hear about. */
export type SubscriptionScope =
  /** Everything except terminal output. What a sidebar needs. */
  | { readonly kind: "state" }
  /**
   * One terminal's output. Implied by `attach`, and listed separately because a
   * client may subscribe to state without ever attaching to anything.
   */
  | { readonly kind: "terminal"; readonly terminalID: TerminalID };

/**
 * A batch of changes. Whole objects rather than diffs: the data is kilobytes, and
 * a diff protocol for the sidebar would be a lot of machinery to save nothing.
 */
export interface StateUpdate {
  readonly projects: readonly Project[];
  readonly sessions: readonly Session[];
  readonly terminalStates: Readonly<Record<TerminalID, TerminalState>>;
  /**
   * True when this is the complete picture rather than a change to part of it.
   *
   * Sent after `subscribe`, after any reconnection — and, as it happens, on every
   * state change the daemon announces: a client that merges by id cannot express
   * a deletion, so a removal propagates as absence from a complete list. A
   * partial update is therefore an addition or an edit, never a removal.
   */
  readonly isFullSnapshot: boolean;
}

/**
 * The wire form of a session creation request.
 *
 * Mirrors `SessionCreationRequest` in `@janela/session` rather than sharing it,
 * because this one is a *serialised intent* whose shape is frozen by the protocol
 * version. Letting an internal type define the wire format is how a refactor
 * becomes a breaking change for someone's script.
 */
export type SessionCreationIntent =
  | { readonly kind: "standalone"; readonly directory: AbsolutePath; readonly name?: string }
  | { readonly kind: "inProject"; readonly projectID: ProjectID; readonly name?: string }
  | {
      readonly kind: "newWorktree";
      readonly projectID: ProjectID;
      readonly branch: string;
      readonly startPoint?: string;
      readonly name?: string;
    }
  | {
      readonly kind: "adoptWorktree";
      readonly projectID: ProjectID;
      readonly directory: AbsolutePath;
      readonly name?: string;
    }
  | { readonly kind: "fromPullRequest"; readonly projectID: ProjectID; readonly number: number };

/**
 * An error, reduced to what is safe and useful to show a person.
 *
 * `UserFacingError` itself lives in `@janela/support`. This is its wire form, and
 * the conversion is deliberately lossy: raw stderr and underlying errors stay in
 * the daemon's log.
 */
export interface UserFacingFailure {
  readonly summary: string;
  readonly reason?: string;
  readonly recoverySuggestion?: string;
}

/** What a terminal reported, normalised, before any policy is applied. */
export interface AttentionSignal {
  readonly kind: AttentionKind;
  readonly terminalID: TerminalID;
  readonly sessionID: SessionID;
  /**
   * Set by the daemon so two clients can suppress a signal they have both already
   * delivered.
   */
  readonly id: string;
  readonly occurredAt: Instant;
}

export type AttentionKind =
  | { readonly kind: "bell" }
  | { readonly kind: "notification"; readonly title?: string; readonly body: string }
  | {
      readonly kind: "promptFinished";
      readonly exitCode?: number;
      readonly durationSeconds: number;
    };
