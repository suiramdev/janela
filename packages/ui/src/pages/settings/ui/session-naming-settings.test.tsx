import { describe, expect, test } from "bun:test";

import { renderToStaticMarkup } from "react-dom/server";

import type { SessionNamingState } from "../model/session-naming.ts";
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

function markupFor(state: SessionNamingState): string {
  return renderToStaticMarkup(
    <SessionNamingForm state={state} isPending={false} onConfigure={noop} />,
  );
}

describe("the session naming pane", () => {
  test("off offers every namer and asks for no model", () => {
    const markup = markupFor({
      kind: "loaded",
      overview: { naming: { kind: "off" }, namers: NAMERS },
    });

    expect(markup).toContain(sectionElementID("integrationsNaming"));
    expect(markup).toContain("Name sessions with");
    expect(markup).toContain("Claude Code");
    expect(markup).toContain("Codex");
    expect(markup).not.toContain("Model");
  });

  test("a chosen namer shows its model, with the default as the placeholder", () => {
    const markup = markupFor({
      kind: "loaded",
      overview: { naming: { kind: "agent", agent: "claude" }, namers: NAMERS },
    });

    expect(markup).toContain("Model");
    expect(markup).toContain('placeholder="haiku"');
  });

  test("says nothing about the namers until the daemon has answered", () => {
    const markup = markupFor({ kind: "loading" });

    expect(markup).not.toContain("Name sessions with");
    expect(markup).not.toContain("Codex");
  });

  test("a failure is shown as the daemon summarised it", () => {
    expect(markupFor({ kind: "failed", summary: "Could not save the setting." })).toContain(
      "Could not save the setting.",
    );
  });
});
