import type {
  AbsolutePath,
  Axis,
  GridSize,
  Instant,
  LaunchProfile,
  LaunchProfileID,
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

/**
 * What a client can say.
 *
 * Note what is *not* here: nothing lets a client read or write the database, and
 * nothing lets it start a process directly. Every capability is expressed as an
 * intent the daemon validates. If the CLI cannot do it through this union, neither
 * can the app.
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
  /**
   * The project's local branches and every checkout of its repository, so a
   * client can offer "which branch, and where" — check it out in the project's
   * own directory, adopt the worktree that already holds it, or create a new
   * one. The reply is `text` carrying `serializeBranchOverview` JSON — parse it
   * with `parseBranchOverview`.
   *
   * Refused for a project that is not a repository: there is no honest empty
   * answer, because "no branches" and "not a repository" are different things
   * to say to a person.
   */
  | { readonly type: "projectBranches"; readonly id: RequestID; readonly projectID: ProjectID }
  /**
   * Reorder a session's tabs: the tab at `from` moves to index `to`.
   *
   * A request rather than a client-local rearrangement, because tab order is
   * part of `SessionLayout` and the daemon owns that — a client that reordered
   * its mirror would lose the change on the next state snapshot. Reply is
   * `acknowledged`; a move that changes nothing is acknowledged and persists
   * nothing.
   */
  | {
      readonly type: "moveTab";
      readonly id: RequestID;
      readonly sessionID: SessionID;
      readonly from: number;
      readonly to: number;
    }

  // ---- Terminals
  /**
   * Attach to a terminal's output. `viewport` participates in the size
   * negotiation between the clients watching a terminal.
   *
   * Absent, the attachment is input and scope only: the client may type and is
   * subscribed to the terminal, but receives no repaints and takes no part in
   * size negotiation. That is the CLI's reading path — a client attaching with no
   * viewport does not participate. Participation is chosen here; attach again with
   * a viewport to change it.
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
  /**
   * Stop and start again, as one operation.
   *
   * Not `stopTerminal` then `startTerminal`: a stop closes the pty and the state
   * stays `running` until the reader thread reaps it, so a start that arrives
   * first finds a terminal it believes is already running and does nothing. The
   * daemon owns the ordering because only it can see the reaping.
   */
  | { readonly type: "restartTerminal"; readonly id: RequestID; readonly terminalID: TerminalID }
  | { readonly type: "resize"; readonly terminalID: TerminalID; readonly size: GridSize }
  /** What is on screen, as text. The reason a CLI is useful to an agent. */
  | {
      readonly type: "snapshotText";
      readonly id: RequestID;
      readonly terminalID: TerminalID;
      readonly includeScrollback: boolean;
    }

  // ---- Launch profiles
  /**
   * Upsert, keyed by the profile's own id: the client mints one with
   * `newLaunchProfileID()` for a profile it is creating, so the id it selects in
   * its editor is the id the daemon stores and there is no round trip to wait on.
   *
   * `isBuiltIn` is carried for completeness and **ignored**: a stored profile
   * keeps whatever it already was, and anything new is a user profile. A client
   * able to set it could mint an undeletable profile, or make a built-in
   * removable.
   */
  | {
      readonly type: "saveLaunchProfile";
      readonly id: RequestID;
      readonly profile: LaunchProfile;
    }
  /** Refused for a built-in: those are overridden by copying, never deleted. */
  | {
      readonly type: "removeLaunchProfile";
      readonly id: RequestID;
      readonly profileID: LaunchProfileID;
    }
  /**
   * A new terminal in a session that already exists — ⌘T, with a profile chosen
   * from the picker. Absent `profileID` means the login shell.
   *
   * Configured, not started: the reply is `text` carrying the new `TerminalID`,
   * and the client starts it with `startTerminal` when it wants the process.
   *
   * `placement` absent means a new focused tab. `split` means the daemon splits
   * the pane holding `beside` along `axis` with `splitPane`, and the new terminal
   * is focused within that tab. The split is part of the session's layout, so it
   * is persisted by the daemon rather than being a client-local arrangement.
   */
  | {
      readonly type: "createTerminal";
      readonly id: RequestID;
      readonly sessionID: SessionID;
      readonly profileID?: LaunchProfileID;
      readonly title?: string;
      readonly placement?: {
        readonly kind: "split";
        readonly beside: TerminalID;
        readonly axis: Axis;
      };
    }
  /**
   * Close one terminal — the ⌘W path, and the only path that both stops a
   * terminal and forgets it.
   *
   * Stops the process when it is live, drops the descriptor and collapses the
   * layout with `closeTerminal`. Closing the last terminal of a session leaves
   * one fresh idle shell behind: a session never has zero terminals. Reply is
   * `acknowledged`.
   */
  | {
      readonly type: "removeTerminal";
      readonly id: RequestID;
      readonly terminalID: TerminalID;
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
   * client.
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
   * Every launch profile, built-in and user-authored, in the daemon's order.
   * Empty in a partial update means "unchanged", exactly as `projects` does.
   */
  readonly launchProfiles: readonly LaunchProfile[];
  /**
   * Whether each profile's executable was found on the captured login-shell
   * `PATH`. Keyed separately from the profile because it is a fact about this
   * machine right now, not part of what the user authored — a profile whose tool
   * is not installed is still a profile, and reinstalling the tool must not
   * require editing it.
   *
   * A profile with an empty `command` is the login shell and is always available.
   */
  readonly launchProfileAvailability: Readonly<Record<LaunchProfileID, boolean>>;
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
  /**
   * A session in the project's own directory. `branch` checks that branch out
   * there first — the "work on this branch, in place" answer to the same
   * dialog `projectBranches` feeds. A checkout git refuses creates no session.
   */
  | {
      readonly kind: "inProject";
      readonly projectID: ProjectID;
      readonly branch?: string;
      readonly name?: string;
    }
  /**
   * A worktree of this project's repository, created for `branch`.
   *
   * `name` names the session *and* the leaf of the directory the daemon places
   * it in, so a second worktree of one branch is told apart by the name its
   * owner gave it. Where the worktree root is remains the daemon's decision.
   */
  | {
      readonly kind: "newWorktree";
      readonly projectID: ProjectID;
      readonly branch: string;
      readonly startPoint?: string;
      readonly name?: string;
      /**
       * Create the worktree even though another checkout already holds `branch`.
       * git refuses that by default, for the good reason that the two worktrees
       * then move each other's `HEAD`; the flag exists because the dialog says
       * so and the user may still want it. Absent is the safe default, and a
       * daemon that predates this field simply lets git refuse.
       */
      readonly shareBranch?: boolean;
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
