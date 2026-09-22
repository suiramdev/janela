import type { AppUpdateFlow, AppUpdating, AvailableUpdate } from "@janela/ui";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { Effect, Match } from "effect";

export type UpdateHandle = Pick<Update, "version" | "downloadAndInstall" | "close">;

export type UpdateChecker = () => Promise<UpdateHandle | null>;

export type Relauncher = () => Promise<void>;

export type UpdateTimers = Pick<typeof globalThis, "setTimeout" | "setInterval">;

interface AppUpdateDeps {
  readonly check?: UpdateChecker | undefined;
  readonly relaunch?: Relauncher | undefined;
  readonly isDevelopmentBuild?: boolean | undefined;
}

export const DEVELOPMENT_BUILD_ERROR = "development build";

export const FIRST_UPDATE_CHECK_MS = 30_000;

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function availableUpdate(update: UpdateHandle): AvailableUpdate {
  return {
    version: update.version,
    install(onProgress): Promise<void> {
      let downloaded = 0;
      let total: number | undefined;

      const onEvent = (event: DownloadEvent): void =>
        Match.value(event).pipe(
          Match.when({ event: "Started" }, ({ data }) => {
            total = data.contentLength;
          }),
          Match.when({ event: "Progress" }, ({ data }) => {
            downloaded += data.chunkLength;
            onProgress(downloaded, total);
          }),
          Match.when({ event: "Finished" }, () => undefined),
          Match.exhaustive,
        );

      return Effect.runPromise(
        Effect.tryPromise({
          try: () => update.downloadAndInstall(onEvent),
          catch: (cause) => cause,
        }).pipe(Effect.ensuring(Effect.ignore(Effect.tryPromise(() => update.close())))),
      );
    },
  };
}

export function tauriAppUpdater(deps: AppUpdateDeps = {}): AppUpdating {
  const checkFn: UpdateChecker = deps.check ?? check;
  const relaunchFn: Relauncher = deps.relaunch ?? relaunch;
  const isDevelopmentBuild = deps.isDevelopmentBuild ?? import.meta.env.DEV;

  return {
    async check(): Promise<AvailableUpdate | undefined> {
      if (isDevelopmentBuild) throw new Error(DEVELOPMENT_BUILD_ERROR);

      const update = await checkFn();

      return update === null ? undefined : availableUpdate(update);
    },

    relaunch: relaunchFn,
  };
}

export function scheduleUpdateChecks(
  flow: Pick<AppUpdateFlow, "check">,
  timers: UpdateTimers = globalThis,
): void {
  const run = (): void => void flow.check({ announced: false });

  timers.setTimeout(run, FIRST_UPDATE_CHECK_MS);
  timers.setInterval(run, UPDATE_CHECK_INTERVAL_MS);
}
