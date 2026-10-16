import { describe, expect, test } from "bun:test";

import type { ClientRequest } from "@janela/client";
import type { SessionNamerCatalog, SessionNamingOverview } from "@janela/core";
import { serializeSessionNamerCatalog, serializeSessionNamingOverview } from "@janela/protocol";

import {
  chosenNamer,
  configureSessionNaming,
  effortItems,
  loadNamerCatalog,
  loadSessionNaming,
  modelItems,
  namerOptions,
  namingEffort,
  namingFor,
  namingModel,
  type SessionNamingRequesting,
} from "./session-naming.ts";

const OVERVIEW: SessionNamingOverview = {
  naming: { kind: "agent", agent: "claude", model: "haiku" },
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

function recording(): {
  readonly requests: ClientRequest[];
  readonly connection: SessionNamingRequesting;
} {
  const requests: ClientRequest[] = [];

  return {
    requests,
    connection: {
      request: (message: ClientRequest) => {
        requests.push(message);

        return Promise.resolve(
          message.type === "sessionNaming" ? serializeSessionNamingOverview(OVERVIEW) : undefined,
        );
      },
    },
  };
}

describe("talking to the daemon", () => {
  test("loading reads the overview out of the text reply", async () => {
    expect(await loadSessionNaming(recording().connection)).toEqual(OVERVIEW);
  });

  test("configuring sends the choice, then asks for the overview again", async () => {
    const recorded = recording();

    await configureSessionNaming(recorded.connection, { kind: "off" });

    expect(recorded.requests).toEqual([
      { type: "configureSessionNaming", naming: { kind: "off" } },
      { type: "sessionNaming" },
    ]);
  });

  test("an acknowledgement with no overview is a protocol fault", async () => {
    const silent: SessionNamingRequesting = { request: () => Promise.resolve(undefined) };

    await expect(loadSessionNaming(silent)).rejects.toBeInstanceOf(TypeError);
  });
});

describe("the form's values", () => {
  test("a choice and a model become the setting the daemon stores", () => {
    expect(namingFor("off", "haiku")).toEqual({ kind: "off" });
    expect(namingFor("codex", "  ")).toEqual({ kind: "agent", agent: "codex" });
    expect(namingFor("claude", " sonnet ")).toEqual({
      kind: "agent",
      agent: "claude",
      model: "sonnet",
    });
  });

  test("the setting reads back as the choice and the model it came from", () => {
    expect(namingModel(OVERVIEW.naming)).toBe("haiku");
    expect(namingModel({ kind: "off" })).toBe("");
    expect(chosenNamer(OVERVIEW)?.id).toBe("claude");
    expect(chosenNamer({ ...OVERVIEW, naming: { kind: "off" } })).toBeUndefined();
  });

  test("off comes first, and a provider missing from PATH says so and cannot be chosen", () => {
    const options = namerOptions(OVERVIEW);

    expect(options.map((option) => option.value)).toEqual(["off", "claude", "codex"]);
    expect(options[1]).toEqual({ value: "claude", title: "Claude Code", isDisabled: false });
    expect(options[2]).toEqual({
      value: "codex",
      title: "Codex (not installed)",
      isDisabled: true,
    });
  });

  test("a chosen provider missing from PATH stays selectable, so the select can show it", () => {
    const options = namerOptions({ ...OVERVIEW, naming: { kind: "agent", agent: "codex" } });

    expect(options[2]?.isDisabled).toBe(false);
  });

  test("an effort joins the setting only when one was given", () => {
    expect(namingFor("omp", "", " low ")).toEqual({ kind: "agent", agent: "omp", effort: "low" });
    expect(namingFor("omp", "x", "")).toEqual({ kind: "agent", agent: "omp", model: "x" });
    expect(namingEffort({ kind: "agent", agent: "omp", effort: "high" })).toBe("high");
    expect(namingEffort({ kind: "off" })).toBe("");
  });
});

describe("the provider's catalog", () => {
  const CATALOG: SessionNamerCatalog = {
    agent: "claude",
    models: [
      { id: "haiku", name: "Haiku", efforts: ["low", "high"] },
      { id: "opus", name: "opus", efforts: ["low", "max"] },
    ],
  };

  test("is asked for by provider, and parsed from the daemon's text reply", async () => {
    const requests: ClientRequest[] = [];
    const connection: SessionNamingRequesting = {
      request(message) {
        requests.push(message);

        return Promise.resolve(serializeSessionNamerCatalog(CATALOG));
      },
    };

    expect(await loadNamerCatalog(connection, "claude")).toEqual(CATALOG);
    expect(requests).toEqual([{ type: "sessionNamerModels", agent: "claude" }]);
  });

  test("models show their name, with the id beside it when the two differ", () => {
    expect(modelItems(CATALOG)).toEqual([
      { value: "haiku", label: "Haiku", detail: "haiku" },
      { value: "opus", label: "opus" },
    ]);

    expect(modelItems(undefined)).toEqual([]);
  });

  test("efforts are the chosen model's, or every model's for one the catalog lacks", () => {
    expect(effortItems(CATALOG, "haiku").map((item) => item.value)).toEqual(["low", "high"]);
    expect(effortItems(CATALOG, "my-own-model").map((item) => item.value)).toEqual([
      "low",
      "high",
      "max",
    ]);
  });
});
