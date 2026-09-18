import { describe, expect, test } from "bun:test";

import { ACTIVITIES, hookCommand, isJanelaHookCommand } from "./report-command.ts";

describe("hookCommand", () => {
  test("is the one-liner the harnesses run verbatim", () => {
    expect(hookCommand(ACTIVITIES.waitingPermission)).toBe(
      `[ -n "$JANELA_TTY" ] && printf '\\033]7770;waiting;permission\\a' > "$JANELA_TTY" 2>/dev/null; printf '{}'`,
    );
  });

  test("always prints an object so a permission hook never fails closed", () => {
    for (const activity of Object.values(ACTIVITIES)) {
      expect(hookCommand(activity).endsWith("printf '{}'")).toBe(true);
    }
  });

  test("never reads stdin, which Codex never closes for its Stop hook", () => {
    for (const activity of Object.values(ACTIVITIES)) {
      expect(hookCommand(activity)).not.toContain("cat");
    }
  });
});

describe("isJanelaHookCommand", () => {
  test("recognises every command we write", () => {
    for (const activity of Object.values(ACTIVITIES)) {
      expect(isJanelaHookCommand(hookCommand(activity))).toBe(true);
    }
  });

  test("leaves another tool's hook alone", () => {
    expect(isJanelaHookCommand(`printf '\\033]9;4;1;50\\a' > "$JANELA_TTY"`)).toBe(false);
    expect(isJanelaHookCommand(`printf '\\033]7770;working\\a' > /dev/tty`)).toBe(false);
  });
});
