import type { TerminalID } from "@janela/core";
import {
  FrameError,
  FrameKind,
  MINIMUM_SUPPORTED_VERSION,
  PROTOCOL_VERSION,
  UnknownTerminalFrame,
  decodeDaemonMessage,
  decodeOutput,
  encodeClientMessage,
  encodeInput,
  frameErrorLabel,
  isCompatible,
  type AttentionSignal,
  type ClientMessage,
  type DaemonMessage,
  type Frame,
  type HandshakeRefusal,
  type Hello,
  type MessageTransport,
  type RequestID,
  type UserFacingFailure,
} from "@janela/protocol";
import { UserFacingError, type Logger, type Presentation } from "@janela/support";
import { Effect, Match, Predicate, Result } from "effect";

import type { MirrorApplying } from "./stores.ts";

interface MutablePresentation {
  reason?: string;
  recoverySuggestion?: string;
}

export interface DaemonConnection {
  readonly status: ConnectionStatus;

  readonly isStale: boolean;

  connect(): Promise<void>;

  request(message: ClientRequest): Promise<string | undefined>;

  sendInput(bytes: Uint8Array, terminalID: TerminalID): void;

  onOutput(terminalID: TerminalID, handler: (bytes: Uint8Array) => void): () => void;

  onAttention(handler: (signal: AttentionSignal) => void): () => void;

  subscribe(listener: () => void): () => void;

  disconnect(): Promise<void>;
}

export type ClientRequest =
  Exclude<ClientMessage, { readonly type: "hello" }> extends infer Message
    ? Message extends { readonly id: RequestID }
      ? Omit<Message, "id">
      : Message
    : never;

export type ConnectionStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "connecting" }
  | { readonly kind: "connected" }
  | { readonly kind: "reconnecting"; readonly attempt: number }
  | { readonly kind: "refused"; readonly refusal: HandshakeRefusal };

type AttemptOutcome = "lost" | "failed" | "refused";

export const RECONNECT_INITIAL_DELAY_MS = 250;

export const RECONNECT_MAXIMUM_DELAY_MS = 10_000;

export const HANDSHAKE_DEADLINE_MS = 5_000;

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  notice: () => {},
  warning: () => {},
  error: () => {},
};

export function reconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_INITIAL_DELAY_MS * 2 ** (attempt - 1), RECONNECT_MAXIMUM_DELAY_MS);
}

export class ConnectionUnavailable extends UserFacingError {
  override readonly summary = "Not connected to the background service.";

  constructor() {
    super("connection unavailable", {
      recoverySuggestion: "Your terminals are still running. This will reconnect on its own.",
    });
  }
}

export class RequestFailed extends UserFacingError {
  override readonly summary: string;
  readonly failure: UserFacingFailure;

  constructor(failure: UserFacingFailure) {
    super(`request failed: ${failure.summary}`, presentationOf(failure));
    this.summary = failure.summary;
    this.failure = failure;
  }
}

class RefusedAfterHandshake extends Error {
  readonly refusal: HandshakeRefusal;

  constructor(refusal: HandshakeRefusal) {
    super("refused after handshake");
    this.name = "RefusedAfterHandshake";
    this.refusal = refusal;
  }
}

function timerDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, milliseconds);

  const onAbort = (): void => {
    clearTimeout(timer);
    resolve();
  };

  signal.addEventListener("abort", onAbort, { once: true });
  void promise.finally(() => {
    signal.removeEventListener("abort", onAbort);
  });

  return promise;
}

function presentationOf(failure: UserFacingFailure): Presentation {
  const presentation: MutablePresentation = {};

  if (failure.reason !== undefined) presentation.reason = failure.reason;

  if (failure.recoverySuggestion !== undefined) {
    presentation.recoverySuggestion = failure.recoverySuggestion;
  }

  return presentation;
}

async function closeQuietly(transport: MessageTransport): Promise<void> {
  await Effect.runPromise(Effect.ignore(Effect.tryPromise(() => transport.close())));
}

function errorName(cause: unknown): string {
  return cause instanceof Error ? cause.name : "unknown";
}

export function createConnection(options: {
  readonly openTransport: () => MessageTransport | Promise<MessageTransport>;
  readonly clientName: string;
  readonly mirror: MirrorApplying;
  readonly log?: Logger;
  readonly delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly handshakeDeadlineMs?: number;
}): DaemonConnection {
  const { openTransport, mirror } = options;
  const log = options.log ?? silentLogger;
  const delay = options.delay ?? timerDelay;
  const handshakeDeadlineMs = options.handshakeDeadlineMs ?? HANDSHAKE_DEADLINE_MS;

  const hello: Hello = {
    protocolVersion: PROTOCOL_VERSION,
    minimumSupported: MINIMUM_SUPPORTED_VERSION,
    clientName: options.clientName,
  };

  let status: ConnectionStatus = { kind: "idle" };
  const listeners = new Set<() => void>();

  const pending = new Map<
    RequestID,
    { resolve: (text: string | undefined) => void; reject: (error: Error) => void }
  >();

  const outputHandlers = new Map<TerminalID, Set<(bytes: Uint8Array) => void>>();
  const attentionHandlers = new Set<(signal: AttentionSignal) => void>();

  let current: { readonly transport: MessageTransport; readonly generation: number } | undefined;
  let generation = 0;
  let controller: AbortController | undefined;
  let loop: Promise<void> | undefined;
  let attempt = 0;
  let nextID = 0;
  let firstAttempt: (() => void) | undefined;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const setStatus = (next: ConnectionStatus): void => {
    status = next;

    if (next.kind === "reconnecting") {
      log.debug("connection status", { kind: next.kind, attempt: next.attempt });
    } else if (next.kind === "refused") {
      log.debug("connection status", { kind: next.kind, refusal: next.refusal.kind });
    } else {
      log.debug("connection status", { kind: next.kind });
    }

    notify();
  };

  const settleFirst = (): void => {
    const resolve = firstAttempt;
    firstAttempt = undefined;
    resolve?.();
  };

  const teardown = (reason: string): void => {
    const active = current;
    current = undefined;

    if (active !== undefined) {
      void active.transport.close().catch((cause: unknown) => {
        log.debug("transport close failed", { error: errorName(cause) });
      });
    }

    if (pending.size > 0) {
      const waiting = [...pending.values()];
      pending.clear();

      for (const request of waiting) request.reject(new ConnectionUnavailable());
    }

    log.debug("connection torn down", { reason });
    mirror.markStale();
    notify();
  };

  const settle = (id: RequestID, text: string | undefined): void => {
    const waiting = pending.get(id);

    if (waiting === undefined) {
      log.debug("reply for unknown request", { id });

      return;
    }

    pending.delete(id);
    waiting.resolve(text);
  };

  const failSend = (cause: unknown): void => {
    log.info("send failed", { error: errorName(cause) });
    const transport = current?.transport;

    if (transport !== undefined) void closeQuietly(transport);
  };

  const request = (message: ClientRequest): Promise<string | undefined> => {
    const active = current;

    if (active === undefined || status.kind !== "connected") {
      return Promise.reject(new ConnectionUnavailable());
    }

    if (message.type === "resize") {
      return active.transport.send(encodeClientMessage(message)).then(
        () => undefined,
        (cause: unknown) => {
          failSend(cause);
          throw new ConnectionUnavailable();
        },
      );
    }

    nextID += 1;

    // SAFETY: `nextID` is a positive integer counter this connection owns, and `RequestID` brands a number nominally — the brand adds no representation the number does not already have.
    const id = nextID as RequestID;
    const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
    pending.set(id, { resolve, reject });
    const wire: ClientMessage = { ...message, id };
    active.transport.send(encodeClientMessage(wire)).catch((cause: unknown) => {
      pending.delete(id);
      reject(new ConnectionUnavailable());
      failSend(cause);
    });

    return promise;
  };

  const handleFrame = (frame: Frame, mine: number): void => {
    if (current?.generation !== mine) return;

    if (frame.kind === FrameKind.Control) {
      const message: DaemonMessage = decodeDaemonMessage(frame);

      Match.value(message).pipe(
        Match.when({ type: "state" }, (stated) => {
          mirror.apply(stated.update);

          if (stated.update.isFullSnapshot) notify();
        }),
        Match.when({ type: "acknowledged" }, (acknowledged) => {
          settle(acknowledged.id, undefined);
        }),
        Match.when({ type: "text" }, (answered) => {
          settle(answered.id, answered.text);
        }),
        Match.when({ type: "failed" }, (failed) => {
          const waiting = pending.get(failed.id);

          if (waiting === undefined) {
            log.debug("reply for unknown request", { id: failed.id });

            return;
          }

          pending.delete(failed.id);
          waiting.reject(new RequestFailed(failed.failure));
        }),
        Match.when({ type: "attention" }, (attention) => {
          for (const handler of attentionHandlers) handler(attention.signal);
        }),
        Match.when({ type: "terminalExited" }, (exited) => {
          mirror.apply({
            projects: [],
            sessions: [],
            terminalStates: { [exited.terminalID]: { kind: "exited", code: exited.code } },
            isFullSnapshot: false,
          });
        }),
        Match.when({ type: "refused" }, (refused) => {
          throw new RefusedAfterHandshake(refused.refusal);
        }),
        Match.when({ type: "hello" }, () => {
          log.warning("second hello");

          throw new Error("protocol violation");
        }),
        Match.exhaustive,
      );

      return;
    }

    const output = decodeOutput(frame);
    const handlers = outputHandlers.get(output.terminalID);

    if (handlers === undefined || handlers.size === 0) {
      if (mirror.hasTerminal(output.terminalID)) {
        log.debug("output for unwatched terminal", { terminalID: output.terminalID });

        return;
      }

      throw new FrameError({ reason: new UnknownTerminalFrame({ terminalID: output.terminalID }) });
    }

    for (const handler of handlers) handler(output.bytes);
  };

  const logLoss = (cause: unknown): void => {
    if (cause instanceof FrameError) {
      log.warning(
        "connection lost",
        Predicate.isTagged(cause.reason, "unknownTerminal")
          ? { error: frameErrorLabel(cause), terminalID: cause.reason.terminalID }
          : { error: frameErrorLabel(cause) },
      );

      return;
    }

    log.info("connection lost", { error: errorName(cause) });
  };

  const attemptOnce = async (signal: AbortSignal): Promise<AttemptOutcome> => {
    if (attempt === 0) setStatus({ kind: "connecting" });

    const opened = await Effect.runPromise(
      Effect.result(
        Effect.tryPromise({ try: async () => openTransport(), catch: (cause) => cause }),
      ),
    );

    if (Result.isFailure(opened)) {
      log.warning("transport unavailable", { attempt, error: errorName(opened.failure) });

      return "failed";
    }

    const transport = opened.success;

    if (signal.aborted) {
      void transport.close().catch(() => {});

      return "failed";
    }

    generation += 1;
    const mine = generation;
    current = { transport, generation: mine };
    const iterator = transport.incoming()[Symbol.asyncIterator]();

    let handshakeTimedOut = false;

    const handshakeDeadline = setTimeout(() => {
      handshakeTimedOut = true;
      void closeQuietly(transport);
    }, handshakeDeadlineMs);

    const greeted = await Effect.runPromise(
      Effect.result(
        Effect.tryPromise({
          try: async () => {
            await transport.send(encodeClientMessage({ type: "hello", hello }));

            return await iterator.next();
          },
          catch: (cause) => cause,
        }),
      ),
    );

    clearTimeout(handshakeDeadline);

    if (Result.isFailure(greeted)) {
      if (handshakeTimedOut) {
        log.warning("handshake timed out", { attempt });
        teardown("handshake timed out");

        return "failed";
      }

      log.warning("handshake failed", { error: errorName(greeted.failure) });
      teardown("handshake failed");

      return "failed";
    }

    const first = greeted.success;

    if (first.done === true) {
      if (handshakeTimedOut) {
        log.warning("handshake timed out", { attempt });
        teardown("handshake timed out");

        return "failed";
      }

      log.info("connection closed before hello");
      teardown("closed before hello");

      return "failed";
    }

    if (first.value.kind !== FrameKind.Control) {
      log.warning("unexpected first frame", { kind: first.value.kind });
      teardown("unexpected first frame");

      return "failed";
    }

    const decoded = Result.try({
      try: () => decodeDaemonMessage(first.value),
      catch: (cause) => cause,
    });

    if (Result.isFailure(decoded)) {
      log.warning("malformed hello", { error: errorName(decoded.failure) });
      teardown("malformed hello");

      return "failed";
    }

    const greeting = decoded.success;

    if (greeting.type === "refused") {
      log.notice("handshake refused", { refusal: greeting.refusal.kind });
      setStatus({ kind: "refused", refusal: greeting.refusal });
      teardown("refused");

      return "refused";
    }

    if (greeting.type !== "hello") {
      log.warning("unexpected first message", { type: greeting.type });
      teardown("unexpected first message");

      return "failed";
    }

    if (!isCompatible(hello, greeting.hello)) {
      const refusal: HandshakeRefusal = {
        kind: "incompatibleVersion",
        daemonMinimum: greeting.hello.minimumSupported,
        daemonCurrent: greeting.hello.protocolVersion,
      };

      log.notice("daemon version incompatible", {
        daemonMinimum: refusal.daemonMinimum,
        daemonCurrent: refusal.daemonCurrent,
      });
      setStatus({ kind: "refused", refusal });
      teardown("incompatible version");

      return "refused";
    }

    attempt = 0;
    setStatus({ kind: "connected" });
    log.info("connected", { clientName: greeting.hello.clientName });

    settleFirst();

    void request({ type: "subscribe", scope: { kind: "state" } }).catch((cause: unknown) => {
      log.warning("subscribe failed", { error: errorName(cause) });
    });

    const pumped = await Effect.runPromise(
      Effect.result(
        Effect.tryPromise({
          try: async () => {
            for (;;) {
              // oxlint-disable-next-line no-await-in-loop
              const next = await iterator.next();

              if (next.done === true) return;

              handleFrame(next.value, mine);
            }
          },
          catch: (cause) => cause,
        }),
      ),
    );

    if (Result.isFailure(pumped)) {
      const cause = pumped.failure;

      if (cause instanceof RefusedAfterHandshake) {
        log.notice("handshake refused", { refusal: cause.refusal.kind });
        setStatus({ kind: "refused", refusal: cause.refusal });
        teardown("refused");

        return "refused";
      }

      logLoss(cause);
    } else {
      log.info("connection lost", { reason: "closed" });
    }

    teardown("connection lost");

    return "lost";
  };

  const run = async (signal: AbortSignal): Promise<void> => {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop
      const outcome = await attemptOnce(signal);
      settleFirst();

      if (signal.aborted || outcome === "refused") return;

      attempt += 1;
      setStatus({ kind: "reconnecting", attempt });
      // oxlint-disable-next-line no-await-in-loop
      await delay(reconnectDelay(attempt), signal);

      if (signal.aborted) return;
    }
  };

  return {
    get status(): ConnectionStatus {
      return status;
    },
    get isStale(): boolean {
      return mirror.isStale;
    },

    connect(): Promise<void> {
      if (controller !== undefined) return Promise.resolve();

      attempt = 0;
      const started = Promise.withResolvers<void>();
      firstAttempt = started.resolve;
      const created = new AbortController();
      controller = created;
      loop = run(created.signal).catch((cause: unknown) => {
        log.error("connection loop failed", { error: errorName(cause) });
        settleFirst();
      });

      return started.promise;
    },

    request,

    sendInput(bytes: Uint8Array, terminalID: TerminalID): void {
      const active = current;

      if (active === undefined || status.kind !== "connected") return;

      void active.transport.send(encodeInput({ terminalID, bytes })).catch(failSend);
    },

    onOutput(terminalID: TerminalID, handler: (bytes: Uint8Array) => void): () => void {
      let handlers = outputHandlers.get(terminalID);

      if (handlers === undefined) {
        handlers = new Set();
        outputHandlers.set(terminalID, handlers);
      }

      const registered = handlers;
      registered.add(handler);

      return () => {
        registered.delete(handler);

        if (registered.size === 0) outputHandlers.delete(terminalID);
      };
    },

    onAttention(handler: (signal: AttentionSignal) => void): () => void {
      attentionHandlers.add(handler);

      return () => {
        attentionHandlers.delete(handler);
      };
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },

    async disconnect(): Promise<void> {
      if (controller === undefined) return;

      controller.abort();
      teardown("disconnected");
      setStatus({ kind: "idle" });
      settleFirst();
      await loop;
      controller = undefined;
      loop = undefined;
    },
  };
}
