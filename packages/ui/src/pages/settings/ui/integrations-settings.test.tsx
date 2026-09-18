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
  reports: ["working", "waiting for permission", "finished"],
  status: { kind: "installed" },
};

const CODEX: IntegrationReport = {
  id: "codex",
  name: "Codex",
  executable: "codex",
  isAvailable: true,
  configPath: "/Users/me/.codex/hooks.json",
  reports: ["working", "finished"],
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

describe("the activity reporting pane", () => {
  test("is the section the index points search and reveal at", () => {
    expect(markupFor(BOTH)).toContain(sectionElementID("integrationsHooks"));
  });

  test("names every agent it knows how to report for", () => {
    const markup = markupFor(BOTH);

    expect(markup).toContain("Claude Code");
    expect(markup).toContain("Codex");
  });

  test("says which file it would write, so the change is never invisible", () => {
    const markup = markupFor(BOTH);

    expect(markup).toContain("/Users/me/.claude/settings.json");
    expect(markup).toContain("/Users/me/.codex/hooks.json");
  });

  test("lists what each agent reports", () => {
    const markup = markupFor(BOTH);

    expect(markup).toContain("waiting for permission");
    expect(markup).toContain("finished");
  });

  test("states each status, and offers the action that status allows", () => {
    const markup = markupFor(BOTH);

    expect(markup).toContain("Installed");
    expect(markup).toContain("Not installed");
    expect(markup).toContain(">Remove</button>");
    expect(markup).toContain(">Install</button>");
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
