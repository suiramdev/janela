import type { TerminalID } from "@janela/core";
import {
  FrameError,
  FrameKind,
  MINIMUM_SUPPORTED_VERSION,
  PROTOCOL_VERSION,
  decodeDaemonMessage,
  decodeOutput,
  encodeClientMessage,
  encodeInput,
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
import { UserFacingError, type Logger } from "@janela/support";

import type { MirrorApplying } from "./stores.ts";

/**
 * A client's connection to `janelad`, and the mirrored state it produces.
 *
 * ## The one rule
 *
 * **The daemon is the truth; this is a mirror.** Nothing here computes state it
 * could ask for, and nothing writes state it did not receive. A client that infers
 * — "I sent input, so it must be running" — is guessing about a process in another
 * process. See docs/decisions/0015-daemon-owned-sessions.md § Rules.
 *
 * ## Disconnection is normal
 *
 * The daemon may be restarting, upgrading, or briefly gone. Views keep rendering the
 * last known mirror with `isStale` set; nothing blocks and nothing is discarded.
 * Terminals are unaffected either way — they are in the daemon, and they kept
 * running.
 *
 * ## Why this package knows nothing about Tauri
 *
 * It takes a `MessageTransport`. The desktop app supplies one backed by the Rust
 * shell's Unix socket, because a WebView cannot open one itself; a browser client
 * would supply one backed by a WebSocket. That is the seam that makes a browser
 * client a transport rather than a rewrite, and it is the only reason this package
 * is allowed to be as abstract as it is. See
 * docs/decisions/0023-macos-first-portable.md.
 */
export interface DaemonConnection {
  readonly status: ConnectionStatus;

  /**
   * True when the mirror predates the current connection.
   *
   * Delegates to `MirrorApplying.isStale`: one source, so the reconnecting strip
   * cannot claim fresh state while the sidebar renders old sessions.
   */
  readonly isStale: boolean;

  /**
   * Connects, handshakes, and subscribes.
   *
   * Never called on the launch path in a way that blocks first paint: the window
   * draws its empty or last-known state and fills in when this resolves. See
   * docs/performance.md § Launch.
   *
   * Resolves when the *first* attempt settles — connected, reconnecting or refused
   * — and never rejects: the outcome is `status`, which a view is already
   * subscribed to. A caller that awaited "connected" would be a caller that
   * blocks while the daemon is down, which is the thing this design refuses to do.
   * Idempotent: a second call while a loop is running does nothing.
   */
  connect(): Promise<void>;

  /**
   * Sends a request and waits for its reply.
   *
   * Every mutation is a request with a reply, because fire-and-forget mutation is
   * how a mirror silently diverges from the truth.
   *
   * Resolves with the reply's payload when it has one — `snapshotText` answers
   * with `text`, and dropping it would be silent data loss — and `undefined` for
   * an `acknowledged`. Rejects with `RequestFailed` when the daemon answered
   * `failed`, and with `ConnectionUnavailable` when there is no connection or it
   * died before the reply arrived. Nothing is queued while disconnected: a UI
   * action taken during a reconnect fails fast rather than landing minutes later.
   */
  request(message: ClientRequest): Promise<string | undefined>;

  /**
   * Keyboard input for an attached terminal.
   *
   * The one message with no reply: a round trip per keystroke would be absurd, and
   * the echo is the reply. Bytes, not a string — a client that decodes input to
   * UTF-8 and re-encodes it has corrupted every paste that was not valid UTF-8.
   */
  sendInput(bytes: Uint8Array, terminalID: TerminalID): void;

  /**
   * Where repaint bytes for an attached terminal arrive.
   *
   * `bytes` is a *view* into the frame being decoded and is valid only for the
   * duration of the call. A renderer that keeps it must copy it; one that feeds it
   * straight into an emulator must not. Same rule as `TerminalBytes` in
   * `@janela/pty`, and for the same reason: this is the hot path and a copy per
   * repaint per client is a copy nobody asked for.
   */
  onOutput(terminalID: TerminalID, handler: (bytes: Uint8Array) => void): () => void;

  /**
   * Where attention signals arrive, on their way to `AttentionPolicy`.
   *
   * A fact from the daemon, undecided: whether it interrupts anybody is the
   * policy's call, and the policy needs focus state this layer does not have.
   */
  onAttention(handler: (signal: AttentionSignal) => void): () => void;

  /**
   * Notified when `status` or `isStale` changes.
   *
   * Same shape as the stores' `subscribe`, so a view observes the connection and
   * the mirror the same way.
   */
  subscribe(listener: () => void): () => void;

  disconnect(): Promise<void>;
}

/**
 * A request as a caller writes it: the connection assigns the correlation id.
 *
 * The id is per-connection state — it is only meaningful to the peer that will
 * answer it — so a caller that minted its own would be reaching into the
 * connection's bookkeeping. `resize` keeps its shape: it has no id because it has
 * no reply.
 */
export type ClientRequest =
  Exclude<ClientMessage, { readonly type: "hello" }> extends infer Message
    ? Message extends { readonly id: RequestID }
      ? Omit<Message, "id">
      : Message
    : never;

export type ConnectionStatus =
  /** No connection yet, or deliberately disconnected. */
  | { readonly kind: "idle" }
  | { readonly kind: "connecting" }
  /** Connected, handshake complete, receiving state. */
  | { readonly kind: "connected" }
  /** Connection lost; retrying with backoff. The mirror is still rendered. */
  | { readonly kind: "reconnecting"; readonly attempt: number }
  /**
   * The daemon refused us and retrying will not help. Almost always a version
   * mismatch after an app update, which needs a human decision — never an automatic
   * daemon restart, because that kills live terminals.
   */
  | { readonly kind: "refused"; readonly refusal: HandshakeRefusal };

/** Delay before the first retry. */
export const RECONNECT_INITIAL_DELAY_MS = 250;

/** Ceiling on the backoff. A user who wakes a laptop waits at most this long. */
export const RECONNECT_MAXIMUM_DELAY_MS = 10_000;

/**
 * Delay before retry `attempt` (1-based): 250, 500, 1000, … capped at 10 s.
 *
 * No jitter: there is one client per user per daemon, so there is no thundering
 * herd to spread out, and jitter would only make a test non-deterministic.
 */
export function reconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_INITIAL_DELAY_MS * 2 ** (attempt - 1), RECONNECT_MAXIMUM_DELAY_MS);
}

/** There is no connection, or it died before the reply arrived. */
export class ConnectionUnavailable extends UserFacingError {
  override readonly summary = "Not connected to the background service.";

  constructor() {
    super("connection unavailable", {
      recoverySuggestion: "Your terminals are still running. This will reconnect on its own.",
    });
  }
}

/**
 * The daemon answered a request with `failed`.
 *
 * Carries the wire failure through unchanged: the daemon already decided what is
 * safe to show a person, and re-deciding here would either lose that or invent it.
 */
export class RequestFailed extends UserFacingError {
  override readonly summary: string;
  readonly failure: UserFacingFailure;

  constructor(failure: UserFacingFailure) {
    // Only defined keys: `exactOptionalPropertyTypes` makes `{ reason: undefined }`
    // a different thing from an absent `reason`.
    const presentation: { reason?: string; recoverySuggestion?: string } = {};
    if (failure.reason !== undefined) presentation.reason = failure.reason;
    if (failure.recoverySuggestion !== undefined) {
      presentation.recoverySuggestion = failure.recoverySuggestion;
    }
    super(`request failed: ${failure.summary}`, presentation);
    this.summary = failure.summary;
    this.failure = failure;
  }
}

/**
 * A `refused` that arrived *after* the handshake.
 *
 * Thrown out of the frame pump so one place decides what a refusal means: status
 * `refused`, no retry. Module-private — it never leaves this file, because a
 * caller has `ConnectionStatus` to read instead.
 */
class RefusedAfterHandshake extends Error {
  readonly refusal: HandshakeRefusal;

  constructor(refusal: HandshakeRefusal) {
    super("refused after handshake");
    this.name = "RefusedAfterHandshake";
    this.refusal = refusal;
  }
}

/**
 * The default when a caller injects nothing, for the same reason `nullLogSink`
 * is: a library must not decide the format for a process that has not asked.
 */
const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  notice: () => {},
  warning: () => {},
  error: () => {},
};

/**
 * The one clock, injected so backoff is deterministic in tests.
 *
 * Resolves early rather than rejecting when `signal` aborts: a cancelled wait is
 * not an error, and a rejection here would have to be caught in the one place
 * that already knows to check `signal.aborted`.
 */
function timerDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, milliseconds);
  const onAbort = (): void => {
    clearTimeout(timer);
    resolve();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  // Released either way: a reconnect loop that ran for an hour must not have left
  // an hour's worth of listeners on the one signal it shares.
  void promise.finally(() => {
    signal.removeEventListener("abort", onAbort);
  });
  return promise;
}

/**
 * Closes a transport and swallows whatever that produces.
 *
 * A close that fails changes nothing: the connection is already over, and the
 * pump ends either way.
 */
async function closeQuietly(transport: MessageTransport): Promise<void> {
  try {
    await transport.close();
  } catch {
    // Nothing to do and nobody to tell.
  }
}

/** A thrown value reduced to something safe to log. Never the message. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

/** What one connection attempt ended as. */
type AttemptOutcome =
  /** The transport ended or failed. Retry. */
  | "lost"
  /** Never connected. Retry. */
  | "failed"
  /** The daemon said no, and will say no again. Terminal until the user acts. */
  | "refused";

export function createConnection(options: {
  /**
   * Opens one transport, once per attempt.
   *
   * A factory rather than a transport, because *this* package owns the retry: it
   * counts the attempt, applies the backoff and re-subscribes, so the Rust shell
   * must not reconnect on its own (#30). `incoming()` must finish or throw when
   * the socket does — that is how a lost connection is noticed — and a factory
   * that throws is a failed attempt like any other.
   */
  readonly openTransport: () => MessageTransport | Promise<MessageTransport>;
  readonly clientName: string;
  /** Where `state` updates land. The pump has to write somewhere. */
  readonly mirror: MirrorApplying;
  readonly log?: Logger;
  readonly delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}): DaemonConnection {
  const { openTransport, mirror } = options;
  const log = options.log ?? silentLogger;
  const delay = options.delay ?? timerDelay;

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

  /** The live transport, tagged so a stale pump cannot touch the mirror. */
  let current: { readonly transport: MessageTransport; readonly generation: number } | undefined;
  let generation = 0;
  let controller: AbortController | undefined;
  let loop: Promise<void> | undefined;
  let attempt = 0;
  /** Correlation ids, per connection object. Never reused across reconnects. */
  let nextID = 0;
  /** Resolves the promise `connect()` returned, once the first attempt settles. */
  let firstAttempt: (() => void) | undefined;

  const notify = (): void => {
    // `Set` iteration tolerates removal: a listener that unsubscribes itself
    // during the walk is simply not visited again.
    for (const listener of listeners) listener();
  };

  const setStatus = (next: ConnectionStatus): void => {
    status = next;
    if (next.kind === "reconnecting") {
      log.debug("connection status", { kind: next.kind, attempt: next.attempt });
    } else if (next.kind === "refused") {
      // The refusal's kind, never its numbers' provenance or a payload.
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

  /**
   * Drops the current transport and everything waiting on it.
   *
   * Closing is what makes the old pump finish, which is why a send failure needs
   * no retry loop of its own. Every in-flight request fails: the protocol has no
   * request timeout, so a caller left waiting on a dead connection waits forever.
   */
  const teardown = (reason: string): void => {
    const active = current;
    current = undefined;
    if (active !== undefined) {
      void active.transport.close().catch((error: unknown) => {
        log.debug("transport close failed", { error: errorName(error) });
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

  /**
   * A failed write is a dead transport.
   *
   * Closing it routes the failure into the pump, which is the one place that
   * reconnects — a second retry path here would be a second policy to keep in
   * agreement with the first.
   */
  const failSend = (error: unknown): void => {
    log.info("send failed", { error: errorName(error) });
    const transport = current?.transport;
    if (transport !== undefined) void closeQuietly(transport);
  };

  const request = (message: ClientRequest): Promise<string | undefined> => {
    const active = current;
    if (active === undefined || status.kind !== "connected") {
      return Promise.reject(new ConnectionUnavailable());
    }

    if (message.type === "resize") {
      // No id, no reply: the size negotiation is the daemon's, and the next
      // repaint is the answer.
      return active.transport.send(encodeClientMessage(message)).then(
        () => undefined,
        (error: unknown) => {
          failSend(error);
          throw new ConnectionUnavailable();
        },
      );
    }

    nextID += 1;
    const id = nextID as RequestID;
    const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
    pending.set(id, { resolve, reject });
    const wire: ClientMessage = { ...message, id };
    active.transport.send(encodeClientMessage(wire)).catch((error: unknown) => {
      pending.delete(id);
      reject(new ConnectionUnavailable());
      failSend(error);
    });
    return promise;
  };

  /**
   * Routes one frame.
   *
   * @throws whatever means "this connection is over": a malformed control frame,
   * a protocol violation, or an `Output` frame naming a terminal we do not hold.
   * Nothing here is fatal to anything but the connection.
   */
  const handleFrame = (frame: Frame, mine: number): void => {
    // A frame from a connection we have already torn down. It cannot be allowed
    // to touch the mirror: half a state update from a dead daemon merged into a
    // fresh snapshot is exactly the corruption reconnect exists to avoid.
    if (current?.generation !== mine) return;

    if (frame.kind === FrameKind.Control) {
      const message: DaemonMessage = decodeDaemonMessage(frame);
      switch (message.type) {
        case "state": {
          mirror.apply(message.update);
          // A full snapshot cleared `isStale`, which this connection publishes.
          if (message.update.isFullSnapshot) notify();
          return;
        }
        case "acknowledged":
          settle(message.id, undefined);
          return;
        case "text":
          settle(message.id, message.text);
          return;
        case "failed": {
          const waiting = pending.get(message.id);
          if (waiting === undefined) {
            log.debug("reply for unknown request", { id: message.id });
            return;
          }
          pending.delete(message.id);
          waiting.reject(new RequestFailed(message.failure));
          return;
        }
        case "attention": {
          // Deliberately unlogged. The signal carries a notification body, and
          // that is the user's private data (AGENTS.md non-negotiable 11) — not
          // even a count, because a count would tempt someone to add the title.
          for (const handler of attentionHandlers) handler(message.signal);
          return;
        }
        case "terminalExited": {
          // A received fact, merged the same way any other one is.
          mirror.apply({
            projects: [],
            sessions: [],
            terminalStates: { [message.terminalID]: { kind: "exited", code: message.code } },
            // Empty collections mean "unchanged" in a partial.
            launchProfiles: [],
            launchProfileAvailability: {},
            isFullSnapshot: false,
          });
          return;
        }
        case "refused":
          throw new RefusedAfterHandshake(message.refusal);
        case "hello":
          // The handshake is done; a second one means we are not talking to what
          // we think we are.
          log.warning("second hello");
          throw new Error("protocol violation");
      }
    }

    // `Input` from the daemon is a direction violation, and `decodeOutput` says so.
    const output = decodeOutput(frame);
    const handlers = outputHandlers.get(output.terminalID);
    if (handlers === undefined || handlers.size === 0) {
      if (mirror.hasTerminal(output.terminalID)) {
        // A detach race: cross-kind ordering is not guaranteed, so output for a
        // terminal we just detached from is in flight through no one's fault, and
        // re-attaching produces a full repaint that recovers anything dropped.
        log.debug("output for unwatched terminal", { terminalID: output.terminalID });
        return;
      }
      // A terminal we have never heard of. `frame.ts` names the client's mirror
      // as a receiver that must close the connection and never create it.
      throw new FrameError({ kind: "unknownTerminal", terminalID: output.terminalID });
    }
    for (const handler of handlers) handler(output.bytes);
  };

  const logLoss = (error: unknown): void => {
    if (error instanceof FrameError) {
      // The id is a shape, not content: it is what makes the log line actionable.
      log.warning(
        "connection lost",
        error.detail.kind === "unknownTerminal"
          ? { error: error.detail.kind, terminalID: error.detail.terminalID }
          : { error: error.detail.kind },
      );
      return;
    }
    log.info("connection lost", { error: errorName(error) });
  };

  const attemptOnce = async (signal: AbortSignal): Promise<AttemptOutcome> => {
    // On a retry the status is already `reconnecting { attempt }`, which says more
    // than `connecting` would.
    if (attempt === 0) setStatus({ kind: "connecting" });

    let transport: MessageTransport;
    try {
      transport = await openTransport();
    } catch (error) {
      log.warning("transport unavailable", { attempt, error: errorName(error) });
      return "failed";
    }

    if (signal.aborted) {
      void transport.close().catch(() => {});
      return "failed";
    }

    generation += 1;
    const mine = generation;
    current = { transport, generation: mine };
    const iterator = transport.incoming()[Symbol.asyncIterator]();

    try {
      await transport.send(encodeClientMessage({ type: "hello", hello }));
    } catch (error) {
      log.warning("hello not sent", { error: errorName(error) });
      teardown("hello not sent");
      return "failed";
    }

    let first: IteratorResult<Frame>;
    try {
      first = await iterator.next();
    } catch (error) {
      log.warning("handshake failed", { error: errorName(error) });
      teardown("handshake failed");
      return "failed";
    }

    if (first.done === true) {
      log.info("connection closed before hello");
      teardown("closed before hello");
      return "failed";
    }
    if (first.value.kind !== FrameKind.Control) {
      log.warning("unexpected first frame", { kind: first.value.kind });
      teardown("unexpected first frame");
      return "failed";
    }

    let greeting: DaemonMessage;
    try {
      greeting = decodeDaemonMessage(first.value);
    } catch (error) {
      log.warning("malformed hello", { error: errorName(error) });
      teardown("malformed hello");
      return "failed";
    }

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
      // Refused by *us*, and reported as the same fact the daemon would have
      // reported, so the view has one case to render and one sentence to say.
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

    // Connected: the next failure is attempt 1 again, not attempt 4.
    attempt = 0;
    setStatus({ kind: "connected" });
    log.info("connected", { clientName: greeting.hello.clientName });

    // `connect()` has its answer now. Waiting for the pump to finish would mean
    // resolving only once the connection *died*, which is the opposite promise.
    settleFirst();

    // Not awaited: the acknowledgement and the snapshot both arrive through the
    // pump below, and awaiting a reply before starting the pump would deadlock.
    void request({ type: "subscribe", scope: { kind: "state" } }).catch((error: unknown) => {
      log.warning("subscribe failed", { error: errorName(error) });
    });

    try {
      for (;;) {
        // One frame at a time, in order: the next read may not begin until this
        // frame has been handled, because the payload is a view into the buffer.
        // oxlint-disable-next-line no-await-in-loop
        const next = await iterator.next();
        if (next.done === true) break;
        handleFrame(next.value, mine);
      }
      log.info("connection lost", { reason: "closed" });
    } catch (error) {
      if (error instanceof RefusedAfterHandshake) {
        log.notice("handshake refused", { refusal: error.refusal.kind });
        setStatus({ kind: "refused", refusal: error.refusal });
        teardown("refused");
        return "refused";
      }
      logLoss(error);
    }

    teardown("connection lost");
    return "lost";
  };

  const run = async (signal: AbortSignal): Promise<void> => {
    for (;;) {
      // Attempts are sequential by definition: the next one exists only because
      // this one failed.
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
      // Idempotent. After `refused` the loop has returned but the controller is
      // still held, which is what makes a refusal terminal: the user acts by
      // calling `disconnect()` and then `connect()`.
      if (controller !== undefined) return Promise.resolve();

      attempt = 0;
      const started = Promise.withResolvers<void>();
      firstAttempt = started.resolve;
      const created = new AbortController();
      controller = created;
      loop = run(created.signal).catch((error: unknown) => {
        // A throw here is a bug in this file, not a connection outcome. It must
        // not become an unhandled rejection, and it must not wedge `connect()`.
        log.error("connection loop failed", { error: errorName(error) });
        settleFirst();
      });
      return started.promise;
    },

    request,

    sendInput(bytes: Uint8Array, terminalID: TerminalID): void {
      const active = current;
      // Dropped, and deliberately not logged: this is per-keystroke, and the
      // reconnecting strip is already saying what happened.
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
      // Closing the transport is what unblocks a pump parked on `next()`; the
      // abort alone would leave it waiting for a daemon that is not coming.
      teardown("disconnected");
      setStatus({ kind: "idle" });
      settleFirst();
      await loop;
      controller = undefined;
      loop = undefined;
    },
  };
}
