import { describe, expect, test } from "bun:test";

import { renderToStaticMarkup } from "react-dom/server";

import { fakeClientEnvironment } from "../../../shared/lib/test-fakes/index.ts";
import {
  type AppUpdateState,
  type ClientEnvironment,
  ClientEnvironmentProvider,
} from "../../../shared/model/index.ts";
import { UpdateBanner, updateBannerModel } from "./update-banner.tsx";

const EVERY_STATE: readonly AppUpdateState[] = [
  { kind: "idle" },
  { kind: "checking", announced: true },
  { kind: "checking", announced: false },
  { kind: "upToDate" },
  { kind: "available", version: "0.2.0" },
  { kind: "downloading", version: "0.2.0", fraction: 0.5 },
  { kind: "ready", version: "0.2.0" },
  { kind: "failed", text: "nope" },
];

function markupFor(environment: ClientEnvironment): string {
  return renderToStaticMarkup(
    <ClientEnvironmentProvider environment={environment}>
      <UpdateBanner />
    </ClientEnvironmentProvider>,
  );
}

describe("updateBannerModel", () => {
  test("yields the slot to the connection banner in every state", () => {
    for (const state of EVERY_STATE) {
      expect(updateBannerModel(state, true)).toEqual({ kind: "none" });
    }
  });

  test("a quiet check shows nothing; an announced one shows a strip", () => {
    expect(updateBannerModel({ kind: "checking", announced: false }, false)).toEqual({
      kind: "none",
    });

    expect(updateBannerModel({ kind: "checking", announced: true }, false)).toEqual({
      kind: "strip",
      text: "Checking for updates…",
    });
  });

  test("downloading reads the percentage only when the total is known", () => {
    expect(
      updateBannerModel({ kind: "downloading", version: "0.2.0", fraction: 0.5 }, false),
    ).toEqual({ kind: "strip", text: "Downloading Janela 0.2.0… 50%" });

    expect(
      updateBannerModel({ kind: "downloading", version: "0.2.0", fraction: undefined }, false),
    ).toEqual({ kind: "strip", text: "Downloading Janela 0.2.0…" });
  });

  test("available offers install, ready offers relaunch, both can wait", () => {
    const available = updateBannerModel({ kind: "available", version: "0.2.0" }, false);
    const ready = updateBannerModel({ kind: "ready", version: "0.2.0" }, false);

    expect(available).toMatchObject({
      kind: "notice",
      title: "Janela 0.2.0 is available.",
      primary: { label: "Update", action: "install" },
      dismissLabel: "Later",
      destructive: false,
    });

    expect(ready).toMatchObject({
      kind: "notice",
      title: "Janela 0.2.0 is installed. Restart Janela to finish.",
      primary: { label: "Restart Now", action: "relaunch" },
      dismissLabel: "Later",
      destructive: false,
    });
  });

  test("a failure is destructive, with the settled text and only a dismissal", () => {
    expect(updateBannerModel({ kind: "failed", text: "nope" }, false)).toEqual({
      kind: "notice",
      title: "nope",
      description: undefined,
      primary: undefined,
      dismissLabel: "Dismiss",
      destructive: true,
    });
  });
});

describe("UpdateBanner markup", () => {
  test("renders nothing without a local shell, whatever the state", () => {
    const environment = fakeClientEnvironment();

    environment.view.setAppUpdate({ kind: "available", version: "0.2.0" });

    expect(markupFor({ ...environment, local: undefined })).toBe("");
  });

  test("an available update is an overlaid alert with both buttons", () => {
    const environment = fakeClientEnvironment();

    environment.view.setAppUpdate({ kind: "available", version: "0.2.0" });

    const markup = markupFor(environment);

    expect(markup).toContain("absolute inset-x-0 top-0");
    expect(markup).toContain("Janela 0.2.0 is available.");
    expect(markup).toContain(">Update<");
    expect(markup).toContain(">Later<");
  });
});
