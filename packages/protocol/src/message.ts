import type {
  AbsolutePath,
  AgentActivity,
  Axis,
  GridSize,
  Instant,
  IntegrationID,
  LaunchProfile,
  LaunchProfileID,
  Project,
  ProjectID,
  PaneDestination,
  ProjectSettings,
  Session,
  SessionID,
  TerminalID,
  TerminalState,
} from "@janela/core";

import type { HandshakeRefusal, Hello } from "./handshake.ts";

export type RequestID = number & { readonly __brand: "RequestID" };

export type ClientMessage =
  | { readonly type: "hello"; readonly hello: Hello }
  | { readonly type: "subscribe"; readonly id: RequestID; readonly scope: SubscriptionScope }
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
  | {
      readonly type: "markSession";
      readonly id: RequestID;
      readonly sessionID: SessionID;
      readonly unread: boolean;
    }
  | { readonly type: "removalPlan"; readonly id: RequestID; readonly sessionID: SessionID }
  | { readonly type: "projectBranches"; readonly id: RequestID; readonly projectID: ProjectID }
  | { readonly type: "listDirectory"; readonly id: RequestID; readonly directory?: AbsolutePath }
  | {
      readonly type: "moveTab";
      readonly id: RequestID;
      readonly sessionID: SessionID;
      readonly from: number;
      readonly to: number;
    }
  | {
      readonly type: "moveTerminal";
      readonly id: RequestID;
      readonly sessionID: SessionID;
      readonly terminalID: TerminalID;
      readonly destination: PaneDestination;
    }
  | {
      readonly type: "attach";
      readonly id: RequestID;
      readonly terminalID: TerminalID;
      readonly viewport?: GridSize;
    }
  | { readonly type: "detach"; readonly id: RequestID; readonly terminalID: TerminalID }
  | { readonly type: "startTerminal"; readonly id: RequestID; readonly terminalID: TerminalID }
  | { readonly type: "stopTerminal"; readonly id: RequestID; readonly terminalID: TerminalID }
  | { readonly type: "restartTerminal"; readonly id: RequestID; readonly terminalID: TerminalID }
  | { readonly type: "resize"; readonly terminalID: TerminalID; readonly size: GridSize }
  | {
      readonly type: "snapshotText";
      readonly id: RequestID;
      readonly terminalID: TerminalID;
      readonly includeScrollback: boolean;
    }
  | {
      readonly type: "saveLaunchProfile";
      readonly id: RequestID;
      readonly profile: LaunchProfile;
    }
  | {
      readonly type: "removeLaunchProfile";
      readonly id: RequestID;
      readonly profileID: LaunchProfileID;
    }
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
  | {
      readonly type: "removeTerminal";
      readonly id: RequestID;
      readonly terminalID: TerminalID;
    }
  | { readonly type: "integrations"; readonly id: RequestID }
  | {
      readonly type: "installIntegration";
      readonly id: RequestID;
      readonly integrationID: IntegrationID;
    }
  | {
      readonly type: "removeIntegration";
      readonly id: RequestID;
      readonly integrationID: IntegrationID;
    };

export interface TerminalInput {
  readonly terminalID: TerminalID;
  readonly bytes: Uint8Array;
}

export type DaemonMessage =
  | { readonly type: "hello"; readonly hello: Hello }
  | { readonly type: "refused"; readonly refusal: HandshakeRefusal }
  | { readonly type: "state"; readonly update: StateUpdate }
  | { readonly type: "attention"; readonly signal: AttentionSignal }
  | {
      readonly type: "terminalExited";
      readonly terminalID: TerminalID;
      readonly code: number;
    }
  | { readonly type: "acknowledged"; readonly id: RequestID }
  | { readonly type: "failed"; readonly id: RequestID; readonly failure: UserFacingFailure }
  | { readonly type: "text"; readonly id: RequestID; readonly text: string };

export interface TerminalOutput {
  readonly terminalID: TerminalID;
  readonly bytes: Uint8Array;
}

export type SubscriptionScope =
  | { readonly kind: "state" }
  | { readonly kind: "terminal"; readonly terminalID: TerminalID };

export interface StateUpdate {
  readonly projects: readonly Project[];
  readonly sessions: readonly Session[];
  readonly terminalStates: Readonly<Record<TerminalID, TerminalState>>;
  readonly launchProfiles: readonly LaunchProfile[];
  readonly launchProfileAvailability: Readonly<Record<LaunchProfileID, boolean>>;
  readonly isFullSnapshot: boolean;
}

export type SessionCreationIntent =
  | { readonly kind: "standalone"; readonly directory: AbsolutePath; readonly name?: string }
  | {
      readonly kind: "inProject";
      readonly projectID: ProjectID;
      readonly branch?: string;
      readonly name?: string;
    }
  | {
      readonly kind: "newWorktree";
      readonly projectID: ProjectID;
      readonly branch: string;
      readonly startPoint?: string;
      readonly name?: string;
      readonly shareBranch?: boolean;
    }
  | {
      readonly kind: "adoptWorktree";
      readonly projectID: ProjectID;
      readonly directory: AbsolutePath;
      readonly name?: string;
    }
  | { readonly kind: "fromPullRequest"; readonly projectID: ProjectID; readonly number: number };

export interface UserFacingFailure {
  readonly summary: string;
  readonly reason?: string;
  readonly recoverySuggestion?: string;
}

export interface AttentionSignal {
  readonly kind: AttentionKind;
  readonly terminalID: TerminalID;
  readonly sessionID: SessionID;
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
    }
  | { readonly kind: "activity"; readonly activity: AgentActivity };
