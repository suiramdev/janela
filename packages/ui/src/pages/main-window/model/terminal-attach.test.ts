import { describe, expect, test } from "bun:test";

import type { DaemonConnection } from "@janela/client";
import type { GridSize } from "@janela/core";

import { terminal, terminalID } from "./session-fixture.ts";
import { attachPane, shouldStartOnAttach } from "./terminal-attach.ts";

interface RecordingConnection {
  readonly connection: Pick<DaemonConnection, "request" | "onOutput">;
  readonly calls: string[];
  readonly requests: unknown[];
}

function recordingConnection(options: { readonly failing?: boolean } = {}): RecordingConnection {
  const calls: string[] = [];
  const requests: unknown[] = [];

  return {
    calls,
    requests,
    connection: {
      onOutput: (_id, _handler) => {
        calls.push("onOutput");

        return () => calls.push("unsubscribe");
      },
      request: async (message) => {
        calls.push(message.type);
        requests.push(message);

        if (options.failing === true) throw new Error("no connection");

        return undefined;
      },
    },
  };
}

describe("attachPane", () => {
  const viewport: GridSize = { columns: 80, rows: 24 };

  test("subscribes before attaching: the reply is a full repaint", () => {
    const { connection, calls, requests } = recordingConnection();

    attachPane(connection, terminalID("t"), () => {}, viewport);

    expect(calls).toEqual(["onOutput", "attach"]);
    expect(requests[0]).toEqual({ type: "attach", terminalID: terminalID("t"), viewport });
  });

  test("cleanup unsubscribes, then detaches", () => {
    const { connection, calls } = recordingConnection();

    attachPane(connection, terminalID("t"), () => {}, viewport)();

    expect(calls).toEqual(["onOutput", "attach", "unsubscribe", "detach"]);
  });

  test("a rejected request does not throw at the caller", async () => {
    const { connection } = recordingConnection({ failing: true });

    const release = attachPane(connection, terminalID("t"), () => {}, viewport);
    release();
    await Promise.resolve();
  });
});

describe("shouldStartOnAttach", () => {
  const configured = terminal("t1");
  const automatic = { ...configured, startsAutomatically: true };

  test("a session just created here starts its shell on the first attach", () => {
    expect(shouldStartOnAttach(automatic, undefined)).toBe(true);
    expect(shouldStartOnAttach(automatic, { kind: "idle" })).toBe(true);
  });

  test("a restored terminal spawns nothing: relaunching the app is not a start", () => {
    expect(shouldStartOnAttach(configured, undefined)).toBe(false);
  });

  test("a terminal that is running, or has finished, is left alone", () => {
    expect(shouldStartOnAttach(automatic, { kind: "running" })).toBe(false);
    expect(shouldStartOnAttach(automatic, { kind: "exited", code: 0 })).toBe(false);
    expect(shouldStartOnAttach(automatic, { kind: "failed", message: "no such" })).toBe(false);
    expect(shouldStartOnAttach(undefined, undefined)).toBe(false);
  });
});
