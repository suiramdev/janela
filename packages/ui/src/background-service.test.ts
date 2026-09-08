import { describe, expect, test } from "bun:test";

import {
  NO_SERVICE_CONFIRMATION,
  SERVICE_CONFIRM_TITLE,
  SERVICE_REQUEST_TITLE,
  serviceControlReducer,
  serviceRequestCost,
  serviceStopCost,
} from "./background-service.ts";
import { fakeSession, fakeTerminal, states } from "./test-fakes.ts";

describe("serviceStopCost", () => {
  test("counts sessions with live terminals, and the terminals themselves", () => {
    const running = fakeTerminal();
    const alsoRunning = fakeTerminal();
    const attention = fakeTerminal();
    const idle = fakeTerminal();

    const cost = serviceStopCost(
      [
        fakeSession({ terminals: [running, alsoRunning] }),
        fakeSession({ terminals: [attention] }),
        fakeSession({ terminals: [idle] }),
      ],
      states(
        [running.id, { kind: "running" }],
        [alsoRunning.id, { kind: "running" }],
        [attention.id, { kind: "needsAttention" }],
        [idle.id, { kind: "idle" }],
      ),
    );

    expect(cost.sessionCount).toBe(3);
    expect(cost.liveSessionCount).toBe(2);
    expect(cost.liveTerminalCount).toBe(3);
    expect(cost.sentence).toBe("3 sessions, 2 with live terminals");
  });

  test("a terminal the daemon has not reported on is not live", () => {
    // Never inferred from what this client did: an unknown id means idle, so we
    // do not overstate the cost and frighten someone out of a safe action.
    const unreported = fakeTerminal();
    const cost = serviceStopCost([fakeSession({ terminals: [unreported] })], states());
    expect(cost.liveTerminalCount).toBe(0);
    expect(cost.sentence).toBe("1 session, none with live terminals");
  });

  test("an exited or failed terminal is not live", () => {
    const exited = fakeTerminal();
    const failed = fakeTerminal();
    const cost = serviceStopCost(
      [fakeSession({ terminals: [exited, failed] })],
      states(
        [exited.id, { kind: "exited", code: 0 }],
        [failed.id, { kind: "failed", message: "no such file" }],
      ),
    );
    expect(cost.liveSessionCount).toBe(0);
  });

  test("singular forms read as English, not as a template", () => {
    const running = fakeTerminal();
    const cost = serviceStopCost(
      [fakeSession({ terminals: [running] })],
      states([running.id, { kind: "running" }]),
    );
    expect(cost.sentence).toBe("1 session, 1 with a live terminal");
  });

  test("no sessions at all says so", () => {
    expect(serviceStopCost([], states()).sentence).toBe("No sessions");
  });
});

describe("the stated cost", () => {
  test("names the number of terminals that will close", () => {
    const first = fakeTerminal();
    const second = fakeTerminal();
    const cost = serviceStopCost(
      [fakeSession({ terminals: [first, second] })],
      states([first.id, { kind: "running" }], [second.id, { kind: "running" }]),
    );

    const stated = serviceRequestCost("stop", cost);
    // The number is the part that makes someone stop and read, so it must be in
    // the sentence rather than implied by "are you sure?".
    expect(stated).toContain("2 live terminals");
    expect(stated).toContain("closes");
    expect(stated).not.toContain("are you sure");
  });

  test("says plainly when nothing would be lost", () => {
    const cost = serviceStopCost([fakeSession()], states());
    expect(serviceRequestCost("stop", cost)).toContain("Nothing is running");
  });

  test("unregistering adds the cost the plain stop does not have", () => {
    const cost = serviceStopCost([], states());
    const stated = serviceRequestCost("stopAndUnregister", cost);
    expect(stated).toContain("Login Items");
    expect(serviceRequestCost("stop", cost)).not.toContain("Login Items");
  });

  test("both controls have a title and a distinct confirm label", () => {
    for (const request of ["stop", "stopAndUnregister"] as const) {
      expect(SERVICE_REQUEST_TITLE[request].length).toBeGreaterThan(0);
      expect(SERVICE_CONFIRM_TITLE[request]).not.toBe("OK");
    }
  });
});

describe("the two-step rule", () => {
  test("pressing a control performs nothing — it only reveals the cost", () => {
    // The load-bearing assertion of this file. If `perform` is ever set here,
    // the app has terminated a user's terminals on one click.
    const outcome = serviceControlReducer(NO_SERVICE_CONFIRMATION, {
      kind: "request",
      request: "stop",
    });
    expect(outcome.perform).toBeUndefined();
    expect(outcome.confirmation.pending).toBe("stop");
  });

  test("confirming the pending request performs it, once", () => {
    const shown = serviceControlReducer(NO_SERVICE_CONFIRMATION, {
      kind: "request",
      request: "stopAndUnregister",
    }).confirmation;

    const confirmed = serviceControlReducer(shown, {
      kind: "confirm",
      request: "stopAndUnregister",
    });
    expect(confirmed.perform).toBe("stopAndUnregister");
    expect(confirmed.confirmation.pending).toBeUndefined();

    // A second confirm has nothing pending, so it cannot fire again.
    expect(
      serviceControlReducer(confirmed.confirmation, {
        kind: "confirm",
        request: "stopAndUnregister",
      }).perform,
    ).toBeUndefined();
  });

  test("confirming a request that is not the pending one performs nothing", () => {
    // The user pressed Stop, read the cost, then pressed Stop and Unregister. A
    // stale confirm must not perform the request they walked away from.
    const shown = serviceControlReducer(NO_SERVICE_CONFIRMATION, {
      kind: "request",
      request: "stop",
    }).confirmation;

    expect(
      serviceControlReducer(shown, { kind: "confirm", request: "stopAndUnregister" }).perform,
    ).toBeUndefined();
  });

  test("cancelling clears the pending request and performs nothing", () => {
    const shown = serviceControlReducer(NO_SERVICE_CONFIRMATION, {
      kind: "request",
      request: "stop",
    }).confirmation;

    const cancelled = serviceControlReducer(shown, { kind: "cancel" });
    expect(cancelled.perform).toBeUndefined();
    expect(cancelled.confirmation.pending).toBeUndefined();
    // And a confirm after cancelling is inert.
    expect(
      serviceControlReducer(cancelled.confirmation, { kind: "confirm", request: "stop" }).perform,
    ).toBeUndefined();
  });

  test("switching controls replaces what is pending rather than queueing both", () => {
    const stop = serviceControlReducer(NO_SERVICE_CONFIRMATION, {
      kind: "request",
      request: "stop",
    }).confirmation;
    const switched = serviceControlReducer(stop, {
      kind: "request",
      request: "stopAndUnregister",
    });
    expect(switched.confirmation.pending).toBe("stopAndUnregister");
    expect(switched.perform).toBeUndefined();
  });
});
