import { describe, expect, test } from "bun:test";

import {
  EMPTY_NAMING_HISTORY,
  MAX_FIRST_NAME_ATTEMPTS,
  MAX_NAMING_PROMPT_CHARACTERS,
  MAX_REMEMBERED_PROMPTS,
  MAX_SESSION_NAME_LENGTH,
  REFRESH_AFTER_MILLISECONDS,
  REFRESH_AFTER_PROMPTS,
  isSubstantivePrompt,
  namingDue,
  namingInstruction,
  recordAttempt,
  rememberPrompt,
  sessionNameFromReply,
  type NamingHistory,
} from "./session-naming-policy.ts";

const SUBSTANTIVE = "the sidebar flickers when I switch sessions quickly";

const remembered = (count: number, from: NamingHistory = EMPTY_NAMING_HISTORY): NamingHistory =>
  Array.from({ length: count }, (_unused, index) => `${SUBSTANTIVE} ${index}`).reduce(
    rememberPrompt,
    from,
  );

describe("isSubstantivePrompt", () => {
  test("a request with something to name is substantive", () => {
    expect(isSubstantivePrompt(SUBSTANTIVE)).toBe(true);
    expect(isSubstantivePrompt("サイドバーのちらつきを直してください")).toBe(true);
  });

  test("acknowledgements and slash commands are not", () => {
    for (const prompt of ["yes", "ok go", "continue", "  ", "/clear", "/compact keep the tests"]) {
      expect(isSubstantivePrompt(prompt)).toBe(false);
    }
  });
});

describe("rememberPrompt", () => {
  test("keeps the latest few substantive prompts, each bounded, and counts them", () => {
    const long = `${SUBSTANTIVE} ${"x".repeat(MAX_NAMING_PROMPT_CHARACTERS * 2)}`;
    const history = rememberPrompt(remembered(MAX_REMEMBERED_PROMPTS + 2), long);

    expect(history.substantive).toBe(MAX_REMEMBERED_PROMPTS + 3);
    expect(history.prompts).toHaveLength(MAX_REMEMBERED_PROMPTS);
    expect(history.prompts.at(-1)).toHaveLength(MAX_NAMING_PROMPT_CHARACTERS);
  });

  test("an acknowledgement changes nothing", () => {
    const history = remembered(1);

    expect(rememberPrompt(history, "yes")).toBe(history);
  });
});

describe("namingDue", () => {
  const now = 1_000_000_000;

  test("a derived name is replaced at the first substantive prompt", () => {
    expect(namingDue(EMPTY_NAMING_HISTORY, "derived", now)).toBe(false);
    expect(namingDue(remembered(1), "derived", now)).toBe(true);
  });

  test("a name the user gave is never replaced", () => {
    expect(namingDue(remembered(10), "user", now)).toBe(false);
  });

  test("a failed first attempt is retried on the next prompt, a bounded number of times", () => {
    let history = remembered(1);

    for (let attempt = 0; attempt < MAX_FIRST_NAME_ATTEMPTS; attempt += 1) {
      expect(namingDue(history, "derived", now)).toBe(true);

      history = recordAttempt(history, { afterPrompt: history.substantive, at: now }, "failed");

      expect(namingDue(history, "derived", now)).toBe(false);

      history = remembered(1, history);
    }

    expect(namingDue(history, "derived", now)).toBe(false);
  });

  test("an automatic name is revisited only after enough prompts and enough time", () => {
    const named = recordAttempt(remembered(1), { afterPrompt: 1, at: now }, "named");
    const later = now + REFRESH_AFTER_MILLISECONDS;

    expect(namingDue(remembered(REFRESH_AFTER_PROMPTS - 1, named), "automatic", later)).toBe(false);

    expect(namingDue(remembered(REFRESH_AFTER_PROMPTS, named), "automatic", later - 1)).toBe(false);

    expect(namingDue(remembered(REFRESH_AFTER_PROMPTS, named), "automatic", later)).toBe(true);
  });

  test("an automatic name from before a restart waits for a few prompts", () => {
    expect(namingDue(remembered(REFRESH_AFTER_PROMPTS - 1), "automatic", now)).toBe(false);
    expect(namingDue(remembered(REFRESH_AFTER_PROMPTS), "automatic", now)).toBe(true);
  });

  test("a namer that kept the derived name does not rerun on every prompt", () => {
    const kept = recordAttempt(remembered(1), { afterPrompt: 1, at: now }, "named");

    expect(namingDue(remembered(1, kept), "derived", now)).toBe(false);
  });
});

describe("namingInstruction", () => {
  test("numbers the requests and offers the current name to keep", () => {
    const instruction = namingInstruction(["fix the flicker", "and the tests"], "Sidebar flicker");

    expect(instruction).toContain('The session is called "Sidebar flicker"');
    expect(instruction).toContain("1. fix the flicker\n2. and the tests");
    expect(instruction.startsWith("Name a terminal session")).toBe(true);
  });

  test("offers nothing to keep when the name was never automatic", () => {
    expect(namingInstruction(["fix the flicker"], undefined)).not.toContain("is called");
  });
});

describe("sessionNameFromReply", () => {
  test("takes the first line, without labels, quotes or a full stop", () => {
    expect(sessionNameFromReply("Sidebar flicker on session switch\n")).toBe(
      "Sidebar flicker on session switch",
    );

    expect(sessionNameFromReply('\n  Name: "Fix Sidebar Session Flicker."  \nbecause')).toBe(
      "Fix Sidebar Session Flicker",
    );

    expect(sessionNameFromReply("**Auth token refresh**")).toBe("Auth token refresh");
    expect(sessionNameFromReply("「サイドバー修正」")).toBe("「サイドバー修正」");
  });

  test("refuses a reply with nothing in it", () => {
    expect(sessionNameFromReply("")).toBeUndefined();
    expect(sessionNameFromReply('\n  ""  \n')).toBeUndefined();
    expect(sessionNameFromReply("\u001b[0m...")).toBeUndefined();
  });

  test("cuts a long reply at a word boundary within the bound", () => {
    const name = sessionNameFromReply(
      "Investigate the intermittent sidebar flicker when switching between many sessions",
    );

    expect(name?.length).toBeLessThanOrEqual(MAX_SESSION_NAME_LENGTH);
    expect(name).toBe("Investigate the intermittent sidebar flicker");
  });
});
