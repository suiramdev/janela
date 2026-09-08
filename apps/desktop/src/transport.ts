import { encodeFrame, frameDecoder, type Frame, type MessageTransport } from "@janela/protocol";
import { invoke } from "@tauri-apps/api/core";

/**
 * The Tauri-IPC transport.
 *
 * ## Why this exists at all
 *
 * **A WebView cannot open a Unix socket.** So the Rust shell opens it, and this
 * relays frames across Tauri's IPC boundary. From `@janela/client`'s point of view
 * it is just a `MessageTransport`, which is the entire reason that package is
 * transport-agnostic.
 *
 * This file is the concrete cost of the Tauri decision and the concrete proof the
 * seam is real: a browser client replaces exactly this file with a WebSocket
 * implementation and changes nothing above it. See
 * docs/decisions/0023-macos-first-portable.md.
 *
 * ## The one performance rule
 *
 * Terminal frames are the hot path and they now cross an extra boundary. Tauri's
 * IPC can carry raw bytes without a JSON round-trip, and it must: base64 through
 * IPC would inflate every repaint by a third and add two passes per frame, which is
 * exactly the mistake ADR 0016 refused to make on the socket. So a frame goes out
 * as the invoke's *whole body* and comes back as an `ArrayBuffer`, and the
 * connection id travels in a header — the moment it joined the body, every repaint
 * would be inside a JSON object. The budget is in docs/performance.md § Terminal
 * throughput.
 *
 * ## Back-pressure and reconnection are not here
 *
 * Back-pressure is the shell's, where the two policies live: coalesced repaints may
 * drop their oldest, control frames and input may not. Input has no queue at all —
 * `bridge_send` awaits the socket write, so the promise this returns *is* the
 * back-pressure.
 *
 * Reconnection is `@janela/client`'s (#28): it counts the attempt, applies the
 * backoff, and calls `openTauriTransport` again. The shell makes one connect
 * attempt and never retries — two retry loops in two languages is one too many.
 */

/** Names the connection a `bridge_send` belongs to. Mirrors `CONNECTION_HEADER`. */
export const CONNECTION_HEADER = "x-janela-connection";

/**
 * The invoke seam.
 *
 * Injected so this file's tests run without a Tauri runtime — and so a test can
 * assert the exact bytes handed to the boundary, which is the only way to prove a
 * payload crosses it unmodified.
 */
export type BridgeInvoke = typeof invoke;

/**
 * A bridge command's refusal, as an `Error` carrying its reason as the name.
 *
 * Tauri rejects with the raw string the Rust side returned, and every logger in
 * `@janela/client` reduces a thrown value to `error.name` — so an unwrapped
 * rejection is logged as `"unknown"` and the reason is lost exactly where it
 * would have been useful. The reason set is closed and ours (`bridge.rs`), so it
 * is safe as a log field: it is never peer-supplied text.
 */
export class BridgeRefused extends Error {
  constructor(reason: string) {
    super("the bridge refused");
    this.name = reason;
  }
}

/** Whatever a bridge command rejected with, as an `Error`. */
function refusal(thrown: unknown): Error {
  if (thrown instanceof Error) return thrown;
  return new BridgeRefused(typeof thrown === "string" ? thrown : "bridge-failed");
}

/**
 * Opens one connection through the Rust shell.
 *
 * @throws {BridgeRefused} when the daemon is not answering. A failed attempt like
 *   any other, as far as `createConnection` is concerned; the shell has already
 *   asked launchd to start the daemon, and the client's backoff decides when to
 *   try again.
 */
export async function openTauriTransport(
  invokeFn: BridgeInvoke = invoke,
): Promise<MessageTransport> {
  const id = await invokeFn<number>("bridge_connect").catch((thrown: unknown) => {
    throw refusal(thrown);
  });
  const headers = { [CONNECTION_HEADER]: String(id) };
  let closed = false;

  return {
    async send(frame: Frame): Promise<void> {
      // The encoded frame is the entire body. No wrapper object, so no base64.
      await invokeFn<void>("bridge_send", encodeFrame(frame), { headers }).catch(
        (thrown: unknown) => {
          throw refusal(thrown);
        },
      );
    },

    async *incoming(): AsyncGenerator<Frame> {
      // One decoder per transport: a decoder that has thrown is finished, and a
      // reconnect gets a new transport rather than a reset one.
      const decoder = frameDecoder();
      for (;;) {
        // A long poll: the next one exists only because this one returned, and
        // there is nothing to run in parallel with it.
        // oxlint-disable-next-line no-await-in-loop
        const buffer = await invokeFn<ArrayBuffer>("bridge_receive", { id }).catch(
          (thrown: unknown) => {
            // A severed bridge, and the reason — `bridge-stalled` — is the shape
            // worth having in the log the user sends us.
            throw refusal(thrown);
          },
        );
        if (buffer.byteLength === 0) {
          // Zero bytes is the shell saying the socket ended. `end()` throws
          // `truncated` if a frame was in flight, which is exactly the
          // distinction `MessageTransport` documents: a clean close finishes the
          // sequence, a dirty one throws.
          decoder.end();
          return;
        }
        yield* decoder.push(new Uint8Array(buffer));
      }
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // Swallowed: the connection may already be gone, and `close` is the caller
      // saying it no longer cares. This is also what unblocks the shell's parked
      // `bridge_receive`, which is how `incoming()` finishes.
      await invokeFn<void>("bridge_close", { id }).catch(() => {});
    },
  };
}
