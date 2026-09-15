import { describe, expect, test } from "bun:test";

/**
 * Pins `tauri.conf.json`'s window chrome to what the views are laid out for.
 *
 * The traffic lights are positioned in the config and dodged in CSS, and the two
 * cannot import each other. Nothing notices when they disagree either: the
 * buttons simply sit on top of the search control, or float above a row they were
 * measured against, and both look like somebody's font rendering rather than a
 * number in a JSON file.
 */
import { TRAFFIC_LIGHT_POSITION } from "@janela/ui";

import { tauriWindowControls } from "./window-controls.ts";

const config = (await Bun.file(
  new URL("../src-tauri/tauri.conf.json", import.meta.url),
).json()) as {
  readonly app: {
    readonly windows: readonly {
      readonly label: string;
      readonly titleBarStyle?: string;
      readonly hiddenTitle?: boolean;
      readonly decorations?: boolean;
      readonly trafficLightPosition?: { readonly x: number; readonly y: number };
    }[];
  };
};

const main = config.app.windows.find((window) => window.label === "main");

describe("the main window's title bar", () => {
  test("is an overlay, so the window controls are inside the sidebar", () => {
    // `Overlay` is what puts the content under the buttons; `Transparent` would
    // leave a 28px strip above the sidebar, and the mark this replaced would have
    // been deleted for nothing.
    expect(main?.titleBarStyle).toBe("Overlay");
    // The buttons need the frame `decorations` bring; only the *title* goes.
    expect(main?.decorations ?? true).toBe(true);
    expect(main?.hiddenTitle).toBe(true);
  });

  test("puts the controls where the sidebar's first row expects them", () => {
    expect(main?.trafficLightPosition).toEqual(TRAFFIC_LIGHT_POSITION);
  });
});

describe("tauriWindowControls", () => {
  test("reports nothing to dodge where the title bar is not an overlay", () => {
    // The three config keys above are macOS-only, so anywhere else the buttons
    // are in a title bar of their own and this must not reserve a gap for them.
    // It must also not reach for the window: this path answers before any
    // invoke, which is the only reason it can be asserted here at all.
    const controls = tauriWindowControls({ isMacOS: false });

    expect(controls.areVisible).toBe(false);
    // And nothing will ever change it, so a subscriber is a no-op that still
    // hands back a disposer the views can call.
    expect(controls.subscribe(() => {})).toBeFunction();
  });
});
