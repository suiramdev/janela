import type { AttentionDelivering } from "@janela/client";
import type { SessionID, TerminalID } from "@janela/core";
import type { AttentionSignal } from "@janela/protocol";
import { log, type Logger } from "@janela/support";
import type { PluginListener } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  onAction,
  removeActive,
  requestPermission,
  sendNotification,
  type Options,
} from "@tauri-apps/plugin-notification";
import { Effect, Match, Result, Schema } from "effect";

export interface AttentionTarget {
  readonly sessionID: SessionID;
  readonly terminalID: TerminalID;
}

export interface NotificationPlugin {
  isPermissionGranted(): Promise<boolean>;
  requestPermission(): Promise<NotificationPermission>;
  sendNotification(options: Options): void;
  removeActive(notifications: { id: number }[]): Promise<void>;
  onAction(handler: (notification: Options) => void): Promise<PluginListener>;
}

export interface NotificationContent {
  readonly title: string;
  readonly body: string;
}

export interface NotificationDeliveryOptions {
  readonly onActivate: (target: AttentionTarget) => void;
  readonly plugin?: NotificationPlugin | undefined;
  readonly activateWindow?: (() => Promise<void>) | undefined;
  readonly log?: Logger | undefined;
}

export const MAXIMUM_OUTSTANDING_NOTIFICATIONS = 64;

export const MAXIMUM_IN_FLIGHT_DELIVERIES = 16;

const MAXIMUM_NOTIFICATION_ID = 2_147_483_647;

const AttentionExtra = Schema.Struct({
  sessionID: Schema.String,
  terminalID: Schema.String,
});

const tauriNotifications: NotificationPlugin = {
  isPermissionGranted,
  requestPermission,
  sendNotification,
  removeActive,
  onAction,
};

export function createNotificationDelivery(
  options: NotificationDeliveryOptions,
): AttentionDelivering {
  const plugin = options.plugin ?? tauriNotifications;
  const logger = options.log ?? log("app");
  const activateWindow = options.activateWindow ?? raiseWindow;

  let authorization: "unknown" | "granted" | "denied" = "unknown";
  let asking: Promise<boolean> | undefined;

  const outstanding: { readonly id: number; readonly sessionID: SessionID }[] = [];

  const inFlight = new Set<{ readonly sessionID: SessionID; cancelled: boolean }>();

  let nextID = 1;
  let removalSupported = true;
  let clickRouting: Promise<void> | undefined;

  const authorize = async (): Promise<boolean> => {
    if (authorization !== "unknown") return authorization === "granted";

    asking ??= (async (): Promise<boolean> => {
      const asked = await Effect.runPromise(
        Effect.result(
          Effect.tryPromise({
            try: async () =>
              (await plugin.isPermissionGranted()) ||
              (await plugin.requestPermission()) === "granted",
            catch: (cause) => cause,
          }),
        ),
      );

      if (Result.isFailure(asked)) {
        authorization = "denied";
        logger.warning("notification authorization failed", { error: nameOf(asked.failure) });

        return false;
      }

      authorization = asked.success ? "granted" : "denied";
      logger.info("notification authorization", { granted: asked.success });

      return asked.success;
    })();

    return asking;
  };

  const registerClickRouting = (): void => {
    clickRouting ??= plugin
      .onAction((notification: Options) => {
        const target = targetOf(notification.extra);

        if (target === undefined) return;

        options.onActivate(target);
        void activateWindow().catch((cause: unknown) => {
          logger.debug("window activation failed", { error: nameOf(cause) });
        });
        void delivery.withdraw(target.sessionID);
      })
      .then(() => undefined)
      .catch((cause: unknown) => {
        logger.debug("notification click routing unavailable", { error: nameOf(cause) });
      });
  };

  const delivery: AttentionDelivering = {
    async deliver(input): Promise<void> {
      const { sessionID, terminalID } = input.signal;

      if (inFlight.size >= MAXIMUM_IN_FLIGHT_DELIVERIES) {
        logger.debug("notification dropped", { sessionID, inFlight: inFlight.size });

        return;
      }

      const parked = { sessionID, cancelled: false };
      inFlight.add(parked);

      const granted = await Effect.runPromise(
        Effect.ensuring(
          Effect.promise(() => authorize()),
          Effect.sync(() => {
            inFlight.delete(parked);
          }),
        ),
      );

      if (!granted) return;

      if (parked.cancelled) {
        logger.debug("notification abandoned", { sessionID });

        return;
      }

      const id = nextID;
      nextID = nextID >= MAXIMUM_NOTIFICATION_ID ? 1 : nextID + 1;

      const { title, body } = notificationContent(input);
      plugin.sendNotification({ id, title, body, extra: { sessionID, terminalID } });

      outstanding.push({ id, sessionID });

      while (outstanding.length > MAXIMUM_OUTSTANDING_NOTIFICATIONS) outstanding.shift();

      logger.debug("attention delivered", { sessionID, terminalID, notificationID: id });
      registerClickRouting();
    },

    async withdraw(sessionID: SessionID): Promise<void> {
      for (const parked of inFlight) {
        if (parked.sessionID === sessionID) parked.cancelled = true;
      }

      const ids: number[] = [];

      for (let index = outstanding.length - 1; index >= 0; index -= 1) {
        const entry = outstanding[index];

        if (entry === undefined || entry.sessionID !== sessionID) continue;

        ids.push(entry.id);
        outstanding.splice(index, 1);
      }

      if (ids.length === 0) return;

      logger.debug("attention withdrawn", { sessionID, count: ids.length });

      if (!removalSupported) return;

      const removed = await Effect.runPromise(
        Effect.result(
          Effect.tryPromise({
            try: () => plugin.removeActive(ids.map((id) => ({ id }))),
            catch: (cause) => cause,
          }),
        ),
      );

      if (Result.isFailure(removed)) {
        removalSupported = false;
        logger.debug("notification removal unsupported", { error: nameOf(removed.failure) });
      }
    },
  };

  return delivery;
}

export function notificationContent(input: {
  readonly signal: AttentionSignal;
  readonly sessionName: string;
  readonly terminalTitle: string;
}): NotificationContent {
  const title = `${input.sessionName} — ${input.terminalTitle}`;

  return Match.value(input.signal.kind).pipe(
    Match.when({ kind: "bell" }, () => ({ title, body: "Rang the bell." })),
    Match.when({ kind: "notification" }, (announced) => ({
      title,
      body:
        announced.title === undefined ? announced.body : `${announced.title}: ${announced.body}`,
    })),
    Match.when({ kind: "promptFinished" }, (finished) => {
      const seconds = Math.round(finished.durationSeconds);

      return {
        title,
        body:
          finished.exitCode === undefined
            ? `A command finished after ${seconds}s.`
            : `A command failed with status ${finished.exitCode} after ${seconds}s.`,
      };
    }),
    Match.exhaustive,
  );
}

async function raiseWindow(): Promise<void> {
  await getCurrentWindow().setFocus();
}

function targetOf(extra: Options["extra"]): AttentionTarget | undefined {
  const decoded = Schema.decodeUnknownResult(AttentionExtra)(extra);

  if (Result.isFailure(decoded)) return undefined;

  const { sessionID, terminalID } = decoded.success;

  // SAFETY: `extra` is the bag this adapter posted itself, with ids it had branded; JSON drops the brands on the way through the plugin, the decode above rejects any other shape, and a notification we did not post routes nowhere.
  return { sessionID: sessionID as SessionID, terminalID: terminalID as TerminalID };
}

function nameOf(cause: unknown): string {
  return cause instanceof Error ? cause.name : "unknown";
}
