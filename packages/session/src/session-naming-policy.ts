import type { SessionNameOrigin } from "@janela/core";

export interface NamingAttempt {
  readonly afterPrompt: number;
  readonly at: number;
}

export interface NamingHistory {
  readonly prompts: readonly string[];
  readonly substantive: number;
  readonly failures: number;
  readonly lastAttempt?: NamingAttempt;
}

export const EMPTY_NAMING_HISTORY: NamingHistory = { prompts: [], substantive: 0, failures: 0 };

export const MAX_REMEMBERED_PROMPTS = 3;

export const MAX_NAMING_PROMPT_CHARACTERS = 600;

export const REFRESH_AFTER_PROMPTS = 3;

export const REFRESH_AFTER_MILLISECONDS = 10 * 60 * 1000;

export const MAX_FIRST_NAME_ATTEMPTS = 3;

export const MAX_SESSION_NAME_LENGTH = 48;

const MIN_SUBSTANTIVE_WORDS = 3;

const MIN_SUBSTANTIVE_CHARACTERS = 20;

const MIN_SUBSTANTIVE_IDEOGRAMS = 6;

const UNSPACED_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/gu;

const SLASH_COMMAND = /^\/\S/u;

const WHITESPACE = /\s+/gu;

// oxlint-disable-next-line no-control-regex -- matching control characters is the point.
const ANSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/gu;

// oxlint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/gu;

const LABEL = /^(?:session\s+)?(?:name|title)\s*[:：]\s*/iu;

const WRAPPING = /^[\s"'`*#_“”‘’«»]+|[\s"'`*_“”‘’«».!。]+$/gu;

const MEANINGFUL = /[\p{L}\p{N}]/u;

export function normalisedPrompt(prompt: string): string {
  return prompt.replace(WHITESPACE, " ").trim().slice(0, MAX_NAMING_PROMPT_CHARACTERS);
}

export function isSubstantivePrompt(prompt: string): boolean {
  const text = normalisedPrompt(prompt);

  if (SLASH_COMMAND.test(text)) return false;

  return (
    text.split(" ").length >= MIN_SUBSTANTIVE_WORDS ||
    text.length >= MIN_SUBSTANTIVE_CHARACTERS ||
    (text.match(UNSPACED_SCRIPT)?.length ?? 0) >= MIN_SUBSTANTIVE_IDEOGRAMS
  );
}

export function rememberPrompt(history: NamingHistory, prompt: string): NamingHistory {
  if (!isSubstantivePrompt(prompt)) return history;

  return {
    ...history,
    prompts: [...history.prompts, normalisedPrompt(prompt)].slice(-MAX_REMEMBERED_PROMPTS),
    substantive: history.substantive + 1,
  };
}

export function recordAttempt(
  history: NamingHistory,
  attempt: NamingAttempt,
  outcome: "named" | "failed",
): NamingHistory {
  return {
    ...history,
    failures: outcome === "failed" ? history.failures + 1 : 0,
    lastAttempt: attempt,
  };
}

export function namingDue(history: NamingHistory, origin: SessionNameOrigin, now: number): boolean {
  if (origin === "user" || history.substantive === 0) return false;

  const last = history.lastAttempt;

  if (last !== undefined && last.afterPrompt === history.substantive) return false;

  const stillUnnamed =
    origin === "derived" &&
    (last === undefined || (history.failures > 0 && history.failures < MAX_FIRST_NAME_ATTEMPTS));

  if (stillUnnamed) return true;

  const since = last?.afterPrompt ?? 0;
  const sinceAt = last?.at ?? Number.NEGATIVE_INFINITY;

  return (
    history.substantive - since >= REFRESH_AFTER_PROMPTS &&
    now - sinceAt >= REFRESH_AFTER_MILLISECONDS
  );
}

export function namingInstruction(
  prompts: readonly string[],
  currentName: string | undefined,
): string {
  const lines = [
    "Name a terminal session after the work it is for.",
    "Describe the task, not the tool: no words like session, Claude, agent or terminal.",
  ];

  if (currentName !== undefined) {
    lines.push(
      `The session is called "${currentName}". If that still describes the requests, reply with it unchanged.`,
    );
  }

  lines.push("", "The requests, oldest first:");

  for (const [index, prompt] of prompts.entries()) {
    lines.push(`${index + 1}. ${prompt}`);
  }

  lines.push(
    "",
    "Reply with the name alone: two to five words, no quotes, no full stop, in the same language as the requests above (do not translate them).",
  );

  return lines.join("\n");
}

export function sessionNameFromReply(reply: string): string | undefined {
  const line = reply
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);

  if (line === undefined) return undefined;

  const name = line
    .replace(ANSI_SEQUENCE, "")
    .replace(CONTROLS, "")
    .replace(LABEL, "")
    .replace(WRAPPING, "")
    .replace(WHITESPACE, " ")
    .trim();

  if (!MEANINGFUL.test(name)) return undefined;

  if (name.length <= MAX_SESSION_NAME_LENGTH) return name;

  const cut = name.slice(0, MAX_SESSION_NAME_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");

  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
}
