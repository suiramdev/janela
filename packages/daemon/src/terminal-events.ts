import {
  formatAgentActivity,
  now,
  type AgentActivity,
  type TerminalID,
  type TerminalProgress,
  type TerminalState,
} from "@janela/core";
import type { AttentionKind, DaemonMessage, StateUpdate } from "@janela/protocol";
import type { Logger } from "@janela/support";
import type {
  LiveTerminal,
  TerminalNotification,
  TerminalRegistryObserving,
} from "@janela/terminal";
import { Match } from "effect";

export interface TerminalEventOptions {
  readonly broadcast: (message: DaemonMessage) => void;
  readonly log: Logger;
}

export interface TerminalEventRelay extends TerminalRegistryObserving {
  reconcile(terminal: LiveTerminal): void;
}

export function partialTerminalState(id: TerminalID, state: TerminalState): StateUpdate {
  return {
    projects: [],
    sessions: [],
    terminalStates: { [id]: state },
    isFullSnapshot: false,
  };
}

export function createTerminalEvents(options: TerminalEventOptions): TerminalEventRelay {
  const { broadcast, log } = options;
  const published = new Map<TerminalID, string>();

  const reconcile = (terminal: LiveTerminal): void => {
    const state = terminal.state;
    const signature = stateSignature(state);

    if (published.get(terminal.id) === signature) return;

    published.set(terminal.id, signature);
    broadcast({ type: "state", update: partialTerminalState(terminal.id, state) });
  };

  const raise = (terminal: LiveTerminal, kind: AttentionKind): void => {
    reconcile(terminal);
    broadcast({
      type: "attention",
      signal: {
        kind,
        terminalID: terminal.id,
        sessionID: terminal.sessionID,
        id: crypto.randomUUID(),
        occurredAt: now(),
      },
    });

    log.debug("attention raised", { terminalID: terminal.id, attention: kind.kind });
  };

  return {
    reconcile,

    terminalRegistered(terminal: LiveTerminal): void {
      terminal.events = {
        onTitle: () => undefined,
        onWorkingDirectory: () => undefined,
        onPromptMark: () => undefined,
        onAttention: (notification: TerminalNotification) => {
          raise(terminal, attentionKind(notification));
        },
        onPromptFinished: (completion) => {
          raise(
            terminal,
            completion.exitCode === undefined
              ? { kind: "promptFinished", durationSeconds: completion.durationSeconds }
              : {
                  kind: "promptFinished",
                  exitCode: completion.exitCode,
                  durationSeconds: completion.durationSeconds,
                },
          );
        },
        onProgress: () => {
          reconcile(terminal);
        },
        onActivity: (activity: AgentActivity) => {
          if (activity.kind === "working") {
            reconcile(terminal);

            return;
          }

          raise(terminal, { kind: "activity", activity });
        },
        onFailure: () => {
          reconcile(terminal);
        },
        onExit: (code: number) => {
          reconcile(terminal);
          broadcast({ type: "terminalExited", terminalID: terminal.id, code });
          log.debug("terminal exited", { terminalID: terminal.id, code });
        },
      };
    },

    terminalRemoved(id: TerminalID): void {
      published.delete(id);
    },
  };
}

function attentionKind(notification: TerminalNotification): AttentionKind {
  const body = notification.body;

  if (body === undefined) return { kind: "bell" };

  const title = notification.title;

  return title === undefined
    ? { kind: "notification", body }
    : { kind: "notification", title, body };
}

function stateSignature(state: TerminalState): string {
  return Match.value(state).pipe(
    Match.when({ kind: "idle" }, () => "idle"),
    Match.when({ kind: "needsAttention" }, (attention) =>
      attention.activity === undefined
        ? "needsAttention"
        : `needsAttention:${formatAgentActivity(attention.activity)}`,
    ),
    Match.when({ kind: "exited" }, (exited) => `exited:${exited.code}`),
    Match.when({ kind: "failed" }, (failed) => `failed:${failed.message}`),
    Match.when(
      { kind: "running" },
      (running) =>
        `running:${progressSignature(running.progress)}:${
          running.activity === undefined ? "none" : formatAgentActivity(running.activity)
        }`,
    ),
    Match.exhaustive,
  );
}

function progressSignature(progress: TerminalProgress | undefined): string {
  if (progress === undefined) return "none";

  return progress.kind === "indeterminate"
    ? "indeterminate"
    : `${progress.kind}:${progress.percent}`;
}
