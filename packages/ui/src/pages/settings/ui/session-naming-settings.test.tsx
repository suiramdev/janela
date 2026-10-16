import { describe, expect, test } from "bun:test";

import type { SessionNamingOverview } from "@janela/core";
import { renderToStaticMarkup } from "react-dom/server";

import type { NamerCatalogState, SessionNamingState } from "../model/session-naming.ts";
import { sectionElementID } from "../model/settings-index.ts";
import { SessionNamingForm } from "./session-naming-settings.tsx";

const noop = (): void => {};

const NAMERS = [
  {
    id: "claude",
    name: "Claude Code",
    executable: "claude",
    isAvailable: true,
    defaultModel: "haiku",
  },
  { id: "codex", name: "Codex", executable: "codex", isAvailable: true },
] as const;

const CATALOG: NamerCatalogState = {
  kind: "loaded",
  catalog: {
    agent: "claude",
    models: [{ id: "haiku", name: "Haiku", efforts: ["low", "high"] }],
  },
};

const loaded = (naming: SessionNamingOverview["naming"]): SessionNamingState => ({
  kind: "loaded",
  overview: { naming, namers: NAMERS },
});

function markupFor(state: SessionNamingState, catalog: NamerCatalogState = CATALOG): string {
  return renderToStaticMarkup(
    <SessionNamingForm state={state} catalog={catalog} isPending={false} onConfigure={noop} />,
  );
}

describe("the session naming pane", () => {
  test("off offers every provider in one select, and asks for no model", () => {
    const markup = markupFor(loaded({ kind: "off" }));

    expect(markup).toContain(sectionElementID("integrationsNaming"));
    expect(markup).toContain("Provider");
    expect(markup).toContain("<select");
    expect(markup).toContain(">Claude Code</option>");
    expect(markup).toContain(">Codex</option>");
    expect(markup).not.toContain("Model");
    expect(markup).not.toContain("Reasoning effort");
  });

  test("a chosen provider takes a model and an effort, each its own editable field", () => {
    const markup = markupFor(loaded({ kind: "agent", agent: "claude" }));

    expect(markup).toContain("Model");
    expect(markup).toContain("Reasoning effort");
    expect([...markup.matchAll(/<input[^>]*role="combobox"/g)]).toHaveLength(2);
    expect(markup).toContain('placeholder="haiku"');
    expect(markup).toContain('placeholder="Default"');
  });

  test("says nothing about the providers until the daemon has answered", () => {
    const markup = markupFor({ kind: "loading" });

    expect(markup).not.toContain("Provider");
    expect(markup).not.toContain("Codex");
  });

  test("a failure is shown as the daemon summarised it", () => {
    expect(markupFor({ kind: "failed", summary: "Could not save the setting." })).toContain(
      "Could not save the setting.",
    );
  });
});
