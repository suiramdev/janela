import { describe, expect, test } from "bun:test";

import type { DownloadEvent } from "@tauri-apps/plugin-updater";

import {
  DEVELOPMENT_BUILD_ERROR,
  FIRST_UPDATE_CHECK_MS,
  scheduleUpdateChecks,
  tauriAppUpdater,
  UPDATE_CHECK_INTERVAL_MS,
  type UpdateHandle,
} from "./app-update.ts";

function fakeUpdate(events: readonly DownloadEvent[], fails = false) {
  let closed = 0;

  const handle: UpdateHandle = {
    version: "0.2.0",
    downloadAndInstall(onEvent) {
      for (const event of events) onEvent?.(event);

      return fails ? Promise.reject(new Error("checksum")) : Promise.resolve();
    },
    close() {
      closed += 1;

      return Promise.resolve();
    },
  };

  return {
    handle,
    get closed() {
      return closed;
    },
  };
}

function started(contentLength: number | undefined): DownloadEvent {
  return { event: "Started", data: contentLength === undefined ? {} : { contentLength } };
}

function progressed(chunkLength: number): DownloadEvent {
  return { event: "Progress", data: { chunkLength } };
}

describe("tauriAppUpdater", () => {
  test("a development build refuses to check at all", async () => {
    let checks = 0;
    const updater = tauriAppUpdater({
      isDevelopmentBuild: true,
      check: () => {
        checks += 1;

        return Promise.resolve(null);
      },
      relaunch: () => Promise.resolve(),
    });

    await expect(updater.check()).rejects.toThrow(DEVELOPMENT_BUILD_ERROR);
    expect(checks).toBe(0);
  });

  test("nothing to install is undefined, not an update", async () => {
    const updater = tauriAppUpdater({
      isDevelopmentBuild: false,
      check: () => Promise.resolve(null),
      relaunch: () => Promise.resolve(),
    });

    expect(await updater.check()).toBeUndefined();
  });

  test("progress accumulates chunks against the announced total, and the handle is closed", async () => {
    const fake = fakeUpdate([started(100), progressed(40), progressed(60), { event: "Finished" }]);
    const updater = tauriAppUpdater({
      isDevelopmentBuild: false,
      check: () => Promise.resolve(fake.handle),
      relaunch: () => Promise.resolve(),
    });

    const update = await updater.check();

    if (update === undefined) throw new Error("expected an update");

    expect(update.version).toBe("0.2.0");

    const reported: [number, number | undefined][] = [];

    await update.install((downloaded, total) => {
      reported.push([downloaded, total]);
    });

    expect(reported).toEqual([
      [40, 100],
      [100, 100],
    ]);

    expect(fake.closed).toBe(1);
  });

  test("an unknown total is reported as undefined", async () => {
    const fake = fakeUpdate([started(undefined), progressed(10)]);
    const updater = tauriAppUpdater({
      isDevelopmentBuild: false,
      check: () => Promise.resolve(fake.handle),
      relaunch: () => Promise.resolve(),
    });

    const update = await updater.check();

    if (update === undefined) throw new Error("expected an update");

    const reported: [number, number | undefined][] = [];

    await update.install((downloaded, total) => {
      reported.push([downloaded, total]);
    });

    expect(reported).toEqual([[10, undefined]]);
  });

  test("a failed install still closes the handle and rejects", async () => {
    const fake = fakeUpdate([started(1)], true);
    const updater = tauriAppUpdater({
      isDevelopmentBuild: false,
      check: () => Promise.resolve(fake.handle),
      relaunch: () => Promise.resolve(),
    });

    const update = await updater.check();

    if (update === undefined) throw new Error("expected an update");

    await expect(update.install(() => {})).rejects.toThrow("checksum");
    expect(fake.closed).toBe(1);
  });
});

describe("scheduleUpdateChecks", () => {
  test("one quiet check after the first delay, then one per interval", () => {
    const calls: string[] = [];
    const delays: number[] = [];
    let firstRun: (() => void) | undefined;
    let repeatedRun: (() => void) | undefined;

    scheduleUpdateChecks(
      {
        check({ announced }) {
          calls.push(announced ? "announced" : "quiet");

          return Promise.resolve();
        },
      },
      {
        setTimeout: ((run: () => void, delay: number) => {
          delays.push(delay);
          firstRun = run;

          return 0;
        }) as typeof globalThis.setTimeout,
        setInterval: ((run: () => void, delay: number) => {
          delays.push(delay);
          repeatedRun = run;

          return 0;
        }) as typeof globalThis.setInterval,
      },
    );

    expect(delays).toEqual([FIRST_UPDATE_CHECK_MS, UPDATE_CHECK_INTERVAL_MS]);

    firstRun?.();
    repeatedRun?.();

    expect(calls).toEqual(["quiet", "quiet"]);
  });
});
