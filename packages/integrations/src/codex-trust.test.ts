import { describe, expect, test } from "bun:test";

import { codexTrustHash } from "./codex-trust.ts";

const SCRIPT = "/Users/nouchetm/.orca/agent-hooks/codex-hook.sh";

const OBSERVED_COMMAND = `if [ -f '${SCRIPT}' ] && [ -r '${SCRIPT}' ] && [ -x '${SCRIPT}' ]; then /bin/sh '${SCRIPT}'; else { command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :; fi`;

describe("codexTrustHash", () => {
  test("reproduces the hash Codex itself recorded for a real hook", () => {
    expect(codexTrustHash({ label: "stop", command: OBSERVED_COMMAND, timeout: 10 })).toBe(
      "sha256:a03ddc389bd5727a2fa05dd9dd41808aae724496198a49de57b8d071bf17c45d",
    );
  });

  test("a matcher is part of the identity", () => {
    const bare = codexTrustHash({ label: "pre_tool_use", command: "echo", timeout: 10 });
    const matched = codexTrustHash({
      label: "pre_tool_use",
      command: "echo",
      timeout: 10,
      matcher: "Bash",
    });

    expect(matched).not.toBe(bare);
  });

  test("a timeout below one second is clamped, as Codex clamps it", () => {
    expect(codexTrustHash({ label: "stop", command: "echo", timeout: 0 })).toBe(
      codexTrustHash({ label: "stop", command: "echo", timeout: 1 }),
    );
  });
});
