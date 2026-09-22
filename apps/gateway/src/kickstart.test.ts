import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";

import { log, nullLogSink, setLogSink, type LogRecord } from "@janela/support";
import type { ProcessOutcome, ProcessRequest } from "@janela/support/process";

import { KICKSTART_THROTTLE_MS, LAUNCH_AGENT_LABEL, launchAgentKickstart } from "./kickstart.ts";

interface Attempts {
  readonly requests: ProcessRequest[];
  readonly records: LogRecord[];
  run(request: ProcessRequest): Promise<ProcessOutcome>;
  settled(count: number): Promise<void>;
}

const SUCCEEDED: ProcessOutcome = {
  standardOutput: "",
  standardError: "",
  exitCode: 0,
  succeeded: true,
  timedOut: false,
};

function recordAttempts(outcome: () => Promise<ProcessOutcome>): Attempts {
  const requests: ProcessRequest[] = [];
  const records: LogRecord[] = [];
  let waiting: { readonly count: number; readonly resolve: () => void }[] = [];

  setLogSink({
    write: (record) => {
      records.push(record);

      const due = waiting.filter((candidate) => candidate.count <= records.length);
      waiting = waiting.filter((candidate) => candidate.count > records.length);

      for (const waiter of due) waiter.resolve();
    },
  });

  return {
    requests,
    records,
    run: (request) => {
      requests.push(request);

      return outcome();
    },
    settled: (count) =>
      records.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiting.push({ count, resolve });
          }),
  };
}

afterEach(() => {
  setLogSink(nullLogSink);
});

describe("launchAgentKickstart", () => {
  test("asks launchctl for this user's own janelad", async () => {
    const attempts = recordAttempts(() => Promise.resolve(SUCCEEDED));
    const kickstart = launchAgentKickstart({
      run: attempts.run,
      uid: 501,
      now: () => 0,
      log: log("app"),
    });

    kickstart();

    await attempts.settled(1);

    expect(attempts.requests).toEqual([
      {
        executable: "/bin/launchctl",
        arguments: ["kickstart", `gui/501/${LAUNCH_AGENT_LABEL}`],
        workingDirectory: homedir(),
        timeoutMs: 5000,
      },
    ]);

    expect(attempts.records[0]?.fields).toEqual({ exitCode: 0 });
  });

  test("a storm of unreachable-daemon reports spawns one launchctl per window", async () => {
    const attempts = recordAttempts(() => Promise.resolve(SUCCEEDED));
    let clock = 10_000;
    const kickstart = launchAgentKickstart({
      run: attempts.run,
      uid: 501,
      now: () => clock,
      log: log("app"),
    });

    kickstart();
    kickstart();
    clock += KICKSTART_THROTTLE_MS - 1;
    kickstart();
    clock += 1;
    kickstart();

    await attempts.settled(2);

    expect(attempts.requests.length).toBe(2);
    expect(attempts.records.length).toBe(2);
  });

  test("a launchctl that cannot be spawned is logged, not thrown", async () => {
    const attempts = recordAttempts(() => Promise.reject(new TypeError("no such file")));
    const kickstart = launchAgentKickstart({
      run: attempts.run,
      uid: 501,
      now: () => 0,
      log: log("app"),
    });

    kickstart();

    await attempts.settled(1);

    expect(attempts.records[0]?.fields).toEqual({ error: "TypeError" });
  });
});
