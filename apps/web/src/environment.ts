import {
  createConnection,
  createStores,
  type DaemonConnection,
  type ProjectStore,
  type SessionStore,
} from "@janela/client";
import type { MessageTransport } from "@janela/protocol";
import { log } from "@janela/support";

import { openWebSocketTransport, webSocketURL } from "./adapters/transport.ts";

export interface WebEnvironmentDeps {
  readonly openTransport?: (() => Promise<MessageTransport>) | undefined;
}

export interface WebEnvironment {
  readonly projects: ProjectStore;
  readonly sessions: SessionStore;
  readonly connection: DaemonConnection;

  start(): Promise<void>;
}
export const CLIENT_NAME = "janela-web";

export function webEnvironment(deps: WebEnvironmentDeps = {}): WebEnvironment {
  const { projects, sessions, mirror } = createStores();

  const connection = createConnection({
    openTransport: deps.openTransport ?? (() => openWebSocketTransport(webSocketURL(location))),
    clientName: CLIENT_NAME,
    mirror,
    log: log("protocol"),
  });

  return {
    projects,
    sessions,
    connection,

    start(): Promise<void> {
      return connection.connect();
    },
  };
}
