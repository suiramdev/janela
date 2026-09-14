import {
  isConfirmationSilenced,
  withSilencedConfirmation,
  type ConfirmationKey,
  type SettingsStoring,
} from "./global-settings.ts";
import type { ViewState } from "./view-state.ts";

/**
 * Asking the user before doing something they cannot undo — in the window,
 * rather than in a native alert.
 *
 * ## Why this is not `NativeShell.confirm` any more
 *
 * It used to be Tauri's `ask()`, an AppKit alert. That was the fastest thing
 * that worked and it was wrong in three ways that only a real dialog can fix:
 *
 * - **It could not offer a third answer.** A native alert has an OK and a
 *   Cancel, so "Remove Session" could not also offer "Don't ask again", and
 *   `sidebar-actions.ts` carried a comment saying exactly that.
 * - **It is not this application.** The type, the spacing, the spring and the
 *   surface ladder stop at the window edge, and a question about a terminal you
 *   are looking at appeared in a system font on a grey slab.
 * - **It is unobservable.** Nothing in a test can see an AppKit alert, so the
 *   most consequential sentences in the product — what removing a session
 *   costs — were the only copy nothing could assert on.
 *
 * ## The shape
 *
 * A promise, because every caller is a decision and reads better as one:
 *
 * ```ts
 * if (!(await confirmations.confirm(prompt))) return;
 * ```
 *
 * The queue is a store rather than component state, for the reason `ViewState`
 * is: the callers are `closeTerminals`, the sidebar actions and the version-skew
 * banner, and none of them is inside the React tree that renders the dialog.
 *
 * **One question at a time, and no queue behind it.** A second request arriving
 * while one is on screen is answered "no" without being shown: the dialog is
 * modal, so the only way to produce one is a menu chord or a notification click
 * while it is open, and the safe reading of "⌘W arrived while you were being
 * asked about ⌘W" is that nothing happens. A queue would instead show a
 * question about something the user has stopped looking at (AGENTS.md
 * § Non-negotiables 9: nothing accumulates without a bound, including
 * questions).
 */

export interface ConfirmationRequest {
  readonly title: string;
  /** Why it is asking: what is lost, counted. Never empty. */
  readonly message: string;
  /** The button that acts. Names the action — never "OK". */
  readonly confirmLabel: string;
  /**
   * Whether the acting button reads as destructive.
   *
   * On by default: everything that asks here ends something. A confirmation
   * that is merely a fork in the road passes `false`.
   */
  readonly destructive?: boolean;
  /**
   * Offer "Don't ask again", silencing this question from then on.
   *
   * Absent means the question is always asked, which is the right answer for
   * anything that can delete a directory. See `ConfirmationKey`.
   */
  readonly remember?: ConfirmationKey;
}

/** What a decision needs: one question, one answer. */
export interface Confirming {
  confirm(request: ConfirmationRequest): Promise<boolean>;
}

export interface ConfirmationQueue extends Confirming {
  /** The question on screen, or `undefined` when none is. */
  readonly pending: ConfirmationRequest | undefined;
  /**
   * Answers the pending question. `silence` records the checkbox, and is only
   * honoured on agreement — silencing a question you just declined would mean
   * the next one proceeds without asking.
   */
  answer(agreed: boolean, silence?: boolean): void;
  subscribe(listener: () => void): () => void;
}

/**
 * The queue, wired to where silenced questions are remembered.
 *
 * `view` and `settings` rather than a bare pair of callbacks: a silenced
 * question has to survive the window (storage) *and* take effect immediately
 * (this window's settings), and those are exactly the two writes every other
 * settings change in this client already makes.
 */
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
    // Best-effort, like every other settings write: losing the preference costs
    // one more question, not the answer the user just gave.
    void settings.save(next).catch(() => undefined);
  };

  return {
    get pending(): ConfirmationRequest | undefined {
      return pending;
    },

    confirm(request: ConfirmationRequest): Promise<boolean> {
      if (request.remember !== undefined && isConfirmationSilenced(view.settings, request.remember))
        return Promise.resolve(true);
      // Already asking. See "One question at a time" above.
      if (pending !== undefined) return Promise.resolve(false);

      pending = request;
      notify();
      return new Promise<boolean>((resolve) => {
        resolvePending = resolve;
      });
    },

    answer(agreed: boolean, silenced?: boolean): void {
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
