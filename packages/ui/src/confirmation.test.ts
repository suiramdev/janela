import { describe, expect, test } from "bun:test";

import { createConfirmationQueue, type ConfirmationRequest } from "./confirmation.ts";
import {
  DEFAULT_GLOBAL_SETTINGS,
  isConfirmationSilenced,
  withSilencedConfirmation,
  type GlobalSettings,
} from "./global-settings.ts";

/**
 * The queue, the silencing, and the two of them together.
 *
 * What is worth pinning here is not that a promise resolves: it is *which*
 * answer each ending produces. A dismissed question must be a refusal, a
 * silenced one must proceed without being shown, and a refusal must never be
 * the thing that silences it — that last one is the bug that would hand someone
 * a preference they set by pressing Escape.
 */

/** The window's settings plus the storage behind them, as the queue sees them. */
function store(initial: GlobalSettings = DEFAULT_GLOBAL_SETTINGS) {
  let settings = initial;
  const saved: GlobalSettings[] = [];
  return {
    saved,
    get settings(): GlobalSettings {
      return settings;
    },
    view: {
      get settings(): GlobalSettings {
        return settings;
      },
      setSettings(next: GlobalSettings): void {
        settings = next;
      },
    },
    storage: {
      load: () => Promise.resolve(settings),
      save: (next: GlobalSettings) => {
        saved.push(next);
        return Promise.resolve();
      },
    },
  };
}

const CLOSING: ConfirmationRequest = {
  title: "Close this tab?",
  message: "zsh is still running.",
  confirmLabel: "Close Tab",
  remember: "closeTerminals",
};

const REMOVING: ConfirmationRequest = {
  title: "Remove fix/pty?",
  message: "Its directory is deleted.",
  confirmLabel: "Remove Session",
};

describe("createConfirmationQueue", () => {
  test("a question waits, and answering it resolves with the answer", async () => {
    const backing = store();
    const queue = createConfirmationQueue({ view: backing.view, settings: backing.storage });

    const asked = queue.confirm(REMOVING);
    expect(queue.pending).toEqual(REMOVING);

    queue.answer(true);

    expect(await asked).toBe(true);
    expect(queue.pending).toBeUndefined();
  });

  test("declining resolves false and leaves nothing on screen", async () => {
    const backing = store();
    const queue = createConfirmationQueue({ view: backing.view, settings: backing.storage });

    const asked = queue.confirm(REMOVING);
    queue.answer(false);

    expect(await asked).toBe(false);
    expect(queue.pending).toBeUndefined();
  });

  test("a second question while one is on screen is refused, not queued", async () => {
    const backing = store();
    const queue = createConfirmationQueue({ view: backing.view, settings: backing.storage });

    const first = queue.confirm(REMOVING);
    // ⌘W arriving from the menu bar while the dialog owns the window: the safe
    // reading is that nothing happens, and nothing accumulates either.
    const second = queue.confirm(CLOSING);

    expect(await second).toBe(false);
    expect(queue.pending).toEqual(REMOVING);

    queue.answer(true);
    expect(await first).toBe(true);
  });

  test("answering when nothing was asked does nothing at all", () => {
    const backing = store();
    const queue = createConfirmationQueue({ view: backing.view, settings: backing.storage });

    queue.answer(true, true);

    expect(queue.pending).toBeUndefined();
    expect(backing.settings).toEqual(DEFAULT_GLOBAL_SETTINGS);
  });

  test("notifies while the question is on screen and once it is gone", () => {
    const backing = store();
    const queue = createConfirmationQueue({ view: backing.view, settings: backing.storage });
    let notifications = 0;
    const stop = queue.subscribe(() => {
      notifications += 1;
    });

    void queue.confirm(REMOVING);
    queue.answer(false);
    stop();
    void queue.confirm(REMOVING);

    // Asked, answered — and nothing after unsubscribing, which is what keeps an
    // unmounted host from re-rendering.
    expect(notifications).toBe(2);
  });
});

describe("don't ask again", () => {
  test("agreeing with the box ticked silences the question, in the window and in storage", async () => {
    const backing = store();
    const queue = createConfirmationQueue({ view: backing.view, settings: backing.storage });

    const asked = queue.confirm(CLOSING);
    queue.answer(true, true);
    await asked;

    expect(isConfirmationSilenced(backing.settings, "closeTerminals")).toBe(true);
    // Both writes: the window takes effect now, the storage survives relaunch.
    expect(backing.saved).toEqual([backing.settings]);
  });

  test("a silenced question is never shown, and answers yes", async () => {
    const backing = store(
      withSilencedConfirmation(DEFAULT_GLOBAL_SETTINGS, "closeTerminals", true),
    );
    const queue = createConfirmationQueue({ view: backing.view, settings: backing.storage });

    const asked = queue.confirm(CLOSING);

    expect(queue.pending).toBeUndefined();
    expect(await asked).toBe(true);
  });

  test("a silenced question does not silence the others", async () => {
    const backing = store(
      withSilencedConfirmation(DEFAULT_GLOBAL_SETTINGS, "closeTerminals", true),
    );
    const queue = createConfirmationQueue({ view: backing.view, settings: backing.storage });

    const asked = queue.confirm(REMOVING);

    expect(queue.pending).toEqual(REMOVING);
    queue.answer(false);
    expect(await asked).toBe(false);
  });

  test("declining with the box ticked silences nothing", async () => {
    const backing = store();
    const queue = createConfirmationQueue({ view: backing.view, settings: backing.storage });

    const asked = queue.confirm(CLOSING);
    // The box is a checkbox on a form whose other answer is "no". Honouring it
    // here would mean the *next* close happened without asking — the opposite of
    // what pressing Cancel said.
    queue.answer(false, true);
    await asked;

    expect(isConfirmationSilenced(backing.settings, "closeTerminals")).toBe(false);
    expect(backing.saved).toEqual([]);
  });

  test("a question with no key ignores the box, because it has nowhere to record it", async () => {
    const backing = store();
    const queue = createConfirmationQueue({ view: backing.view, settings: backing.storage });

    const asked = queue.confirm(REMOVING);
    queue.answer(true, true);
    await asked;

    expect(backing.settings).toEqual(DEFAULT_GLOBAL_SETTINGS);
    expect(backing.saved).toEqual([]);
  });
});

describe("withSilencedConfirmation", () => {
  test("silencing twice does not grow the list", () => {
    const once = withSilencedConfirmation(DEFAULT_GLOBAL_SETTINGS, "closeTerminals", true);
    const twice = withSilencedConfirmation(once, "closeTerminals", true);

    expect(twice).toBe(once);
    expect(once.silencedConfirmations).toEqual(["closeTerminals"]);
  });

  test("restoring the last silenced question removes the key entirely", () => {
    const silenced = withSilencedConfirmation(DEFAULT_GLOBAL_SETTINGS, "closeTerminals", true);

    const restored = withSilencedConfirmation(silenced, "closeTerminals", false);

    // Absent, not empty: an older build wrote no key at all, and "nothing
    // silenced" has to be one state rather than two.
    expect("silencedConfirmations" in restored).toBe(false);
  });

  test("the defaults silence nothing", () => {
    expect(isConfirmationSilenced(DEFAULT_GLOBAL_SETTINGS, "closeTerminals")).toBe(false);
  });
});
