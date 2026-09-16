import type { Command, CommandID } from "../../config/index.ts";
import type { CommandSource } from "../../model/index.ts";

export interface KeyChord {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly code: string;
}

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

interface ParsedAccelerator {
  readonly shift: boolean;
  readonly alt: boolean;
  readonly code: string;
}

const CAPTURE = { capture: true } as const;

const KEY_CODES = {
  ",": "Comma",
  "[": "BracketLeft",
  "]": "BracketRight",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  Up: "ArrowUp",
  Down: "ArrowDown",
} satisfies Record<string, string>;

const MODIFIERS = {
  CmdOrCtrl: "meta",
  Shift: "shift",
  Alt: "alt",
} satisfies Record<string, "meta" | "shift" | "alt">;

function isNamedKey(token: string): token is keyof typeof KEY_CODES {
  return Object.hasOwn(KEY_CODES, token);
}

function isModifier(token: string): token is keyof typeof MODIFIERS {
  return Object.hasOwn(MODIFIERS, token);
}

function keyCode(token: string): string | undefined {
  if (isNamedKey(token)) return KEY_CODES[token];

  return /^[A-Z]$/.test(token) ? `Key${token}` : undefined;
}

function parseAccelerator(accelerator: string): ParsedAccelerator | undefined {
  const tokens = accelerator.split("+");
  const key = tokens.at(-1);

  if (key === undefined) return undefined;

  const code = keyCode(key);

  if (code === undefined) return undefined;

  let meta = false;
  let shift = false;
  let alt = false;

  for (const token of tokens.slice(0, -1)) {
    if (!isModifier(token)) return undefined;

    const modifier = MODIFIERS[token];

    if (modifier === "meta") meta = true;

    if (modifier === "shift") shift = true;

    if (modifier === "alt") alt = true;
  }

  return meta ? { shift, alt, code } : undefined;
}

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
  commands: readonly Command[],
  held: () => boolean,
): CommandSource {
  return {
    subscribe(listener: (id: CommandID) => void): () => void {
      const onKeyDown = (event: ChordEvent): void => {
        const id = commandForChord(event, commands);

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
