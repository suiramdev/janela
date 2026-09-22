import { log } from "@janela/support";
import { Effect, Option } from "effect";

import type { Clipboard } from "../../model/index.ts";

export function browserClipboard(): Clipboard {
  const clipboardLog = log("app");

  return {
    async copy(text: string): Promise<void> {
      const written = await Effect.runPromise(
        Effect.option(Effect.tryPromise(() => navigator.clipboard.writeText(text))),
      );

      if (Option.isNone(written)) {
        clipboardLog.warning("clipboard write refused", { length: text.length });
      }
    },

    async paste(): Promise<string | undefined> {
      const read = await Effect.runPromise(
        Effect.option(Effect.tryPromise(() => navigator.clipboard.readText())),
      );

      if (Option.isNone(read)) {
        clipboardLog.warning("clipboard read refused", undefined);

        return undefined;
      }

      return read.value === "" ? undefined : read.value;
    },
  };
}
