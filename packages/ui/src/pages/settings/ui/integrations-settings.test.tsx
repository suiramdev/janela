import { describe, expect, test } from "bun:test";

import type { IntegrationID, IntegrationReport } from "@janela/core";
import { renderToStaticMarkup } from "react-dom/server";

import type { IntegrationsState } from "../model/integrations.ts";
import { sectionElementID } from "../model/settings-index.ts";
import { IntegrationsList } from "./integrations-settings.tsx";

const noop = (): void => {};

const CLAUDE: IntegrationReport = {
  id: "claude",
  name: "Claude Code",
  executable: "claude",
  isAvailable: true,
  configPath: "/Users/me/.claude/settings.json",
  capabilities: ["activity", "prompts"],
  status: { kind: "installed" },
};

const CODEX: IntegrationReport = {
  id: "codex",
  name: "Codex",
  executable: "codex",
  isAvailable: true,
  configPath: "/Users/me/.codex/hooks.json",
  capabilities: ["activity"],
  status: { kind: "absent" },
};

const BOTH: IntegrationsState = {
  kind: "loaded",
  overview: { integrations: [CLAUDE, CODEX] },
};

const OUTDATED: IntegrationsState = {
  kind: "loaded",
  overview: { integrations: [{ ...CLAUDE, status: { kind: "outdated" } }] },
};

const UNREADABLE: IntegrationsState = {
  kind: "loaded",
  overview: { integrations: [{ ...CLAUDE, status: { kind: "unreadable", reason: "not JSON" } }] },
};

const UNAVAILABLE: IntegrationsState = {
  kind: "loaded",
  overview: { integrations: [{ ...CODEX, isAvailable: false }] },
};

const LOADING: IntegrationsState = { kind: "loading" };

const FAILED: IntegrationsState = {
  kind: "failed",
  summary: "Could not write to settings.json.",
};

function markupFor(
  state: IntegrationsState,
  pending: IntegrationID | undefined = undefined,
): string {
  return renderToStaticMarkup(<IntegrationsList state={state} pending={pending} onAct={noop} />);
}

describe("the integrations pane", () => {
  test("is the section the index points search and reveal at", () => {
    expect(markupFor(BOTH)).toContain(sectionElementID("integrationsHooks"));
  });

  test("is one row per integration, each with its logo", () => {
    const markup = markupFor(BOTH);

    expect(markup).toContain("Claude Code");
    expect(markup).toContain("Codex");
    expect([...markup.matchAll(/<svg[^>]*aria-hidden/g)]).toHaveLength(2);
  });

  test("presents activity reporting as something the integration does, not a thing to install", () => {
    const markup = markupFor(BOTH);

    expect(markup).toContain("Activity reporting and session naming");
    expect(markup).not.toContain("Install Activity reporting");
    expect(markup).toContain('aria-label="Install Codex"');
    expect(markup).toContain('aria-label="Remove Claude Code"');
  });

  test("keeps the file it would write one hover away", () => {
    const markup = markupFor(BOTH);

    expect(markup).toContain('title="/Users/me/.claude/settings.json"');
    expect(markup).toContain('title="/Users/me/.codex/hooks.json"');
  });

  test("states an installed integration, and stays quiet about one that is not", () => {
    const markup = markupFor(BOTH);

    expect(markup).toContain("Installed");
    expect(markup).not.toContain("Not installed");
  });

  test("an outdated hook offers an update rather than a second install", () => {
    const markup = markupFor(OUTDATED);

    expect(markup).toContain("Needs updating");
    expect(markup).toContain(">Update</button>");
  });

  test("an unreadable configuration is stated and its action refused", () => {
    const markup = markupFor(UNREADABLE);

    expect(markup).toContain("Unreadable: not JSON");
    expect(markup).toContain('disabled=""');
  });

  test("a missing executable still offers the install: the agent may arrive later", () => {
    const markup = markupFor(UNAVAILABLE);

    expect(markup).toContain("codex is not on your PATH");
    expect(markup).toContain(">Install</button>");
    expect(markup).not.toContain('disabled=""');
  });

  test("the row being acted on takes no second press", () => {
    expect(markupFor(BOTH, "codex")).toContain('disabled=""');
  });

  test("a request that failed is shown, not swallowed", () => {
    const markup = markupFor(FAILED);

    expect(markup).toContain("Could not write to settings.json.");
    expect(markup).not.toContain(">Install</button>");
  });

  test("says nothing about the agents until the daemon has answered", () => {
    const markup = markupFor(LOADING);

    expect(markup).not.toContain("Claude Code");
    expect(markup).toContain(sectionElementID("integrationsHooks"));
  });
});
