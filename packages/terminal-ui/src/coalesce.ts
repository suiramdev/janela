export interface FrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

export interface Coalescer<T> {
  push(value: T): void;

  cancel(): void;
}

export function animationFrameScheduler(): FrameScheduler {
  return {
    request: (callback) => requestAnimationFrame(callback),
    cancel: (handle) => {
      cancelAnimationFrame(handle);
    },
  };
}

export function coalescePerFrame<T>(
  deliver: (value: T) => void,
  scheduler: FrameScheduler,
): Coalescer<T> {
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
