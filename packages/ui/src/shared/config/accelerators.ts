export interface KeyChord {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly code: string;
}

export interface AcceleratorKeys {
  readonly shift: boolean;
  readonly alt: boolean;
  readonly code: string;
}

const NAMED_KEY_CODES = {
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  ";": "Semicolon",
  "'": "Quote",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  "-": "Minus",
  "=": "Equal",
  "`": "Backquote",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  Up: "ArrowUp",
  Down: "ArrowDown",
  Space: "Space",
  Enter: "Enter",
  Backspace: "Backspace",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
} satisfies Record<string, string>;

const KEY_TOKENS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(NAMED_KEY_CODES).map(([token, code]) => [code, token]),
);

const MODIFIER_TOKENS = ["CmdOrCtrl", "Shift", "Alt"] as const;

type ModifierToken = (typeof MODIFIER_TOKENS)[number];

const ACCELERATOR_SYMBOLS = {
  CmdOrCtrl: "⌘",
  Shift: "⇧",
  Alt: "⌥",
  Left: "←",
  Right: "→",
  Up: "↑",
  Down: "↓",
  Enter: "↩",
  Backspace: "⌫",
  Delete: "⌦",
  Home: "↖",
  End: "↘",
  PageUp: "⇞",
  PageDown: "⇟",
} satisfies Record<string, string>;

function isNamedKey(token: string): token is keyof typeof NAMED_KEY_CODES {
  return Object.hasOwn(NAMED_KEY_CODES, token);
}

function isModifier(token: string): token is ModifierToken {
  return MODIFIER_TOKENS.some((modifier) => modifier === token);
}

function isSymbolToken(token: string): token is keyof typeof ACCELERATOR_SYMBOLS {
  return Object.hasOwn(ACCELERATOR_SYMBOLS, token);
}

export function keyCodeOf(token: string): string | undefined {
  if (isNamedKey(token)) return NAMED_KEY_CODES[token];

  if (/^[A-Z]$/.test(token)) return `Key${token}`;

  if (/^[0-9]$/.test(token)) return `Digit${token}`;

  return /^F([1-9]|1[0-2])$/.test(token) ? token : undefined;
}

export function keyTokenOf(code: string): string | undefined {
  const named = KEY_TOKENS[code];

  if (named !== undefined) return named;

  const letter = /^Key([A-Z])$/.exec(code)?.[1];

  if (letter !== undefined) return letter;

  const digit = /^Digit([0-9])$/.exec(code)?.[1];

  if (digit !== undefined) return digit;

  return /^F([1-9]|1[0-2])$/.test(code) ? code : undefined;
}

export function parseAccelerator(accelerator: string): AcceleratorKeys | undefined {
  const tokens = accelerator.split("+");
  const key = tokens.at(-1);

  if (key === undefined) return undefined;

  const code = keyCodeOf(key);

  if (code === undefined) return undefined;

  let meta = false;
  let shift = false;
  let alt = false;

  for (const token of tokens.slice(0, -1)) {
    if (!isModifier(token)) return undefined;

    if (token === "CmdOrCtrl") meta = true;

    if (token === "Shift") shift = true;

    if (token === "Alt") alt = true;
  }

  return meta ? { shift, alt, code } : undefined;
}

export function spellAccelerator(keys: AcceleratorKeys): string | undefined {
  const token = keyTokenOf(keys.code);

  if (token === undefined) return undefined;

  return ["CmdOrCtrl", ...(keys.shift ? ["Shift"] : []), ...(keys.alt ? ["Alt"] : []), token].join(
    "+",
  );
}

export function acceleratorForChord(chord: KeyChord): string | undefined {
  if (!chord.metaKey || chord.ctrlKey) return undefined;

  return spellAccelerator({ shift: chord.shiftKey, alt: chord.altKey, code: chord.code });
}

export function sameAccelerator(left: string, right: string): boolean {
  const first = parseAccelerator(left);
  const second = parseAccelerator(right);

  return (
    first !== undefined &&
    second !== undefined &&
    first.code === second.code &&
    first.shift === second.shift &&
    first.alt === second.alt
  );
}

export function acceleratorCapTokens(accelerator: string): readonly string[] {
  return accelerator
    .split("+")
    .map((part) => (isSymbolToken(part) ? ACCELERATOR_SYMBOLS[part] : part));
}

export function acceleratorCaps(accelerator: string): string {
  return acceleratorCapTokens(accelerator).join("+");
}
