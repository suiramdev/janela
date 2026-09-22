import { describe, expect, test } from "bun:test";

import { COMMANDS, type Command, type CommandID, type KeyChord } from "../../config/index.ts";
import {
  type ChordEvent,
  type ChordTarget,
  commandForChord,
  keyboardCommandSource,
} from "./keyboard-commands.ts";

interface Registration {
  readonly listener: (event: ChordEvent) => void;
  readonly options: { readonly capture: true };
}

interface RecordingTarget extends ChordTarget {
  readonly registered: Registration[];
}

const NEVER_RECORDING = (): boolean => false;

const NEVER_HELD = (): boolean => false;

const CHORD_FOR_ACCELERATOR = {
  "CmdOrCtrl+,": "Comma",
  "CmdOrCtrl+N": "KeyN",
  "CmdOrCtrl+T": "KeyT",
  "CmdOrCtrl+O": "KeyO",
  "CmdOrCtrl+Alt+O": "KeyO",
  "CmdOrCtrl+Shift+P": "KeyP",
  "CmdOrCtrl+Shift+O": "KeyO",
  "CmdOrCtrl+Shift+]": "BracketRight",
  "CmdOrCtrl+Shift+[": "BracketLeft",
  "CmdOrCtrl+D": "KeyD",
  "CmdOrCtrl+Shift+D": "KeyD",
  "CmdOrCtrl+Alt+Left": "ArrowLeft",
  "CmdOrCtrl+Alt+Right": "ArrowRight",
  "CmdOrCtrl+Alt+Up": "ArrowUp",
  "CmdOrCtrl+Alt+Down": "ArrowDown",
  "CmdOrCtrl+]": "BracketRight",
  "CmdOrCtrl+[": "BracketLeft",
  "CmdOrCtrl+W": "KeyW",
  "CmdOrCtrl+Shift+R": "KeyR",
  "CmdOrCtrl+Shift+K": "KeyK",
} satisfies Record<string, string>;

function isKnownAccelerator(
  accelerator: string,
): accelerator is keyof typeof CHORD_FOR_ACCELERATOR {
  return Object.hasOwn(CHORD_FOR_ACCELERATOR, accelerator);
}

function chordFor(accelerator: string): KeyChord {
  if (!isKnownAccelerator(accelerator)) throw new Error(`no chord listed for ${accelerator}`);

  const tokens = accelerator.split("+");

  return {
    metaKey: true,
    ctrlKey: false,
    altKey: tokens.includes("Alt"),
    shiftKey: tokens.includes("Shift"),
    code: CHORD_FOR_ACCELERATOR[accelerator],
  };
}

function chord(code: string, modifiers: Partial<KeyChord> = {}): KeyChord {
  return {
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    code,
    ...modifiers,
  };
}

function recordingTarget(): RecordingTarget {
  const registered: Registration[] = [];

  return {
    registered,
    addEventListener(_type, listener, options) {
      registered.push({ listener, options });
    },
    removeEventListener(_type, listener) {
      const index = registered.findIndex((entry) => entry.listener === listener);

      if (index >= 0) registered.splice(index, 1);
    },
  };
}

function event(pressed: KeyChord, calls: string[]): ChordEvent {
  return {
    ...pressed,
    preventDefault: () => calls.push("preventDefault"),
    stopPropagation: () => calls.push("stopPropagation"),
  };
}

describe("commandForChord", () => {
  test("every chord in the table is reachable from the keyboard", () => {
    for (const command of COMMANDS) {
      if (command.accelerator === undefined) continue;

      expect(commandForChord(chordFor(command.accelerator), COMMANDS)).toBe(command.id);
    }
  });

  test("shift tells the session bracket from the tab bracket", () => {
    expect(commandForChord(chord("BracketRight", { shiftKey: true }), COMMANDS)).toBe(
      "nextSession",
    );

    expect(commandForChord(chord("BracketRight"), COMMANDS)).toBe("nextTab");
  });

  test("control belongs to the program in the terminal", () => {
    expect(
      commandForChord(chord("BracketRight", { metaKey: false, ctrlKey: true }), COMMANDS),
    ).toBeUndefined();

    expect(commandForChord(chord("BracketRight", { ctrlKey: true }), COMMANDS)).toBeUndefined();
  });

  test("a bare key, or a key nobody bound, is nobody's command", () => {
    expect(commandForChord(chord("KeyT", { metaKey: false }), COMMANDS)).toBeUndefined();
    expect(commandForChord(chord("KeyZ"), COMMANDS)).toBeUndefined();
  });

  test("an accelerator it cannot spell is skipped rather than thrown on", () => {
    const odd: readonly Command[] = [
      { id: "closePane", title: "Odd", accelerator: "CmdOrCtrl+F13", menu: "terminal" },
    ];

    expect(commandForChord(chord("F13"), odd)).toBeUndefined();
  });
});

describe("keyboardCommandSource", () => {
  test("listens in the capture phase, claims a match, and hands it on once", () => {
    const target = recordingTarget();
    const received: CommandID[] = [];
    const calls: string[] = [];

    const unsubscribe = keyboardCommandSource(
      target,
      () => COMMANDS,
      NEVER_HELD,
      NEVER_RECORDING,
    ).subscribe((id) => {
      received.push(id);
    });

    expect(target.registered).toHaveLength(1);
    expect(target.registered[0]?.options).toEqual({ capture: true });

    target.registered[0]?.listener(event(chord("KeyD"), calls));

    expect(received).toEqual(["splitRight"]);
    expect(calls).toEqual(["preventDefault", "stopPropagation"]);

    unsubscribe();

    expect(target.registered).toHaveLength(0);
  });

  test("a chord that is not a command is left to the page", () => {
    const target = recordingTarget();
    const received: CommandID[] = [];
    const calls: string[] = [];

    keyboardCommandSource(target, () => COMMANDS, NEVER_HELD, NEVER_RECORDING).subscribe((id) => {
      received.push(id);
    });

    target.registered[0]?.listener(event(chord("KeyC"), calls));

    expect(received).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("while a shortcut is being recorded, the chord is left for the recorder to read", () => {
    const target = recordingTarget();
    const received: CommandID[] = [];
    const calls: string[] = [];
    let isRecording = true;

    keyboardCommandSource(
      target,
      () => COMMANDS,
      NEVER_HELD,
      () => isRecording,
    ).subscribe((id) => {
      received.push(id);
    });

    target.registered[0]?.listener(event(chord("KeyN"), calls));

    expect(received).toEqual([]);
    expect(calls).toEqual([]);

    isRecording = false;
    target.registered[0]?.listener(event(chord("KeyN"), calls));

    expect(received).toEqual(["newSession"]);
  });

  test("while a modal holds the keyboard, a chord is claimed but runs nothing", () => {
    const target = recordingTarget();
    const received: CommandID[] = [];
    const calls: string[] = [];
    let held = true;

    keyboardCommandSource(
      target,
      () => COMMANDS,
      () => held,
      NEVER_RECORDING,
    ).subscribe((id) => {
      received.push(id);
    });

    target.registered[0]?.listener(event(chord("KeyN"), calls));

    expect(received).toEqual([]);
    expect(calls).toEqual(["preventDefault", "stopPropagation"]);

    held = false;
    target.registered[0]?.listener(event(chord("KeyN"), calls));

    expect(received).toEqual(["newSession"]);
  });
});
