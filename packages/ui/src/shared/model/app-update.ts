import type { Logger } from "@janela/support";
import { Effect, Result } from "effect";

export interface AvailableUpdate {
  readonly version: string;
  install(onProgress: (downloaded: number, total: number | undefined) => void): Promise<void>;
}

export interface AppUpdating {
  check(): Promise<AvailableUpdate | undefined>;
  relaunch(): Promise<void>;
}

export type AppUpdateState =
  | { readonly kind: "idle" }
  | { readonly kind: "checking"; readonly announced: boolean }
  | { readonly kind: "upToDate" }
  | { readonly kind: "available"; readonly version: string }
  | {
      readonly kind: "downloading";
      readonly version: string;
      readonly fraction: number | undefined;
    }
  | { readonly kind: "ready"; readonly version: string }
  | { readonly kind: "failed"; readonly text: string };

export interface AppUpdateView {
  readonly appUpdate: AppUpdateState;
  setAppUpdate(state: AppUpdateState): void;
}

export interface AppUpdateFlow {
  check(options: { readonly announced: boolean }): Promise<void>;
  install(): Promise<void>;
  relaunch(): Promise<void>;
  dismiss(): void;
}

export const UPDATE_CHECK_FAILED_COPY = "Could not check for updates.";

export const UPDATE_INSTALL_FAILED_COPY = "The update could not be installed.";

export const UPDATE_RELAUNCH_FAILED_COPY =
  "Janela could not restart itself. Quit and reopen it to finish the update.";

const IDLE: AppUpdateState = { kind: "idle" };

const UP_TO_DATE: AppUpdateState = { kind: "upToDate" };

const BUSY = {
  idle: false,
  checking: true,
  upToDate: false,
  available: false,
  downloading: true,
  ready: true,
  failed: false,
} satisfies Record<AppUpdateState["kind"], boolean>;

const DISMISSABLE = {
  idle: false,
  checking: false,
  upToDate: true,
  available: true,
  downloading: false,
  ready: true,
  failed: true,
} satisfies Record<AppUpdateState["kind"], boolean>;

function attempt<Value>(run: () => Promise<Value>): Promise<Result.Result<Value, unknown>> {
  return Effect.runPromise(Effect.result(Effect.tryPromise({ try: run, catch: (cause) => cause })));
}

function errorName(cause: unknown): string {
  return cause instanceof Error ? cause.name : "unknown";
}

export function createAppUpdateFlow(deps: {
  readonly updater: AppUpdating;
  readonly view: AppUpdateView;
  readonly logger: Logger;
}): AppUpdateFlow {
  const { updater, view, logger } = deps;

  let held: AvailableUpdate | undefined;

  return {
    async check(options: { readonly announced: boolean }): Promise<void> {
      if (BUSY[view.appUpdate.kind]) return;

      const { announced } = options;

      view.setAppUpdate({ kind: "checking", announced });

      const checked = await attempt(() => updater.check());

      if (Result.isFailure(checked)) {
        logger.warning("update check failed", { error: errorName(checked.failure) });
        view.setAppUpdate(announced ? { kind: "failed", text: UPDATE_CHECK_FAILED_COPY } : IDLE);

        return;
      }

      held = checked.success;

      if (held === undefined) {
        view.setAppUpdate(announced ? UP_TO_DATE : IDLE);

        return;
      }

      view.setAppUpdate({ kind: "available", version: held.version });
    },

    async install(): Promise<void> {
      const update = held;

      if (view.appUpdate.kind !== "available" || update === undefined) return;

      const { version } = update;

      view.setAppUpdate({ kind: "downloading", version, fraction: undefined });

      const installed = await attempt(() =>
        update.install((downloaded, total) => {
          view.setAppUpdate({
            kind: "downloading",
            version,
            fraction: total === undefined ? undefined : downloaded / total,
          });
        }),
      );

      if (Result.isFailure(installed)) {
        logger.warning("update install failed", { error: errorName(installed.failure) });
        view.setAppUpdate({ kind: "failed", text: UPDATE_INSTALL_FAILED_COPY });

        return;
      }

      view.setAppUpdate({ kind: "ready", version });
    },

    async relaunch(): Promise<void> {
      const relaunched = await attempt(() => updater.relaunch());

      if (Result.isFailure(relaunched)) {
        logger.warning("update relaunch failed", { error: errorName(relaunched.failure) });
        view.setAppUpdate({ kind: "failed", text: UPDATE_RELAUNCH_FAILED_COPY });
      }
    },

    dismiss(): void {
      if (!DISMISSABLE[view.appUpdate.kind]) return;

      held = undefined;
      view.setAppUpdate(IDLE);
    },
  };
}
