import { connect } from "node:net";

import type { Logger } from "@janela/support";

export interface RelayPeer {
  send(bytes: Uint8Array): number;
  close(code: number, reason: string): void;
}

export interface Relay {
  deliver(bytes: Uint8Array): void;
  drained(): void;
  close(): void;
}

export interface RelayOptions {
  readonly socketPath: string;
  readonly onDaemonUnreachable: () => void;
  readonly log: Logger;
}

export const INPUT_BACKLOG_LIMIT_BYTES = 1024 * 1024;

const PEER_GONE = 0;

const PEER_BACKPRESSURED = -1;

const NORMAL_CLOSURE = 1000;

const TRY_AGAIN_LATER = 1013;

const INTERNAL_FAILURE = 1011;

export function openRelay(peer: RelayPeer, options: RelayOptions): Relay {
  const { socketPath, onDaemonUnreachable, log } = options;

  let connected = false;
  let closed = false;
  let abandoned = false;

  const socket = connect({ path: socketPath });

  const closePeer = (code: number, reason: string): void => {
    if (closed || abandoned) return;

    closed = true;
    log.debug("relay closed", { code });
    peer.close(code, reason);
  };

  socket.on("connect", () => {
    connected = true;
  });

  socket.on("data", (chunk: Buffer) => {
    const sent = peer.send(chunk);

    if (sent === PEER_BACKPRESSURED) socket.pause();

    if (sent === PEER_GONE) socket.destroy();
  });

  socket.on("error", () => {
    if (!connected && !abandoned) onDaemonUnreachable();

    closePeer(INTERNAL_FAILURE, connected ? "daemon failed" : "daemon unreachable");
  });

  socket.on("end", () => closePeer(NORMAL_CLOSURE, "daemon closed"));

  socket.on("close", () => closePeer(NORMAL_CLOSURE, "daemon closed"));

  return {
    deliver: (bytes) => {
      if (abandoned || closed) return;

      socket.write(bytes);

      if (socket.writableLength > INPUT_BACKLOG_LIMIT_BYTES) {
        log.debug("daemon input backlog", { bytes: socket.writableLength });
        closePeer(TRY_AGAIN_LATER, "daemon not draining");
        socket.destroy();
      }
    },
    drained: () => {
      if (abandoned) return;

      socket.resume();
    },
    close: () => {
      abandoned = true;
      socket.destroy();
    },
  };
}
