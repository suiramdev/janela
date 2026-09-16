import type { Logger } from "@janela/support";
import type { TerminalRegistry } from "@janela/terminal";

export interface IdleMonitor {
  start(): void;
  stop(): void;
  poll(): void;
}

export interface IdleMonitorOptions {
  isIdle(): boolean;
  onIdleExpired(): void;
  readonly gracePeriodMs?: number;
  readonly pollIntervalMs?: number;
  now?(): number;
}

export interface IdlenessFacts {
  readonly connectionCount: number;
  canExitWhenIdle(): boolean;
}

export interface ShutdownOptions {
  readonly terminals: TerminalRegistry;
  readonly log: Logger;
  stopServing(): void;
  finish(code: number): void;
}

export const IDLE_GRACE_PERIOD_MS = 5 * 60_000;

export const IDLE_POLL_INTERVAL_MS = 15_000;

export function createIdleMonitor(options: IdleMonitorOptions): IdleMonitor {
  const gracePeriodMs = options.gracePeriodMs ?? IDLE_GRACE_PERIOD_MS;
  const pollIntervalMs = options.pollIntervalMs ?? IDLE_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;

  let idleSince: number | undefined;
  let timer: Timer | undefined;
  let expired = false;

  const monitor: IdleMonitor = {
    start(): void {
      if (timer !== undefined) return;

      timer = setInterval(() => monitor.poll(), pollIntervalMs);
      timer.unref();
    },

    stop(): void {
      if (timer === undefined) return;

      clearInterval(timer);
      timer = undefined;
    },

    poll(): void {
      if (expired) return;

      if (!options.isIdle()) {
        idleSince = undefined;

        return;
      }

      if (idleSince === undefined) {
        idleSince = now();

        return;
      }

      if (now() - idleSince < gracePeriodMs) return;

      expired = true;
      monitor.stop();
      options.onIdleExpired();
    },
  };

  return monitor;
}

export function isDaemonIdle(facts: IdlenessFacts): boolean {
  return facts.connectionCount === 0 && facts.canExitWhenIdle();
}

export async function shutdown(options: ShutdownOptions): Promise<void> {
  const { terminals, log } = options;
  const live = terminals.liveCount;

  await terminals.hangUpAll();

  log.info("hung up every terminal", { count: live });

  options.stopServing();
  options.finish(0);
}
