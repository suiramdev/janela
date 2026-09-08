/**
 * One delivery per frame, holding only the latest value.
 *
 * The surface produces two kinds of event that arrive faster than anything
 * downstream can usefully consume them: a `ResizeObserver` during a divider drag,
 * and the resize votes that follow it. Each vote crosses two process boundaries and
 * ends in a `TIOCSWINSZ` with a `SIGWINCH` behind it, so one per pointer move is a
 * storm and one per frame is the budget — docs/performance.md § Interaction budgets.
 *
 * Only the newest value is held. That is the no-unbounded-buffer rule
 * (AGENTS.md § Non-negotiables 9) in its simplest form: a queue of size one, where
 * the bound is a consequence of the shape rather than a check someone has to
 * remember.
 */

/**
 * The frame clock, injected so the coalescing is testable without a browser.
 *
 * A handle rather than a token object because that is what `requestAnimationFrame`
 * returns, and wrapping it would buy nothing.
 */
export interface FrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

/** The real clock. The only place in this package that names a browser global. */
export function animationFrameScheduler(): FrameScheduler {
  return {
    request: (callback) => requestAnimationFrame(callback),
    cancel: (handle) => {
      cancelAnimationFrame(handle);
    },
  };
}

export interface Coalescer<T> {
  /** Replaces whatever is pending and schedules a frame if none is scheduled. */
  push(value: T): void;

  /**
   * Drops the pending value and cancels the scheduled frame. Nothing is delivered
   * after this, which is what makes it safe to call from a React cleanup.
   */
  cancel(): void;
}

/**
 * Delivers at most once per frame, with the last value pushed.
 *
 * Deliberately does *not* deduplicate equal consecutive values: whether two values
 * are the same is a question about the value, and the one caller that cares
 * (`createSurfaceController`) compares grid sizes itself. Keeping the two concerns
 * apart is what lets each be tested on its own.
 */
export function coalescePerFrame<T>(
  deliver: (value: T) => void,
  scheduler: FrameScheduler,
): Coalescer<T> {
  // A one-element box rather than the value itself, so `undefined` is a legitimate
  // value to coalesce rather than a sentinel for "nothing pending".
  let pending: { readonly value: T } | undefined;
  let handle: number | undefined;

  const flush = (): void => {
    handle = undefined;
    const held = pending;
    pending = undefined;
    if (held !== undefined) deliver(held.value);
  };

  return {
    push(value: T): void {
      pending = { value };
      if (handle === undefined) handle = scheduler.request(flush);
    },
    cancel(): void {
      pending = undefined;
      if (handle !== undefined) {
        scheduler.cancel(handle);
        handle = undefined;
      }
    },
  };
}
