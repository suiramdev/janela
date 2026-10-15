import { describe, expect, test } from "bun:test";

import { MAX_FORWARDED_PROMPT_BYTES, parseAgentPrompt } from "./agent-prompt.ts";

const encode = (text: string): string => Buffer.from(text, "utf8").toString("base64");

const claudePayload = (prompt: string): string =>
  JSON.stringify({
    session_id: "44e9d40a-caf8-459e-be95-f455b7708285",
    transcript_path: "/Users/x/.claude/projects/p/44e9d40a.jsonl",
    cwd: "/Users/x/code/janela",
    hook_event_name: "UserPromptSubmit",
    prompt,
  });

const report = (json: string): string =>
  `prompt;${Buffer.from(json, "utf8").subarray(0, MAX_FORWARDED_PROMPT_BYTES).toString("base64")}`;

describe("parseAgentPrompt", () => {
  test("reads the prompt out of the payload Claude Code hands its hook", () => {
    expect(parseAgentPrompt(report(claudePayload('Reply with OK. héllo "quoted" ✓')))).toBe(
      'Reply with OK. héllo "quoted" ✓',
    );
  });

  test("recovers the start of a prompt whose payload the hook cut short", () => {
    const long = `fix the sidebar flicker ${"and more ".repeat(2000)}`;
    const parsed = parseAgentPrompt(report(claudePayload(long)));

    expect(parsed?.startsWith("fix the sidebar flicker and more")).toBe(true);
    expect(parsed?.length).toBeLessThan(MAX_FORWARDED_PROMPT_BYTES);
  });

  test("keeps escapes inside a cut-short prompt and stops at a broken one", () => {
    const json = '{"prompt":"line one\\nline \\u00e9\\u00';

    expect(parseAgentPrompt(`prompt;${encode(json)}`)).toBe("line one\nline é");
  });

  test("ignores a key that only appears inside the prompt's own text", () => {
    const json = claudePayload('say "prompt": "nope" back to me');

    expect(parseAgentPrompt(`prompt;${encode(json)}`)).toBe('say "prompt": "nope" back to me');
  });

  test("refuses anything that is not a prompt report", () => {
    expect(parseAgentPrompt("working")).toBeUndefined();
    expect(parseAgentPrompt("prompt")).toBeUndefined();
    expect(parseAgentPrompt("prompt;not base64!")).toBeUndefined();
    expect(parseAgentPrompt(`prompt;${encode("{}")};extra`)).toBeUndefined();
    expect(parseAgentPrompt(`prompt;${encode('{"prompt":"   "}')}`)).toBeUndefined();
    expect(parseAgentPrompt(`prompt;${encode("not json")}`)).toBeUndefined();
  });

  test("refuses a payload longer than any hook would send", () => {
    const oversized = encode(claudePayload("x".repeat(MAX_FORWARDED_PROMPT_BYTES * 2)));

    expect(parseAgentPrompt(`prompt;${oversized}`)).toBeUndefined();
  });
});
