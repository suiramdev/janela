import { describe, expect, test } from "bun:test";

import type { Session, TerminalID, TerminalState } from "@janela/core";
import { renderToStaticMarkup } from "react-dom/server";

import {
  SERVICE_CONFIRM_TITLE,
  SERVICE_REQUEST_TITLE,
  serviceStopCost,
} from "./background-service.ts";
import { DEFAULT_GLOBAL_SETTINGS, withSilencedConfirmation } from "./global-settings.ts";
import { ServiceCostConfirmation, SettingsGeneral } from "./settings-general.tsx";
import {
  fakeProfile,
  fakeSession,
  fakeShellProfile,
  fakeTerminal,
  recordingService,
  reportedAvailable,
  states,
} from "./test-fakes.ts";

const noop = (): void => {};

const SHELL = fakeShellProfile();
const CLAUDE = fakeProfile({ name: "Claude Code" });
const MISSING = fakeProfile({ name: "OpenCode", command: ["opencode"] });

const SHELL_AND_CLAUDE = [SHELL, CLAUDE];
const SHELL_AND_MISSING = [SHELL, MISSING];
const BOTH_AVAILABLE = reportedAvailable(SHELL, CLAUDE);
const SHELL_AVAILABLE = reportedAvailable(SHELL);

const RUNNING = fakeTerminal();
const IDLE = fakeTerminal();
const BUSY_SESSIONS = [fakeSession({ terminals: [RUNNING] }), fakeSession({ terminals: [IDLE] })];
const BUSY_STATES = states([RUNNING.id, { kind: "running" }], [IDLE.id, { kind: "idle" }]);
const BUSY_COST = serviceStopCost(BUSY_SESSIONS, BUSY_STATES);

const NO_SESSIONS: readonly Session[] = [];
const NO_STATES: Readonly<Record<TerminalID, TerminalState>> = states();
const QUIET_COST = serviceStopCost(NO_SESSIONS, NO_STATES);

const SERVICE = recordingService();

/** The state of this pane's one switch, as announced. */
function ariaChecked(markup: string): string | undefined {
  return /role="switch"[^>]*aria-checked="(?<state>[a-z]+)"/u.exec(markup)?.groups?.["state"];
}

function paneMarkup(): string {
  return renderToStaticMarkup(
    <SettingsGeneral
      settings={DEFAULT_GLOBAL_SETTINGS}
      onChange={noop}
      profiles={SHELL_AND_CLAUDE}
      availability={BOTH_AVAILABLE}
      sessions={BUSY_SESSIONS}
      terminalStates={BUSY_STATES}
      service={SERVICE}
    />,
  );
}

describe("the default profile", () => {
  test("offers the available profiles and an explicit unset option", () => {
    const markup = paneMarkup();
    expect(markup).toContain("Default launch profile");
    expect(markup).toContain("Your login shell");
    expect(markup).toContain("Claude Code");
  });

  test("says that a project's own choice wins", () => {
    // Asserted without the apostrophe: React escapes it to `&#x27;`.
    expect(paneMarkup()).toContain("choice always wins");
  });

  test("hides a profile that is not on PATH", () => {
    const markup = renderToStaticMarkup(
      <SettingsGeneral
        settings={DEFAULT_GLOBAL_SETTINGS}
        onChange={noop}
        profiles={SHELL_AND_MISSING}
        availability={SHELL_AVAILABLE}
        sessions={NO_SESSIONS}
        terminalStates={NO_STATES}
        service={SERVICE}
      />,
    );
    expect(markup).not.toContain("OpenCode");
  });
});

describe("the background service controls", () => {
  test("state what is running before anything is pressed", () => {
    expect(paneMarkup()).toContain("2 sessions, 1 with a live terminal");
  });

  test("offer both actions", () => {
    const markup = paneMarkup();
    expect(markup).toContain(SERVICE_REQUEST_TITLE.stop);
    expect(markup).toContain(SERVICE_REQUEST_TITLE.stopAndUnregister);
  });

  test("show no confirmation, and no destructive button, until one is pressed", () => {
    // The rendered half of the two-step rule: nothing that acts is on screen
    // before the cost is. `serviceControlReducer` covers the other half.
    const markup = paneMarkup();
    expect(markup).not.toContain(SERVICE_CONFIRM_TITLE.stop);
    expect(markup).not.toContain(SERVICE_CONFIRM_TITLE.stopAndUnregister);
    expect(markup).not.toContain("Keep it running");
  });

  test("never call the service just by rendering", () => {
    paneMarkup();
    expect(SERVICE.calls).toEqual([]);
  });
});

describe("the confirmation", () => {
  test("states the cost in terminals, then offers the action", () => {
    const markup = renderToStaticMarkup(
      <ServiceCostConfirmation request="stop" cost={BUSY_COST} onConfirm={noop} onCancel={noop} />,
    );

    expect(markup).toContain("2 sessions, 1 with a live terminal");
    expect(markup).toContain("1 live terminal");
    expect(markup).toContain(SERVICE_CONFIRM_TITLE.stop);
    expect(markup).toContain("Keep it running");
  });

  test("unregistering states the extra cost the plain stop does not have", () => {
    const markup = renderToStaticMarkup(
      <ServiceCostConfirmation
        request="stopAndUnregister"
        cost={BUSY_COST}
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(markup).toContain("Login Items");
    expect(markup).toContain(SERVICE_CONFIRM_TITLE.stopAndUnregister);
  });

  test("names itself, so it cannot be read against the wrong action", () => {
    const markup = renderToStaticMarkup(
      <ServiceCostConfirmation
        request="stopAndUnregister"
        cost={QUIET_COST}
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    // Names the action it is confirming, and only that one: the sentence and the
    // two buttons must be readable against the press that produced them.
    expect(markup).toContain(SERVICE_REQUEST_TITLE.stopAndUnregister);
    expect(markup).not.toContain(SERVICE_REQUEST_TITLE.stop);
    expect(markup).toContain("Keep it running");
  });
});

describe("the confirmations section", () => {
  test("offers the one silenceable question, on by default", () => {
    const markup = paneMarkup();
    expect(markup).toContain("Ask before closing a running terminal");
    // The switch mirrors "is it asked", not "is it silenced": on means asking.
    expect(markup).toContain("Idle and finished terminals never ask");
  });

  test("reads as off once the question has been silenced", () => {
    const markup = renderToStaticMarkup(
      <SettingsGeneral
        settings={withSilencedConfirmation(DEFAULT_GLOBAL_SETTINGS, "closeTerminals", true)}
        onChange={noop}
        profiles={SHELL_AND_CLAUDE}
        availability={BOTH_AVAILABLE}
        sessions={NO_SESSIONS}
        terminalStates={NO_STATES}
        service={SERVICE}
      />,
    );
    // Read off the switch's `aria-checked`, which is what a screen reader says
    // and the only unambiguous copy of the state — the `data-checked` attribute
    // also appears inside Tailwind variant class names. This pane has one
    // switch, and what is pinned is the direction: silencing turns it off, and
    // an inverted row would announce the opposite of what it does.
    expect(ariaChecked(markup)).toBe("false");
    expect(ariaChecked(paneMarkup())).toBe("true");
  });
});
