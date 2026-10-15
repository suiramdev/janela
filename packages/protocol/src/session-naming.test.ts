import { describe, expect, test } from "bun:test";

import type { SessionNamingOverview } from "@janela/core";

import {
  decodeSessionNaming,
  parseSessionNamingOverview,
  serializeSessionNamingOverview,
} from "./session-naming.ts";

describe("decodeSessionNaming", () => {
  test("accepts off, a known agent, and a known agent with a model", () => {
    expect(decodeSessionNaming({ kind: "off" })).toEqual({ kind: "off" });
    expect(decodeSessionNaming({ kind: "agent", agent: "codex" })).toEqual({
      kind: "agent",
      agent: "codex",
    });

    expect(decodeSessionNaming({ kind: "agent", agent: "claude", model: "haiku" })).toEqual({
      kind: "agent",
      agent: "claude",
      model: "haiku",
    });
  });

  test("refuses a model that is not one", () => {
    expect(decodeSessionNaming({ kind: "agent", agent: "claude", model: "" })).toBeUndefined();

    expect(
      decodeSessionNaming({ kind: "agent", agent: "claude", model: "m".repeat(200) }),
    ).toBeUndefined();
  });
});

describe("session naming overview", () => {
  test("round-trips through its text form", () => {
    const overview: SessionNamingOverview = {
      naming: { kind: "agent", agent: "claude" },
      namers: [
        {
          id: "claude",
          name: "Claude Code",
          executable: "claude",
          isAvailable: true,
          defaultModel: "haiku",
        },
        { id: "codex", name: "Codex", executable: "codex", isAvailable: false },
      ],
    };

    expect(parseSessionNamingOverview(serializeSessionNamingOverview(overview))).toEqual(overview);
  });

  test("refuses text that is not an overview", () => {
    expect(() => parseSessionNamingOverview('{"naming":{"kind":"maybe"},"namers":[]}')).toThrow(
      "not a session naming overview",
    );
  });
});
