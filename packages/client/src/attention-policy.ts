import type { SessionID, TerminalID } from "@janela/core";
import type { AttentionSignal } from "@janela/protocol";
import type { Logger } from "@janela/support";
import { Match } from "effect";

import type { NotificationSound } from "./attention-sound.ts";
import { SILENT_NOTIFICATION_SOUND } from "./attention-sound.ts";
import type { SessionStore } from "./stores.ts";

export interface AttentionPolicy {
  shouldDeliver(
    signal: AttentionSignal,
    context: AttentionContext,
    preferences: AttentionPreferences,
  ): boolean;

  forgetSession(id: SessionID): void;
}

export interface AttentionContext {
  readonly isApplicationActive: boolean;
  readonly selectedSessionID?: SessionID | undefined;
  readonly focusedTerminalID?: TerminalID | undefined;
}

export type AttentionEvent = "bell" | "waiting" | "finished" | "failed";

export interface AttentionEventPreference {
  readonly notifies: boolean;
  readonly sound: NotificationSound;
}

export type AttentionPreferences = Readonly<Record<AttentionEvent, AttentionEventPreference>>;

export interface AttentionDelivering {
  deliver(input: {
    readonly signal: AttentionSignal;
    readonly sessionName: string;
    readonly terminalTitle: string;
  }): Promise<void>;

  withdraw(sessionID: SessionID): Promise<void>;
}

export interface AttentionSource {
  onAttention(handler: (signal: AttentionSignal) => void): () => void;
}

export interface AttentionRoutingOptions {
  readonly source: AttentionSource;
  readonly sessions: SessionStore;
  readonly policy: AttentionPolicy;
  readonly delivery: AttentionDelivering;
  readonly isApplicationActive: () => boolean;
  readonly focusedTerminalID: () => TerminalID | undefined;
  readonly preferences: () => AttentionPreferences;
  readonly log?: Logger;
}

export interface AttentionRouting {
  stop(): void;
}

export const ATTENTION_EVENTS: readonly AttentionEvent[] = [
  "bell",
  "waiting",
  "finished",
  "failed",
];

export const DEFAULT_ATTENTION_PREFERENCES = {
  bell: { notifies: false, sound: SILENT_NOTIFICATION_SOUND },
  waiting: { notifies: true, sound: SILENT_NOTIFICATION_SOUND },
  finished: { notifies: true, sound: SILENT_NOTIFICATION_SOUND },
  failed: { notifies: true, sound: SILENT_NOTIFICATION_SOUND },
} satisfies AttentionPreferences;

export const COALESCING_WINDOW_SECONDS = 5;

export const LONG_RUNNING_THRESHOLD_SECONDS = 10;

const COALESCING_WINDOW_MS = COALESCING_WINDOW_SECONDS * 1_000;

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  notice: () => {},
  warning: () => {},
  error: () => {},
};

export function createAttentionPolicy(): AttentionPolicy {
  const delivered = new Map<TerminalID, { readonly sessionID: SessionID; readonly at: number }>();

  return {
    shouldDeliver(
      signal: AttentionSignal,
      context: AttentionContext,
      preferences: AttentionPreferences,
    ): boolean {
      const now = Date.parse(signal.occurredAt);

      for (const [terminalID, entry] of delivered) {
        const elapsed = now - entry.at;

        if (Number.isNaN(elapsed) || elapsed >= COALESCING_WINDOW_MS) delivered.delete(terminalID);
      }

      if (delivered.has(signal.terminalID)) return false;

      if (
        context.isApplicationActive &&
        context.selectedSessionID === signal.sessionID &&
        context.focusedTerminalID === signal.terminalID
      ) {
        return false;
      }

      if (!isWorthInterrupting(signal, preferences)) return false;

      delivered.set(signal.terminalID, { sessionID: signal.sessionID, at: now });

      return true;
    },

    forgetSession(id: SessionID): void {
      for (const [terminalID, entry] of delivered) {
        if (entry.sessionID === id) delivered.delete(terminalID);
      }
    },
  };
}

export function attentionEvent(signal: AttentionSignal): AttentionEvent | undefined {
  return Match.value(signal.kind).pipe(
    Match.when({ kind: "bell" }, (): AttentionEvent => "bell"),
    Match.when({ kind: "notification" }, (): AttentionEvent => "bell"),
    Match.when({ kind: "promptFinished" }, (): AttentionEvent => "failed"),
    Match.when({ kind: "activity" }, (reported) =>
      Match.value(reported.activity).pipe(
        Match.when({ kind: "working" }, (): AttentionEvent | undefined => undefined),
        Match.when({ kind: "waiting" }, (): AttentionEvent => "waiting"),
        Match.when({ kind: "finished", outcome: "completed" }, (): AttentionEvent => "finished"),
        Match.when({ kind: "finished", outcome: "failed" }, (): AttentionEvent => "failed"),
        Match.exhaustive,
      ),
    ),
    Match.exhaustive,
  );
}

function isWorthInterrupting(signal: AttentionSignal, preferences: AttentionPreferences): boolean {
  return Match.value(signal.kind).pipe(
    Match.when({ kind: "bell" }, () => preferences.bell.notifies),
    Match.when({ kind: "notification" }, () => true),
    Match.when(
      { kind: "promptFinished" },
      (finished) =>
        finished.exitCode !== undefined &&
        finished.exitCode !== 0 &&
        finished.durationSeconds >= LONG_RUNNING_THRESHOLD_SECONDS,
    ),
    Match.when({ kind: "activity" }, (reported) =>
      Match.value(reported.activity).pipe(
        Match.when({ kind: "working" }, () => false),
        Match.when({ kind: "waiting" }, () => preferences.waiting.notifies),
        Match.when({ kind: "finished", outcome: "completed" }, () => preferences.finished.notifies),
        Match.when({ kind: "finished", outcome: "failed" }, () => preferences.failed.notifies),
        Match.exhaustive,
      ),
    ),
    Match.exhaustive,
  );
}

export function routeAttention(options: AttentionRoutingOptions): AttentionRouting {
  const log = options.log ?? silentLogger;
  const { sessions, policy, delivery } = options;

  let known = new Set<SessionID>(sessions.sessions.map((session) => session.id));

  const settle = (work: Promise<void>, message: string): void => {
    void work.catch((cause: unknown) => {
      log.warning(message, { error: cause instanceof Error ? cause.name : "unknown" });
    });
  };

  const unsubscribeSignals = options.source.onAttention((signal: AttentionSignal): void => {
    const active = options.isApplicationActive();
    const selected = sessions.selection;
    const focused = options.focusedTerminalID();

    const context: AttentionContext = {
      isApplicationActive: active,
      selectedSessionID: selected,
      focusedTerminalID: focused,
    };

    if (!policy.shouldDeliver(signal, context, options.preferences())) return;

    const session = sessions.sessions.find((candidate) => candidate.id === signal.sessionID);
    const terminal = session?.terminals.find((candidate) => candidate.id === signal.terminalID);

    if (session === undefined || terminal === undefined) {
      log.debug("attention for an unmirrored terminal", {
        sessionID: signal.sessionID,
        terminalID: signal.terminalID,
      });

      return;
    }

    settle(
      delivery.deliver({
        signal,
        sessionName: session.name,
        terminalTitle: terminal.title,
      }),
      "attention delivery failed",
    );
  });

  const unsubscribeMirror = sessions.subscribe((): void => {
    const current = new Set<SessionID>(sessions.sessions.map((session) => session.id));

    for (const id of known) {
      if (current.has(id)) continue;

      settle(delivery.withdraw(id), "attention withdrawal failed");
      policy.forgetSession(id);
    }

    known = current;
  });

  return {
    stop(): void {
      unsubscribeSignals();
      unsubscribeMirror();
    },
  };
}
