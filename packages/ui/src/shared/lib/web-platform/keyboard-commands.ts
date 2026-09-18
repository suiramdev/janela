import {
  type Command,
  type CommandID,
  type KeyChord,
  parseAccelerator,
} from "../../config/index.ts";
import type { CommandSource } from "../../model/index.ts";

export interface ChordEvent extends KeyChord {
  preventDefault(): void;
  stopPropagation(): void;
}

export interface ChordTarget {
  addEventListener(
    type: "keydown",
    listener: (event: ChordEvent) => void,
    options: { readonly capture: true },
  ): void;
  removeEventListener(
    type: "keydown",
    listener: (event: ChordEvent) => void,
    options: { readonly capture: true },
  ): void;
}

const CAPTURE = { capture: true } as const;

export function commandForChord(
  chord: KeyChord,
  commands: readonly Command[],
): CommandID | undefined {
  if (!chord.metaKey || chord.ctrlKey) return undefined;

  for (const command of commands) {
    if (command.accelerator === undefined) continue;

    const parsed = parseAccelerator(command.accelerator);

    if (parsed === undefined) continue;

    if (
      parsed.code === chord.code &&
      parsed.shift === chord.shiftKey &&
      parsed.alt === chord.altKey
    ) {
      return command.id;
    }
  }

  return undefined;
}

export function keyboardCommandSource(
  target: ChordTarget,
  commands: () => readonly Command[],
  held: () => boolean,
  isRecording: () => boolean,
): CommandSource {
  return {
    subscribe(listener: (id: CommandID) => void): () => void {
      const onKeyDown = (event: ChordEvent): void => {
        if (isRecording()) return;

        const id = commandForChord(event, commands());

        if (id === undefined) return;

        event.preventDefault();
        event.stopPropagation();

        if (!held()) listener(id);
      };

      target.addEventListener("keydown", onKeyDown, CAPTURE);

      return () => {
        target.removeEventListener("keydown", onKeyDown, CAPTURE);
      };
    },
  };
}
