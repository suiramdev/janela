import { describe, expect, test } from "bun:test";

import { RequestFailed, type ClientRequest } from "@janela/client";
import type { IntegrationOverview, IntegrationReport, IntegrationStatus } from "@janela/core";
import { serializeIntegrationOverview } from "@janela/protocol";

import {
  actOnIntegration,
  integrationAction,
  integrationBadgeVariant,
  integrationFailureSummary,
  integrationStatusText,
  loadIntegrations,
  type IntegrationRequesting,
} from "./integrations.ts";

interface Recording {
  readonly requests: readonly ClientRequest[];
  readonly connection: IntegrationRequesting;
}

const INSTALLED: IntegrationStatus = { kind: "installed" };

function report(overrides: Partial<IntegrationReport> = {}): IntegrationReport {
  return {
    id: "claude",
    name: "Claude Code",
    executable: "claude",
    isAvailable: true,
    configPath: "/Users/me/.claude/settings.json",
    reports: ["working", "waiting for permission"],
    status: INSTALLED,
    ...overrides,
  };
}

function recording(overview: IntegrationOverview): Recording {
  const requests: ClientRequest[] = [];

  return {
    requests,
    connection: {
      request: (message: ClientRequest) => {
        requests.push(message);

        return Promise.resolve(
          message.type === "integrations" ? serializeIntegrationOverview(overview) : undefined,
        );
      },
    },
  };
}

describe("loading the overview", () => {
  test("reads the reports out of the daemon's text reply", async () => {
    const overview: IntegrationOverview = { integrations: [report(), report({ id: "codex" })] };

    const loaded = await loadIntegrations(recording(overview).connection);

    expect(loaded.integrations.map((each) => each.id)).toEqual(["claude", "codex"]);
    expect(loaded.integrations[0]?.configPath).toBe("/Users/me/.claude/settings.json");
  });

  test("an acknowledgement with no overview is a protocol fault, not an empty list", async () => {
    const silent: IntegrationRequesting = { request: () => Promise.resolve(undefined) };

    await expect(loadIntegrations(silent)).rejects.toBeInstanceOf(TypeError);
  });
});

describe("acting on one integration", () => {
  test("an absent integration installs, then asks for the overview again", async () => {
    const absent = report({ id: "codex", status: { kind: "absent" } });
    const recorded = recording({ integrations: [absent] });

    await actOnIntegration(recorded.connection, absent);

    expect(recorded.requests).toEqual([
      { type: "installIntegration", integrationID: "codex" },
      { type: "integrations" },
    ]);
  });

  test("an outdated integration is reinstalled rather than removed", async () => {
    const outdated = report({ status: { kind: "outdated" } });
    const recorded = recording({ integrations: [outdated] });

    await actOnIntegration(recorded.connection, outdated);

    expect(recorded.requests[0]).toEqual({ type: "installIntegration", integrationID: "claude" });
  });

  test("an installed integration is removed, then read back", async () => {
    const recorded = recording({ integrations: [report()] });

    const after = await actOnIntegration(recorded.connection, report());

    expect(recorded.requests).toEqual([
      { type: "removeIntegration", integrationID: "claude" },
      { type: "integrations" },
    ]);
    expect(after.integrations).toHaveLength(1);
  });
});

describe("what the row offers", () => {
  test("the action follows the status", () => {
    expect(integrationAction(report())).toBe("remove");
    expect(integrationAction(report({ status: { kind: "outdated" } }))).toBe("update");
    expect(integrationAction(report({ status: { kind: "absent" } }))).toBe("install");
  });

  test("an unreadable configuration offers install, which the row disables", () => {
    expect(integrationAction(report({ status: { kind: "unreadable", reason: "bad JSON" } }))).toBe(
      "install",
    );
  });

  test("the status reads as a sentence about that agent", () => {
    expect(integrationStatusText(report())).toBe("Installed");
    expect(integrationStatusText(report({ status: { kind: "outdated" } }))).toBe("Needs updating");
    expect(integrationStatusText(report({ status: { kind: "absent" } }))).toBe("Not installed");
  });

  test("an unreadable configuration says why", () => {
    const unreadable = report({ status: { kind: "unreadable", reason: "settings.json is empty" } });

    expect(integrationStatusText(unreadable)).toBe("Unreadable: settings.json is empty");
  });

  test("a missing executable is what the badge says, whatever the configuration holds", () => {
    const missing = report({ isAvailable: false });

    expect(integrationStatusText(missing)).toBe("claude is not on your PATH");
    expect(integrationBadgeVariant(missing)).toBe("outline");
  });

  test("only an unreadable configuration reads as a problem", () => {
    expect(integrationBadgeVariant(report())).toBe("secondary");
    expect(integrationBadgeVariant(report({ status: { kind: "absent" } }))).toBe("outline");
    expect(integrationBadgeVariant(report({ status: { kind: "outdated" } }))).toBe("outline");
    expect(integrationBadgeVariant(report({ status: { kind: "unreadable", reason: "no" } }))).toBe(
      "destructive",
    );
  });
});

describe("a failed request", () => {
  test("is shown in the daemon's own words", () => {
    const failed = new RequestFailed({ summary: "Couldn't write to settings.json." });

    expect(integrationFailureSummary(failed)).toBe("Couldn't write to settings.json.");
  });

  test("falls back to the connection when the cause is not one the daemon sent", () => {
    expect(integrationFailureSummary(new Error("socket closed"))).toBe(
      "Could not reach the background service.",
    );
  });
});
