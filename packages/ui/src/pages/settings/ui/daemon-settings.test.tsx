import { describe, expect, test } from "bun:test";

import type { Session, TerminalID, TerminalState } from "@janela/core";
import { renderToStaticMarkup } from "react-dom/server";

import {
  fakeSession,
  fakeTerminal,
  recordingService,
  states,
} from "../../../shared/lib/test-fakes/index.ts";
import {
  SERVICE_CONFIRM_TITLE,
  SERVICE_REQUEST_TITLE,
  serviceStopCost,
} from "../../../shared/model/index.ts";
import { ServiceCostConfirmation, SettingsDaemon } from "./daemon-settings.tsx";

const noop = (): void => {};

const RUNNING = fakeTerminal();

const IDLE = fakeTerminal();

const BUSY_SESSIONS = [fakeSession({ terminals: [RUNNING] }), fakeSession({ terminals: [IDLE] })];

const BUSY_STATES = states([RUNNING.id, { kind: "running" }], [IDLE.id, { kind: "idle" }]);

const BUSY_COST = serviceStopCost(BUSY_SESSIONS, BUSY_STATES);

const NO_SESSIONS: readonly Session[] = [];

const NO_STATES: Readonly<Record<TerminalID, TerminalState>> = states();

const QUIET_COST = serviceStopCost(NO_SESSIONS, NO_STATES);

const SERVICE = recordingService();

function paneMarkup(): string {
  return renderToStaticMarkup(
    <SettingsDaemon sessions={BUSY_SESSIONS} terminalStates={BUSY_STATES} service={SERVICE} />,
  );
}

describe("the daemon pane", () => {
  test("states what is running before anything is pressed", () => {
    expect(paneMarkup()).toContain("2 sessions, 1 with a live terminal");
  });

  test("offers both actions", () => {
    const markup = paneMarkup();

    expect(markup).toContain(SERVICE_REQUEST_TITLE.stop);
    expect(markup).toContain(SERVICE_REQUEST_TITLE.stopAndUnregister);
  });

  test("shows no confirmation, and no destructive button, until one is pressed", () => {
    const markup = paneMarkup();

    expect(markup).not.toContain(SERVICE_CONFIRM_TITLE.stop);
    expect(markup).not.toContain(SERVICE_CONFIRM_TITLE.stopAndUnregister);
    expect(markup).not.toContain("Keep it running");
  });

  test("never calls the daemon just by rendering", () => {
    paneMarkup();

    expect(SERVICE.calls).toEqual([]);
  });

  test("hides the stop controls when no local shell can stop the daemon", () => {
    const markup = renderToStaticMarkup(
      <SettingsDaemon sessions={BUSY_SESSIONS} terminalStates={BUSY_STATES} service={undefined} />,
    );

    expect(markup).toContain("2 sessions, 1 with a live terminal");
    expect(markup).not.toContain(SERVICE_REQUEST_TITLE.stop);
    expect(markup).not.toContain(SERVICE_REQUEST_TITLE.stopAndUnregister);
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

    expect(markup).toContain(SERVICE_REQUEST_TITLE.stopAndUnregister);
    expect(markup).not.toContain(SERVICE_REQUEST_TITLE.stop);
    expect(markup).toContain("Keep it running");
  });
});
