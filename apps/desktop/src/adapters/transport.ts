import { encodeFrame, frameDecoder, type Frame, type MessageTransport } from "@janela/protocol";
import { invoke } from "@tauri-apps/api/core";
import { Predicate } from "effect";

export const CONNECTION_HEADER = "x-janela-connection";

export type BridgeInvoke = typeof invoke;

export class BridgeRefused extends Error {
  constructor(reason: string) {
    super("the bridge refused");
    this.name = reason;
  }
}

function refusal(cause: unknown): Error {
  if (cause instanceof Error) return cause;

  return new BridgeRefused(Predicate.isString(cause) ? cause : "bridge-failed");
}

export async function openTauriTransport(
  invokeFn: BridgeInvoke = invoke,
): Promise<MessageTransport> {
  const id = await invokeFn<number>("bridge_connect").catch((cause: unknown) => {
    throw refusal(cause);
  });

  const headers = { [CONNECTION_HEADER]: String(id) };
  let closed = false;

  return {
    async send(frame: Frame): Promise<void> {
      await invokeFn<void>("bridge_send", encodeFrame(frame), { headers }).catch(
        (cause: unknown) => {
          throw refusal(cause);
        },
      );
    },

    async *incoming(): AsyncGenerator<Frame> {
      const decoder = frameDecoder();

      for (;;) {
        // oxlint-disable-next-line no-await-in-loop
        const buffer = await invokeFn<ArrayBuffer>("bridge_receive", { id }).catch(
          (cause: unknown) => {
            throw refusal(cause);
          },
        );

        if (buffer.byteLength === 0) {
          decoder.end();

          return;
        }

        yield* decoder.push(new Uint8Array(buffer));
      }
    },

    async close(): Promise<void> {
      if (closed) return;

      closed = true;
      await invokeFn<void>("bridge_close", { id }).catch(() => {});
    },
  };
}
