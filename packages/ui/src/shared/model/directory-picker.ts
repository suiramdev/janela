import type { AbsolutePath } from "@janela/core";

export interface DirectoryPickerRequest {
  readonly title: string;
}

export interface DirectoryPicking {
  pickDirectory(request: DirectoryPickerRequest): Promise<AbsolutePath | undefined>;
}

export interface DirectoryPickerQueue extends DirectoryPicking {
  readonly pending: DirectoryPickerRequest | undefined;
  answer(directory: AbsolutePath | undefined): void;
  subscribe(listener: () => void): () => void;
}

export function createDirectoryPickerQueue(): DirectoryPickerQueue {
  const listeners = new Set<() => void>();

  let pending: DirectoryPickerRequest | undefined;
  let resolvePending: ((directory: AbsolutePath | undefined) => void) | undefined;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  return {
    get pending(): DirectoryPickerRequest | undefined {
      return pending;
    },

    pickDirectory(request: DirectoryPickerRequest): Promise<AbsolutePath | undefined> {
      if (pending !== undefined) return Promise.resolve(undefined);

      pending = request;
      notify();

      return new Promise<AbsolutePath | undefined>((resolve) => {
        resolvePending = resolve;
      });
    },

    answer(directory: AbsolutePath | undefined): void {
      const resolve = resolvePending;

      if (pending === undefined || resolve === undefined) return;

      pending = undefined;
      resolvePending = undefined;

      notify();
      resolve(directory);
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  };
}
