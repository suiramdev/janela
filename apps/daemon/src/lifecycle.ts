import type { Logger } from "@janela/support";
import type { TerminalRegistry } from "@janela/terminal";

/**
 * When the daemon exits, and what it does on the way out.
 *
 * Two rules, and the whole of the lifecycle is them:
 *
 * 1. **A daemon holding live terminals never exits on its own.** Not when the last
 *    client disconnects, not when it has been idle for an hour. That asymmetry is
 *    the entire feature — the daemon exists to outlive clients, not to serve them
 *    (non-negotiable #7).
 * 2. **Hang up before exiting.** A child whose parent dies without SIGHUP is
 *    reparented onto launchd and keeps running with nobody to talk to.
 */

/**
 * How long the daemon stays up with nothing to do.
 *
 * The five-minute grace period, and this is the first place it exists as code.
 * Long enough that quitting and reopening the app does not tear down and rebuild
 * the world — the database, the shell-environment capture, the session restore —
 * and short enough that a user who is done for the day is not left with a process.
 */
export const IDLE_GRACE_PERIOD_MS = 5 * 60_000;

/**
 * How often idleness is re-checked.
 *
 * A poll rather than an event, because "idle" is a conjunction of two things that
 * change independently (clients and live terminals) and a timer that is armed and
 * cancelled on every transition is a timer that leaks one. Fifteen seconds costs
 * nothing and bounds the overshoot at 5% of the grace period.
 */
export const IDLE_POLL_INTERVAL_MS = 15_000;

export interface IdleMonitor {
  start(): void;
  stop(): void;
  /**
   * One idleness check.
   *
   * Public so a test can drive the state machine with a fake clock: the behaviour
   * worth testing is "an idle period interrupted by a reconnect starts again", and
   * waiting five real minutes to see it is not a test anybody runs.
   */
  poll(): void;
}

export interface IdleMonitorOptions {
  /** False while any client is connected or any terminal is live. */
  isIdle(): boolean;
  /** Called once, when the grace period has elapsed with `isIdle()` true throughout. */
  onIdleExpired(): void;
  readonly gracePeriodMs?: number;
  readonly pollIntervalMs?: number;
  /** Injected so the grace period is exact in tests rather than approximately five minutes. */
  now?(): number;
}

export function createIdleMonitor(options: IdleMonitorOptions): IdleMonitor {
  const gracePeriodMs = options.gracePeriodMs ?? IDLE_GRACE_PERIOD_MS;
  const pollIntervalMs = options.pollIntervalMs ?? IDLE_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;

  /** When the current idle period began, or `undefined` while not idle. */
  let idleSince: number | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let expired = false;

  const monitor: IdleMonitor = {
    start(): void {
      if (timer !== undefined) return;
      timer = setInterval(() => monitor.poll(), pollIntervalMs);
      // The daemon must not hold the process open just to ask whether it is idle.
      timer.unref?.();
    },

    stop(): void {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    },

    poll(): void {
      if (expired) return;
      if (!options.isIdle()) {
        // A reconnect or a started terminal ends the idle period outright: the
        // clock restarts from zero rather than resuming, because a daemon that
        // exits four minutes into a session the user just opened is a bug.
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

/**
 * What the daemon must be able to see to decide it has nothing to do.
 *
 * A structural slice of `DaemonServer` rather than the whole thing: the rule
 * depends on two numbers, and a test that had to build a server to check a
 * conjunction would be testing the server.
 */
export interface IdlenessFacts {
  readonly connectionCount: number;
  canExitWhenIdle(): boolean;
}

/**
 * Whether the daemon has nothing left to do.
 *
 * **Both conjuncts, and the second is the whole feature.** No clients is not
 * enough: a daemon holding live terminals stays, however long it has been alone,
 * because it exists to outlive clients rather than to serve them (non-negotiable
 * #7). `canExitWhenIdle()` is what asks the terminal registry, and dropping it
 * would make the daemon exit five minutes after the user closed the window on a
 * running build.
 */
export function isDaemonIdle(facts: IdlenessFacts): boolean {
  return facts.connectionCount === 0 && facts.canExitWhenIdle();
}

export interface ShutdownOptions {
  readonly terminals: TerminalRegistry;
  readonly log: Logger;
  /** Aborts the serve loop, which closes the listener and every connection. */
  stopServing(): void;
  /** Ends the process. Injected so the order below is testable without exiting. */
  finish(code: number): void;
}

/**
 * The one way out: hang up, stop serving, exit.
 *
 * **The order is the contract.** `hangUpAll()` first, so children get `SIGHUP`
 * from a parent that still exists; a process that closed its listener and exited
 * first would leave every shell reparented onto launchd, running, invisible, and
 * holding the worktree the user was about to delete.
 *
 * Idempotent by construction at the call site: `process.once` for each signal, and
 * the idle monitor stops itself before calling this.
 */
export async function shutdown(options: ShutdownOptions): Promise<void> {
  const { terminals, log } = options;

  const live = terminals.liveCount;
  await terminals.hangUpAll();
  log.info("hung up every terminal", { count: live });

  options.stopServing();
  options.finish(0);
}
