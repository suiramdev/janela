import {
  createAttentionPolicy,
  createConnection,
  createStores,
  routeAttention,
  type AttentionDelivering,
  type DaemonConnection,
  type ProjectStore,
  type SessionStore,
} from "@janela/client";
import type { TerminalID } from "@janela/core";
import { log } from "@janela/support";
import { invoke } from "@tauri-apps/api/core";
import { Match } from "effect";

import {
  createNotificationDelivery,
  type NotificationPlugin,
} from "./adapters/notification-delivery.ts";
import { openTauriTransport, type BridgeInvoke } from "./adapters/transport.ts";

export type LaunchAgentStatus =
  | "unknown"
  | "unsupported"
  | "registered"
  | "requires-approval"
  | "not-found"
  | "unavailable";

export interface LaunchAgentState {
  readonly status: LaunchAgentStatus;
  subscribe(listener: () => void): () => void;
  openLoginItemsSettings(): Promise<void>;
}

export interface TerminalFocus {
  report(id: TerminalID | undefined): void;

  install(focus: (id: TerminalID) => void): () => void;
}

export interface LiveEnvironmentDeps {
  readonly invoke?: BridgeInvoke | undefined;
  readonly plugin?: NotificationPlugin | undefined;
  readonly activateWindow?: (() => Promise<void>) | undefined;
  readonly isApplicationActive?: (() => boolean) | undefined;
}

export interface AppEnvironment {
  readonly projects: ProjectStore;
  readonly sessions: SessionStore;
  readonly connection: DaemonConnection;
  readonly attention: AttentionDelivering;
  readonly launchAgent: LaunchAgentState;
  readonly focus: TerminalFocus;

  start(): Promise<void>;

  stopBackgroundService(): Promise<void>;
}

export const CLIENT_NAME = "janela-desktop";

export function liveEnvironment(deps: LiveEnvironmentDeps = {}): AppEnvironment {
  const invokeFn = deps.invoke ?? invoke;
  const { projects, sessions, mirror } = createStores();

  const connection = createConnection({
    openTransport: () => openTauriTransport(invokeFn),
    clientName: CLIENT_NAME,
    mirror,
    log: log("protocol"),
  });

  let focusedTerminal: TerminalID | undefined;
  let focuser: ((id: TerminalID) => void) | undefined;

  const focus: TerminalFocus = {
    report(id: TerminalID | undefined): void {
      focusedTerminal = id;
    },
    install(next: (id: TerminalID) => void): () => void {
      focuser = next;

      return () => {
        if (focuser === next) focuser = undefined;
      };
    },
  };

  const attention = createNotificationDelivery({
    plugin: deps.plugin,
    activateWindow: deps.activateWindow,
    log: log("app"),
    onActivate: (target) => {
      sessions.selection = target.sessionID;
      focuser?.(target.terminalID);
    },
  });

  routeAttention({
    source: connection,
    sessions,
    policy: createAttentionPolicy(),
    delivery: attention,
    isApplicationActive: deps.isApplicationActive ?? ((): boolean => document.hasFocus()),
    focusedTerminalID: () => focusedTerminal,
    log: log("app"),
  });

  const appLog = log("app");
  let status: LaunchAgentStatus = "unknown";
  const agentListeners = new Set<() => void>();

  const setStatus = (next: LaunchAgentStatus): void => {
    if (next === status) return;

    status = next;

    for (const listener of agentListeners) listener();
  };

  const settle = (next: LaunchAgentStatus): void => {
    appLog.info("launch agent", { status: next });
    setStatus(next);
  };

  const launchAgent: LaunchAgentState = {
    get status(): LaunchAgentStatus {
      return status;
    },
    subscribe(listener: () => void): () => void {
      agentListeners.add(listener);

      return () => agentListeners.delete(listener);
    },
    async openLoginItemsSettings(): Promise<void> {
      await invokeFn<void>("open_login_items_settings");
    },
  };

  return {
    projects,
    sessions,
    connection,
    attention,
    launchAgent,
    focus,

    start(): Promise<void> {
      void invokeFn<string>("register_launch_agent").then(
        (reported) => settle(asLaunchAgentStatus(reported)),
        () => settle("unavailable"),
      );

      return connection.connect();
    },

    async stopBackgroundService(): Promise<void> {
      await connection.disconnect();
      await invokeFn<void>("stop_background_service");
    },
  };
}

function asLaunchAgentStatus(reported: string): LaunchAgentStatus {
  return Match.value(reported).pipe(
    Match.when("unsupported", (status) => status),
    Match.when("registered", (status) => status),
    Match.when("requires-approval", (status) => status),
    Match.when("not-found", (status) => status),
    Match.orElse((): LaunchAgentStatus => "unavailable"),
  );
}
