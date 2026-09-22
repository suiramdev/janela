import { describe, expect, test } from "bun:test";

import type { Logger, LogRecord } from "@janela/support";

import { fakeClientEnvironment } from "../lib/test-fakes/index.ts";
import {
  type AppUpdateFlow,
  type AppUpdateState,
  type AvailableUpdate,
  createAppUpdateFlow,
  UPDATE_CHECK_FAILED_COPY,
  UPDATE_INSTALL_FAILED_COPY,
  UPDATE_RELAUNCH_FAILED_COPY,
} from "./app-update.ts";
import type { ViewState } from "./view-state.ts";

interface Recorded {
  readonly level: string;
  readonly message: string;
  readonly fields: LogRecord["fields"];
}

interface Harness {
  readonly view: ViewState;
  readonly records: Recorded[];
  readonly checks: number;
  readonly progress: ((downloaded: number, total: number | undefined) => void) | undefined;
  readonly flow: AppUpdateFlow;
  readonly answer: {
    readonly resolve: (update: AvailableUpdate | undefined) => void;
    readonly reject: (cause: unknown) => void;
  };
  readonly installation: {
    readonly resolve: () => void;
    readonly reject: (cause: unknown) => void;
  };
  readonly relaunches: number;
}

function harness(options: { readonly relaunchFails?: boolean } = {}): Harness {
  const { view } = fakeClientEnvironment();
  const records: Recorded[] = [];

  const at =
    (level: string) =>
    (message: string, fields: LogRecord["fields"] = undefined): void => {
      records.push({ level, message, fields });
    };

  const logger: Logger = {
    debug: at("debug"),
    info: at("info"),
    notice: at("notice"),
    warning: at("warning"),
    error: at("error"),
  };

  let checks = 0;
  let relaunches = 0;
  let progress: Harness["progress"];
  let answer = Promise.withResolvers<AvailableUpdate | undefined>();
  let installation = Promise.withResolvers<void>();

  const flow = createAppUpdateFlow({
    view,
    logger,
    updater: {
      check() {
        checks += 1;
        answer = Promise.withResolvers<AvailableUpdate | undefined>();

        return answer.promise;
      },
      relaunch() {
        relaunches += 1;

        return options.relaunchFails === true
          ? Promise.reject(new Error("no relaunch"))
          : Promise.resolve();
      },
    },
  });

  const update = (version: string): AvailableUpdate => ({
    version,
    install(onProgress) {
      progress = onProgress;
      installation = Promise.withResolvers<void>();

      return installation.promise;
    },
  });

  return {
    view,
    records,
    flow,
    get checks() {
      return checks;
    },
    get progress() {
      return progress;
    },
    get relaunches() {
      return relaunches;
    },
    answer: {
      resolve: (offered) =>
        answer.resolve(offered === undefined ? undefined : update(offered.version)),
      reject: (cause) => answer.reject(cause),
    },
    installation: {
      resolve: () => installation.resolve(),
      reject: (cause) => installation.reject(cause),
    },
  };
}

function found(version: string): AvailableUpdate {
  return { version, install: () => Promise.resolve() };
}

async function reachAvailable(context: Harness, version = "0.2.0"): Promise<void> {
  const checking = context.flow.check({ announced: true });

  context.answer.resolve(found(version));
  await checking;

  expect(context.view.appUpdate).toEqual({ kind: "available", version });
}

describe("a check", () => {
  test("that finds nothing ends up to date when announced, and idle when quiet", async () => {
    const context = harness();

    const announced = context.flow.check({ announced: true });

    expect(context.view.appUpdate).toEqual({ kind: "checking", announced: true });

    context.answer.resolve(undefined);
    await announced;

    expect(context.view.appUpdate).toEqual({ kind: "upToDate" });

    context.flow.dismiss();

    const quiet = context.flow.check({ announced: false });

    expect(context.view.appUpdate).toEqual({ kind: "checking", announced: false });

    context.answer.resolve(undefined);
    await quiet;

    expect(context.view.appUpdate).toEqual({ kind: "idle" });
  });

  test("that fails quietly is logged by name and shows nothing", async () => {
    const context = harness();

    const quiet = context.flow.check({ announced: false });

    context.answer.reject(new TypeError("offline"));
    await quiet;

    expect(context.view.appUpdate).toEqual({ kind: "idle" });
    expect(context.records).toEqual([
      { level: "warning", message: "update check failed", fields: { error: "TypeError" } },
    ]);
  });

  test("that fails when announced shows the settled copy", async () => {
    const context = harness();

    const announced = context.flow.check({ announced: true });

    context.answer.reject(new Error("offline"));
    await announced;

    expect(context.view.appUpdate).toEqual({ kind: "failed", text: UPDATE_CHECK_FAILED_COPY });
  });

  test("that finds an update offers it", async () => {
    const context = harness();

    await reachAvailable(context, "0.3.0");
  });

  test("issued while one is in flight, downloading or ready is ignored", async () => {
    const context = harness();

    const first = context.flow.check({ announced: true });

    await context.flow.check({ announced: false });

    expect(context.checks).toBe(1);

    context.answer.resolve(found("0.2.0"));
    await first;

    const installing = context.flow.install();

    await context.flow.check({ announced: true });

    expect(context.checks).toBe(1);

    context.installation.resolve();
    await installing;

    expect(context.view.appUpdate).toEqual({ kind: "ready", version: "0.2.0" });

    await context.flow.check({ announced: true });

    expect(context.checks).toBe(1);
  });
});

describe("install", () => {
  test("reports progress as a fraction and ends ready", async () => {
    const context = harness();

    await reachAvailable(context);

    const installing = context.flow.install();

    expect(context.view.appUpdate).toEqual({
      kind: "downloading",
      version: "0.2.0",
      fraction: undefined,
    });

    context.progress?.(25, 100);

    expect(context.view.appUpdate).toEqual({
      kind: "downloading",
      version: "0.2.0",
      fraction: 0.25,
    });

    context.progress?.(50, undefined);

    expect(context.view.appUpdate).toEqual({
      kind: "downloading",
      version: "0.2.0",
      fraction: undefined,
    });

    context.installation.resolve();
    await installing;

    expect(context.view.appUpdate).toEqual({ kind: "ready", version: "0.2.0" });
  });

  test("that fails is logged and shown", async () => {
    const context = harness();

    await reachAvailable(context);

    const installing = context.flow.install();

    context.installation.reject(new RangeError("disk full"));
    await installing;

    expect(context.view.appUpdate).toEqual({ kind: "failed", text: UPDATE_INSTALL_FAILED_COPY });
    expect(context.records.map((record) => record.fields?.["error"])).toEqual(["RangeError"]);
  });

  test("does nothing unless an update is on offer", async () => {
    const context = harness();

    await context.flow.install();

    expect(context.view.appUpdate).toEqual({ kind: "idle" });
  });
});

describe("relaunch", () => {
  test("asks the shell to restart, and says so when it cannot", async () => {
    const context = harness({ relaunchFails: true });

    await context.flow.relaunch();

    expect(context.relaunches).toBe(1);
    expect(context.view.appUpdate).toEqual({ kind: "failed", text: UPDATE_RELAUNCH_FAILED_COPY });
  });
});

describe("dismiss", () => {
  test("returns a settled state to idle, and leaves a busy one alone", async () => {
    const context = harness();

    await reachAvailable(context);

    const installing = context.flow.install();

    context.flow.dismiss();

    expect(context.view.appUpdate.kind).toBe("downloading");

    context.installation.resolve();
    await installing;

    context.flow.dismiss();

    expect(context.view.appUpdate).toEqual({ kind: "idle" } satisfies AppUpdateState);
  });

  test("forgets the offered update, so install after dismiss is a no-op", async () => {
    const context = harness();

    await reachAvailable(context);
    context.flow.dismiss();
    await context.flow.install();

    expect(context.view.appUpdate).toEqual({ kind: "idle" });
  });
});
