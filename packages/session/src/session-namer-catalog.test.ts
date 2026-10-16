import { describe, expect, test } from "bun:test";

import { MAX_SESSION_NAMER_CATALOG_MODELS } from "@janela/core";

import {
  CLAUDE_INITIALIZE_REQUEST,
  NAMER_CATALOGS,
  parseClaudeCatalog,
  parseCodexCatalog,
  parseOmpCatalog,
} from "./session-namer-catalog.ts";

describe("parseClaudeCatalog", () => {
  test("reads the models Claude Code answers its initialize request with", () => {
    const output = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "janela-models",
          response: {
            models: [
              { value: "haiku", displayName: "Haiku", supportedEffortLevels: ["low", "high"] },
              { value: "sonnet" },
            ],
          },
        },
      }),
    ].join("\n");

    expect(parseClaudeCatalog(output)).toEqual([
      { id: "haiku", name: "Haiku", efforts: ["low", "high"] },
      { id: "sonnet", name: "sonnet", efforts: [] },
    ]);
  });

  test("no initialize response is no catalog", () => {
    expect(parseClaudeCatalog('{"type":"result"}\n')).toBeUndefined();
  });

  test("the request is one line of stream-json", () => {
    expect(CLAUDE_INITIALIZE_REQUEST.endsWith("\n")).toBe(true);
    expect(JSON.parse(CLAUDE_INITIALIZE_REQUEST)).toMatchObject({
      type: "control_request",
      request: { subtype: "initialize" },
    });

    expect(NAMER_CATALOGS.claude.standardInput).toBe(CLAUDE_INITIALIZE_REQUEST);
  });
});

describe("parseCodexCatalog", () => {
  test("keeps the models Codex lists and drops the hidden ones", () => {
    const output = JSON.stringify({
      models: [
        {
          slug: "gpt-a",
          display_name: "GPT A",
          visibility: "list",
          supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }],
        },
        { slug: "gpt-hidden", visibility: "hide" },
      ],
    });

    expect(parseCodexCatalog(output)).toEqual([
      { id: "gpt-a", name: "GPT A", efforts: ["low", "medium"] },
    ]);
  });

  test("an effort that could escape the config override is dropped", () => {
    const output = JSON.stringify({
      models: [{ slug: "gpt-a", supported_reasoning_levels: [{ effort: 'low" x="y' }] }],
    });

    expect(parseCodexCatalog(output)).toEqual([{ id: "gpt-a", name: "gpt-a", efforts: [] }]);
  });
});

describe("parseOmpCatalog", () => {
  test("names each model by the selector omp takes on --model", () => {
    const output = JSON.stringify({
      models: [
        { selector: "anthropic/claude-haiku", name: "Haiku", kind: "chat", thinking: ["low"] },
        { selector: "local/embed", kind: "embedding" },
      ],
    });

    expect(parseOmpCatalog(output)).toEqual([
      { id: "anthropic/claude-haiku", name: "Haiku", efforts: ["low"] },
    ]);
  });

  test("a catalog larger than the bound is cut at the bound", () => {
    const models = Array.from(
      { length: MAX_SESSION_NAMER_CATALOG_MODELS + 5 },
      (_unused, index) => ({
        selector: `p/m${index}`,
      }),
    );

    expect(parseOmpCatalog(JSON.stringify({ models }))).toHaveLength(
      MAX_SESSION_NAMER_CATALOG_MODELS,
    );
  });
});
