import { describe, expect, test } from "bun:test";

import type { ClientRequest } from "@janela/client";
import type { SessionNamingOverview } from "@janela/core";
import { serializeSessionNamingOverview } from "@janela/protocol";

import {
  chosenNamer,
  configureSessionNaming,
  loadSessionNaming,
  namerOptions,
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

  test("off comes first, and a namer missing from PATH says so", () => {
    const options = namerOptions(OVERVIEW);

    expect(options.map((option) => option.value)).toEqual(["off", "claude", "codex"]);
    expect(options[1]?.detail).toContain("haiku");
    expect(options[2]?.detail).toBe("codex is not on your PATH, so nothing would be named.");
  });
});
