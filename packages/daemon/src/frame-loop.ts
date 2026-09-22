import type { TerminalID } from "@janela/core";
import type { Logger } from "@janela/support";
import type { LiveTerminal, TerminalRegistry } from "@janela/terminal";
import { Result } from "effect";

export interface FrameLoop {
  start(signal: AbortSignal): void;
  readonly intervalMs: number;
  tick(): void;
  attach(client: string, terminalID: TerminalID): void;
  detach(client: string, terminalID: TerminalID): void;
  detachAll(client: string): void;
  wake(): void;
}

export interface FrameLoopDependencies {
  readonly terminals: TerminalRegistry;
  readonly liveTerminals: () => Iterable<LiveTerminal>;
  readonly hasRoom: (client: string) => boolean;
  readonly deliver: (client: string, terminalID: TerminalID, bytes: Uint8Array) => void;
  readonly settled: (terminal: LiveTerminal) => void;
  readonly log: Logger;
}

interface Attachment {
  full: boolean;
}

export const FRAME_INTERVAL_MS = 8;

const errorName = (cause: unknown): string => (cause instanceof Error ? cause.name : "unknown");

export function createFrameLoop(dependencies: FrameLoopDependencies): FrameLoop {
  const { terminals, liveTerminals, hasRoom, deliver, settled, log } = dependencies;

  const attachments = new Map<TerminalID, Map<string, Attachment>>();
  const drained = new Set<TerminalID>();
  const failing = new Set<TerminalID>();
  let timer: Timer | undefined;
  let armed = false;

  const feed = (terminal: LiveTerminal): boolean => {
    if (drained.has(terminal.id)) return !failing.has(terminal.id);

    drained.add(terminal.id);

    const drain = Result.try({
      try: () => {
        terminal.drain();
      },
      catch: errorName,
    });

    if (Result.isFailure(drain)) {
      if (!failing.has(terminal.id)) {
        failing.add(terminal.id);
        log.warning("drain failed", {
          terminalID: terminal.id,
          error: drain.failure,
        });
      }

      for (const attachment of attachments.get(terminal.id)?.values() ?? []) {
        attachment.full = true;
      }

      return false;
    }

    failing.delete(terminal.id);

    return true;
  };

  const loop: FrameLoop = {
    intervalMs: FRAME_INTERVAL_MS,

    start(signal: AbortSignal): void {
      armed = true;

      if (timer === undefined) {
        timer = setInterval(loop.tick, FRAME_INTERVAL_MS);
      }

      signal.addEventListener(
        "abort",
        () => {
          armed = false;

          if (timer !== undefined) {
            clearInterval(timer);
            timer = undefined;
          }
        },
        { once: true },
      );
    },

    tick(): void {
      drained.clear();

      let live = 0;

      for (const terminal of liveTerminals()) {
        const kind = terminal.state.kind;

        if (kind !== "running" && kind !== "needsAttention") continue;

        live += 1;
        feed(terminal);
      }

      for (const [terminalID, clients] of attachments) {
        const terminal = terminals.get(terminalID);

        if (terminal === undefined) {
          attachments.delete(terminalID);

          continue;
        }

        if (!feed(terminal)) continue;

        for (const [client, attachment] of clients) {
          if (!hasRoom(client)) {
            attachment.full = true;

            continue;
          }

          const full = attachment.full;
          const painted = Result.try({
            try: () => (full ? terminal.fullRepaintFor(client) : terminal.repaintFor(client)),
            catch: errorName,
          });

          if (Result.isFailure(painted)) {
            log.warning("repaint failed", {
              terminalID,
              client,
              error: painted.failure,
            });

            attachments.delete(terminalID);

            break;
          }

          attachment.full = false;

          if (full) settled(terminal);

          if (painted.success.length > 0) deliver(client, terminalID, painted.success);
        }
      }

      if (live === 0 && attachments.size === 0 && timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },

    attach(client: string, terminalID: TerminalID): void {
      let clients = attachments.get(terminalID);

      if (clients === undefined) {
        clients = new Map<string, Attachment>();
        attachments.set(terminalID, clients);
      }

      clients.set(client, { full: true });

      if (armed && timer === undefined) {
        timer = setInterval(loop.tick, FRAME_INTERVAL_MS);
      }
    },

    detach(client: string, terminalID: TerminalID): void {
      const clients = attachments.get(terminalID);

      if (clients === undefined) return;

      clients.delete(client);

      if (clients.size === 0) attachments.delete(terminalID);
    },

    detachAll(client: string): void {
      for (const [terminalID, clients] of attachments) {
        clients.delete(client);

        if (clients.size === 0) attachments.delete(terminalID);
      }
    },

    wake(): void {
      if (armed && timer === undefined) {
        timer = setInterval(loop.tick, FRAME_INTERVAL_MS);
      }
    },
  };

  return loop;
}
