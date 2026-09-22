import {
  type ConfirmationKey,
  type SettingsStoring,
  isConfirmationSilenced,
  withSilencedConfirmation,
} from "./global-settings.ts";
import type { ViewState } from "./view-state.ts";

export interface ConfirmationRequest {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly destructive?: boolean;
  readonly remember?: ConfirmationKey;
}

export interface Confirming {
  confirm(request: ConfirmationRequest): Promise<boolean>;
}

export interface ConfirmationQueue extends Confirming {
  readonly pending: ConfirmationRequest | undefined;
  answer(agreed: boolean, silence: boolean | undefined): void;
  subscribe(listener: () => void): () => void;
}

export function createConfirmationQueue(deps: {
  readonly view: Pick<ViewState, "settings" | "setSettings">;
  readonly settings: SettingsStoring;
}): ConfirmationQueue {
  const { view, settings } = deps;
  const listeners = new Set<() => void>();

  let pending: ConfirmationRequest | undefined;
  let resolvePending: ((agreed: boolean) => void) | undefined;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const silence = (key: ConfirmationKey): void => {
    const next = withSilencedConfirmation(view.settings, key, true);

    if (next === view.settings) return;

    view.setSettings(next);
    void settings.save(next).catch(() => undefined);
  };

  return {
    get pending(): ConfirmationRequest | undefined {
      return pending;
    },

    confirm(request: ConfirmationRequest): Promise<boolean> {
      if (request.remember !== undefined && isConfirmationSilenced(view.settings, request.remember))
        return Promise.resolve(true);

      if (pending !== undefined) return Promise.resolve(false);

      pending = request;
      notify();

      return new Promise<boolean>((resolve) => {
        resolvePending = resolve;
      });
    },

    answer(agreed: boolean, silenced: boolean | undefined): void {
      const asked = pending;
      const resolve = resolvePending;

      if (asked === undefined || resolve === undefined) return;

      pending = undefined;
      resolvePending = undefined;

      if (agreed && silenced === true && asked.remember !== undefined) silence(asked.remember);

      notify();
      resolve(agreed);
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  };
}
