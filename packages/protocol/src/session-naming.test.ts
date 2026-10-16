import { describe, expect, test } from "bun:test";

import type { SessionNamerCatalog, SessionNamingOverview } from "@janela/core";

import {
  decodeSessionNamerID,
  decodeSessionNaming,
  parseSessionNamerCatalog,
  parseSessionNamingOverview,
  serializeSessionNamerCatalog,
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

describe("decodeSessionNaming with an effort", () => {
  test("keeps an effort the agent's flag can carry", () => {
    expect(decodeSessionNaming({ kind: "agent", agent: "codex", effort: "low" })).toEqual({
      kind: "agent",
      agent: "codex",
      effort: "low",
    });
  });

  test("refuses an effort that would escape a config override", () => {
    expect(
      decodeSessionNaming({ kind: "agent", agent: "codex", effort: 'low" sandbox="x' }),
    ).toBeUndefined();

    expect(decodeSessionNaming({ kind: "agent", agent: "codex", effort: "" })).toBeUndefined();
  });
});

describe("session namer catalog", () => {
  test("round-trips through its text form", () => {
    const catalog: SessionNamerCatalog = {
      agent: "omp",
      models: [{ id: "anthropic/claude-haiku", name: "Haiku", efforts: ["minimal", "low"] }],
    };

    expect(parseSessionNamerCatalog(serializeSessionNamerCatalog(catalog))).toEqual(catalog);
  });

  test("refuses text that is not a catalog", () => {
    expect(() => parseSessionNamerCatalog('{"agent":"nobody","models":[]}')).toThrow(
      "not a session namer catalog",
    );
  });

  test("an agent id is checked against the closed set", () => {
    expect(decodeSessionNamerID("codex")).toBe("codex");
    expect(decodeSessionNamerID("bash")).toBeUndefined();
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
