import { Option } from "effect";

import {
  MAX_OSC_TEXT_LENGTH,
  type PromptMark,
  type TerminalNotification,
} from "./terminal-emulating.ts";

// oxlint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/gu;

const DECIMAL_INTEGER = /^-?\d+$/u;

const CONEMU_SUBCOMMAND = /^\d+;/u;

const parseUrl = Option.liftThrowable((text: string) => new URL(text));

const decodePath = Option.liftThrowable(decodeURIComponent);

export function sanitiseOscText(raw: string): string {
  const cleaned = raw.replace(CONTROLS, "");

  if (cleaned.length <= MAX_OSC_TEXT_LENGTH) {
    return cleaned;
  }

  return [...cleaned].slice(0, MAX_OSC_TEXT_LENGTH).join("");
}

export function parseWorkingDirectory(payload: string, hostname: string): string | undefined {
  const url = parseUrl(payload);

  if (Option.isNone(url)) {
    return undefined;
  }

  if (url.value.protocol !== "file:") {
    return undefined;
  }

  const reported = url.value.hostname;

  if (reported !== "" && reported !== "localhost" && reported !== hostname) {
    return undefined;
  }

  const path = decodePath(url.value.pathname);

  if (Option.isNone(path)) {
    return undefined;
  }

  if (!path.value.startsWith("/") || path.value.length > MAX_OSC_TEXT_LENGTH) {
    return undefined;
  }

  return sanitiseOscText(path.value);
}

export function parseNotification(payload: string): TerminalNotification | undefined {
  if (CONEMU_SUBCOMMAND.test(payload)) {
    return undefined;
  }

  const body = sanitiseOscText(payload);

  return body === "" ? {} : { body };
}

export function parseUrxvtNotification(payload: string): TerminalNotification | undefined {
  const fields = payload.split(";");

  if (fields[0] !== "notify") {
    return undefined;
  }

  const title = sanitiseOscText(fields[1] ?? "");
  const body = sanitiseOscText(fields.slice(2).join(";"));

  if (title === "") {
    return body === "" ? {} : { body };
  }

  return body === "" ? { title } : { title, body };
}

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

  if (code === undefined || !DECIMAL_INTEGER.test(code)) {
    return { kind: "commandFinished" };
  }

  return { kind: "commandFinished", exitCode: Number(code) };
}
