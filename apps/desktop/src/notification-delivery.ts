/**
 * `AttentionDelivering` over the Tauri notification plugin.
 *
 * ## Why this is the app's and not the client's
 *
 * The policy that decides whether a signal interrupts anybody is
 * `@janela/client`'s, and it is unit-tested with no notification centre in sight.
 * This is the other half: an app-level capability, behind an injected seam so it
 * is still testable without a Tauri runtime. See ADR 0011 and ADR 0023.
 *
 * ## A real notification, not a toast
 *
 * Delivery goes through `@tauri-apps/plugin-notification`, which posts a genuine
 * system notification. An in-page imitation would live inside a window the user is
 * by definition not looking at, which is the one situation this feature exists for
 * (ADR 0023 § what stays native).
 *
 * ## What the plugin can and cannot do on macOS today
 *
 * The plugin's desktop backend registers exactly three commands —
 * `is_permission_granted`, `request_permission` and `notify`
 * (`tauri-plugin-notification/src/commands.rs`) — and posts through `notify-rust`,
 * discarding the response. So on macOS:
 *
 *   * posting works;
 *   * `request_permission` answers `granted` unconditionally, and the real prompt
 *     is macOS's own, on the first post from a signed bundle;
 *   * `remove_active` does not exist, so a banner cannot be pulled back;
 *   * there is no click listener, so `onAction` never fires.
 *
 * The last two are probed once, degraded, and never retried. They are not faked:
 * nothing here pretends a withdrawal happened. What *does* work regardless is the
 * part that matters most — a session removed while a delivery is still deciding
 * never posts at all, so no notification outlives its session by our doing.
 *
 * ## The in-app channel is not here, deliberately
 *
 * The pane indicator and the sidebar badge are `TerminalState.needsAttention`,
 * pushed by the daemon and rendered from the mirror. They do not pass through this
 * file and do not depend on any permission. The sidebar is the primary channel;
 * this is the secondary, best-effort one.
 */

import type { AttentionDelivering } from "@janela/client";
import type { SessionID, TerminalID } from "@janela/core";
import type { AttentionSignal } from "@janela/protocol";
import { log, type Logger } from "@janela/support";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  onAction,
  removeActive,
  requestPermission,
  sendNotification,
  type Options,
} from "@tauri-apps/plugin-notification";

/**
 * How many posted notifications we keep ids for.
 *
 * A bound rather than a map that grows with the session's whole history
 * (AGENTS.md non-negotiable 9). Losing the oldest id means the oldest banner
 * cannot be withdrawn — and macOS has long since collapsed it into the
 * Notification Centre list by then.
 */
export const MAXIMUM_OUTSTANDING_NOTIFICATIONS = 64;

/**
 * How many deliveries may be waiting on authorization at once.
 *
 * The window is only ever open on the very first delivery — every later one finds
 * the answer already settled — so this is a guard against a pathological burst
 * arriving during that one prompt, not a queue.
 */
export const MAXIMUM_IN_FLIGHT_DELIVERIES = 16;

/** The plugin requires a 32-bit integer id. Wraps rather than overflowing. */
const MAXIMUM_NOTIFICATION_ID = 2_147_483_647;

/** What a click routes to. Carried in the notification's `extra`, and nowhere else. */
export interface AttentionTarget {
  readonly sessionID: SessionID;
  readonly terminalID: TerminalID;
}

/**
 * The plugin, as the four calls this needs.
 *
 * Injected so these tests run without a Tauri runtime, and so a test can assert
 * the exact options handed to the boundary — including that the body is there and
 * that it is nowhere else.
 */
export interface NotificationPlugin {
  isPermissionGranted(): Promise<boolean>;
  requestPermission(): Promise<NotificationPermission>;
  sendNotification(options: Options): void;
  removeActive(notifications: { id: number }[]): Promise<void>;
  onAction(handler: (notification: Options) => void): Promise<unknown>;
}

export interface NotificationDeliveryOptions {
  /**
   * The store half of a click: select the session, focus its terminal.
   *
   * Supplied by the composition root, because it is the only thing that holds both
   * the mirror and the view's focus sink.
   */
  readonly onActivate: (target: AttentionTarget) => void;
  readonly plugin?: NotificationPlugin;
  /** Raises the window. Injected for the same reason the plugin is. */
  readonly activateWindow?: () => Promise<void>;
  readonly log?: Logger;
}

/**
 * Builds the adapter.
 *
 * Nothing happens until the first delivery: no permission is asked for, no
 * listener is registered, no invoke is made. A user who never leaves the app never
 * sees a prompt, and launch stays off the critical path (ADR 0011, non-negotiable
 * 5).
 */
export function createNotificationDelivery(
  options: NotificationDeliveryOptions,
): AttentionDelivering {
  const plugin = options.plugin ?? tauriNotifications;
  const logger = options.log ?? log("app");
  const activateWindow = options.activateWindow ?? raiseWindow;

  /** Settled once and never revisited: "we never ask twice" is a rule, not a hint. */
  let authorization: "unknown" | "granted" | "denied" = "unknown";
  let asking: Promise<boolean> | undefined;

  /** Posted and not yet withdrawn, oldest first. Bounded. */
  const outstanding: { readonly id: number; readonly sessionID: SessionID }[] = [];

  /**
   * Deliveries parked on authorization.
   *
   * Mutable entries rather than ids: `withdraw` has to reach a delivery that has
   * not been given a notification id yet, which is exactly the delivery that would
   * otherwise post a banner for a session that has just been deleted.
   */
  const inFlight = new Set<{ readonly sessionID: SessionID; cancelled: boolean }>();

  let nextID = 1;
  let removalSupported = true;
  let clickRouting: Promise<void> | undefined;

  const authorize = async (): Promise<boolean> => {
    if (authorization !== "unknown") return authorization === "granted";

    asking ??= (async (): Promise<boolean> => {
      try {
        const granted =
          (await plugin.isPermissionGranted()) || (await plugin.requestPermission()) === "granted";
        authorization = granted ? "granted" : "denied";
        // A shape, and the one fact a bug report about silence needs. Denial is a
        // supported state, so this is `info` rather than a warning.
        logger.info("notification authorization", { granted });
        return granted;
      } catch (error: unknown) {
        // Treated as denial: the in-app badge is unaffected either way, and asking
        // again on every signal would be a prompt loop.
        authorization = "denied";
        logger.warning("notification authorization failed", { error: nameOf(error) });
        return false;
      }
    })();

    return asking;
  };

  /**
   * Registers the click listener, once, after the first notification is on screen.
   *
   * Rejection is the expected outcome on the macOS desktop backend, which has no
   * listener command at all — recorded once at `debug` and never retried, because
   * a capability does not appear later in the same process.
   */
  const registerClickRouting = (): void => {
    clickRouting ??= plugin
      .onAction((notification: Options) => {
        const target = targetOf(notification.extra);
        if (target === undefined) return;

        options.onActivate(target);
        void activateWindow().catch((error: unknown) => {
          // `core:window:allow-set-focus` may not be in the capability set. The
          // session is still selected; the window simply did not come forward.
          logger.debug("window activation failed", { error: nameOf(error) });
        });
        // The user is looking at that session now, so every banner for it is
        // stale — not only the one they clicked.
        void delivery.withdraw(target.sessionID);
      })
      .then(() => undefined)
      .catch((error: unknown) => {
        logger.debug("notification click routing unavailable", { error: nameOf(error) });
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
      let granted: boolean;
      try {
        granted = await authorize();
      } finally {
        inFlight.delete(parked);
      }

      if (!granted) return;
      if (parked.cancelled) {
        // The session was removed while we were asking. Posting now would put a
        // notification on screen for something that no longer exists.
        logger.debug("notification abandoned", { sessionID });
        return;
      }

      const id = nextID;
      nextID = nextID >= MAXIMUM_NOTIFICATION_ID ? 1 : nextID + 1;

      const { title, body } = notificationContent(input);
      // The one place the body goes. `extra` carries ids only, so the click route
      // needs nothing that identifies content.
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
      // Dropped from `outstanding` either way: a backend that cannot remove one
      // will not be able to remove it later either, and holding the ids would be
      // an unbounded list of things we cannot act on.
      if (!removalSupported) return;

      try {
        await plugin.removeActive(ids.map((id) => ({ id })));
      } catch (error: unknown) {
        removalSupported = false;
        logger.debug("notification removal unsupported", { error: nameOf(error) });
      }
    },
  };

  return delivery;
}

/**
 * What the user reads.
 *
 * ADR 0011 puts the session name in the title and the terminal title in the
 * subtitle. The plugin's desktop backend has no subtitle, so both routing facts
 * share the title and the body stays exactly what the program supplied — which is
 * also the cleaner privacy line: the body is user content and nothing else.
 *
 * A body is never synthesised from scrollback. When the program did not supply
 * one, the sentence describes the event and nothing more.
 */
export function notificationContent(input: {
  readonly signal: AttentionSignal;
  readonly sessionName: string;
  readonly terminalTitle: string;
}): { readonly title: string; readonly body: string } {
  const title = `${input.sessionName} — ${input.terminalTitle}`;
  const { kind } = input.signal;

  switch (kind.kind) {
    case "bell":
      // The policy never delivers a bare bell; this is here so the mapping is
      // total rather than because it is expected.
      return { title, body: "Rang the bell." };
    case "notification":
      return {
        title,
        body: kind.title === undefined ? kind.body : `${kind.title}: ${kind.body}`,
      };
    case "promptFinished": {
      const seconds = Math.round(kind.durationSeconds);
      return {
        title,
        body:
          kind.exitCode === undefined
            ? `A command finished after ${seconds}s.`
            : `A command failed with status ${kind.exitCode} after ${seconds}s.`,
      };
    }
  }
}

/** The real plugin, as the seam above. */
const tauriNotifications: NotificationPlugin = {
  isPermissionGranted,
  requestPermission,
  sendNotification,
  removeActive,
  onAction,
};

/**
 * Brings the window forward.
 *
 * `setFocus` alone: `show` and `unminimize` are separate capability entries, and
 * asking for permissions a click does not need is how a capability set stops
 * meaning anything.
 */
async function raiseWindow(): Promise<void> {
  await getCurrentWindow().setFocus();
}

/**
 * The ids a notification was posted with, read back off an untyped bag.
 *
 * The cast is the boundary: `extra` crosses the plugin as JSON, so the brands are
 * gone by the time it returns. Anything that is not a pair of strings is a
 * notification we did not post, and it routes nowhere.
 */
function targetOf(extra: Options["extra"]): AttentionTarget | undefined {
  const sessionID = extra?.["sessionID"];
  const terminalID = extra?.["terminalID"];
  if (typeof sessionID !== "string" || typeof terminalID !== "string") return undefined;
  return { sessionID: sessionID as SessionID, terminalID: terminalID as TerminalID };
}

/** A thrown value reduced to something safe to log. Never the message. */
function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
