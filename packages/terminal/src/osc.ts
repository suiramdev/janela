/**
 * OSC payload parsers.
 *
 * Everything here reads a string a *child process* chose, so every function is
 * written to refuse rather than to guess: an unparseable payload is `undefined`
 * and the sequence is dropped, never an error and never a half-understood value.
 * A wrong working directory in a session header is worse than an absent one.
 *
 * These are pure and separate from `headless-emulator.ts` so they can be tested
 * without a grid — and so the emulator's OSC handlers stay two lines each.
 */

import {
  MAX_OSC_TEXT_LENGTH,
  type PromptMark,
  type TerminalNotification,
} from "./terminal-emulating.ts";

/** C0 controls, DEL, and C1 controls. None of them belong in a title or a path. */
// oxlint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/gu;

/**
 * Strips controls and bounds the length.
 *
 * The bound is the load-bearing half: `xterm`'s parser already refuses most
 * controls inside an OSC string, but it will happily hand over megabytes, and
 * this text ends up in a sidebar, a notification and possibly a log record.
 *
 * Truncation is by code point rather than by code unit, so a payload that ends in
 * an emoji does not leave a lone surrogate behind.
 */
export function sanitiseOscText(raw: string): string {
  const cleaned = raw.replace(CONTROLS, "");
  if (cleaned.length <= MAX_OSC_TEXT_LENGTH) {
    return cleaned;
  }
  return [...cleaned].slice(0, MAX_OSC_TEXT_LENGTH).join("");
}

/**
 * `OSC 7 ; file://<host>/<path>` — the shell reporting where it is.
 *
 * Only this machine's paths are accepted. A shell on the far side of an ssh
 * session reports a directory that does not exist here, and showing it would make
 * a session header confidently wrong.
 */
export function parseWorkingDirectory(payload: string, hostname: string): string | undefined {
  let url: URL;
  try {
    url = new URL(payload);
  } catch {
    return undefined;
  }
  if (url.protocol !== "file:") {
    return undefined;
  }
  // WHATWG normalises `file://localhost/` to an empty host, so both spellings of
  // "here" arrive as "".
  if (url.hostname !== "" && url.hostname !== "localhost" && url.hostname !== hostname) {
    return undefined;
  }

  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  // A truncated path is a wrong path, so this one rejects where the others cut.
  if (!path.startsWith("/") || path.length > MAX_OSC_TEXT_LENGTH) {
    return undefined;
  }
  return sanitiseOscText(path);
}

/**
 * `OSC 9 ; <text>` — ConEmu's, and iTerm2's, "post a notification".
 *
 * ConEmu also uses OSC 9 for sub-commands, of which `9 ; 4 ; …` is a progress
 * bar. Treating those as notifications would badge a session once per percent of
 * a download.
 */
export function parseNotification(payload: string): TerminalNotification | undefined {
  if (/^\d+;/u.test(payload)) {
    return undefined;
  }
  const body = sanitiseOscText(payload);
  return body === "" ? {} : { body };
}

/** `OSC 777 ; notify ; <title> ; <body>` — rxvt-unicode's, as tmux and kitty send it. */
export function parseUrxvtNotification(payload: string): TerminalNotification | undefined {
  const fields = payload.split(";");
  if (fields[0] !== "notify") {
    return undefined;
  }
  const title = sanitiseOscText(fields[1] ?? "");
  const body = sanitiseOscText(fields.slice(2).join(";"));
  return {
    ...(title === "" ? {} : { title }),
    ...(body === "" ? {} : { body }),
  };
}

/**
 * `OSC 133 ; A|B|C|D[;<code>]` — shell integration's semantic prompt marks.
 *
 * Only the three Janela acts on are returned. `B` (end of prompt) and `P`
 * (kitty's property extension) are perfectly valid and simply carry nothing this
 * layer can use, so they are ignored rather than treated as malformed.
 */
export function parsePromptMark(payload: string): PromptMark | undefined {
  const fields = payload.split(";");
  const kind = fields[0]?.[0];
  if (kind === "A") {
    return { kind: "promptStart" };
  }
  if (kind === "C") {
    return { kind: "commandStart" };
  }
  if (kind !== "D") {
    return undefined;
  }
  const code = fields[1];
  if (code === undefined || !/^-?\d+$/u.test(code)) {
    return { kind: "commandFinished" };
  }
  return { kind: "commandFinished", exitCode: Number(code) };
}
