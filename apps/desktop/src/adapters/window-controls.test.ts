import { describe, expect, test } from "bun:test";

import { TRAFFIC_LIGHT_POSITION } from "@janela/ui";

import { tauriWindowControls } from "./window-controls.ts";

const config = (await Bun.file(
  new URL("../../src-tauri/tauri.conf.json", import.meta.url),
).json()) as {
  readonly app: {
    readonly windows: readonly {
      readonly label: string;
      readonly titleBarStyle?: string;
      readonly hiddenTitle?: boolean;
      readonly decorations?: boolean;
      readonly trafficLightPosition?: { readonly x: number; readonly y: number };
      readonly dragDropEnabled?: boolean;
    }[];
  };
};

const main = config.app.windows.find((window) => window.label === "main");

describe("the main window's title bar", () => {
  test("is an overlay, so the window controls are inside the sidebar", () => {
    expect(main?.titleBarStyle).toBe("Overlay");
    expect(main?.decorations ?? true).toBe(true);
    expect(main?.hiddenTitle).toBe(true);
  });

  test("puts the controls where the sidebar's first row expects them", () => {
    expect(main?.trafficLightPosition).toEqual(TRAFFIC_LIGHT_POSITION);
  });
});

describe("the main window's drag and drop", () => {
  test("leaves the drag session to the page, or no tab and no pane can ever be dropped", () => {
    expect(main?.dragDropEnabled).toBe(false);
  });
});

describe("tauriWindowControls", () => {
  test("reports nothing to dodge where the title bar is not an overlay", () => {
    const controls = tauriWindowControls({ isMacOS: false });

    expect(controls.areVisible).toBe(false);
    expect(controls.subscribe(() => {})).toBeFunction();
  });
});
