import { describe, expect, test } from "bun:test";

import { renderToStaticMarkup } from "react-dom/server";

import { DEFAULT_GLOBAL_SETTINGS } from "./global-settings.ts";
import type { SettingsTabID, SettingsWindowProps } from "./settings-window.tsx";
import { SETTINGS_TABS, SettingsWindow } from "./settings-window.tsx";
import {
  fakeProfile,
  fakeSession,
  fakeShellProfile,
  recordingProfileEditing,
  recordingService,
  reportedAvailable,
  states,
} from "./test-fakes.ts";

const shell = fakeShellProfile();
const claude = fakeProfile({ name: "Claude Code" });

function props(tab?: SettingsTabID): SettingsWindowProps {
  return {
    settings: DEFAULT_GLOBAL_SETTINGS,
    onChangeSettings: () => {},
    profiles: [shell, claude],
    availability: reportedAvailable(shell, claude),
    profileEditing: recordingProfileEditing(),
    sessions: [fakeSession()],
    terminalStates: states(),
    service: recordingService(),
    ...(tab === undefined ? {} : { initialTab: tab }),
  };
}

/** The tab strip's labels, so a hint mentioning "project" cannot be mistaken for one. */
function tabTitles(markup: string): readonly string[] {
  return [...markup.matchAll(/role="tab"[^>]*>(?:<svg.*?<\/svg>)?<span>([^<]*)<\/span>/g)].map(
    (match) => match[1] ?? "",
  );
}

describe("the tab table", () => {
  test("is exactly General, Terminal, Profiles and Notifications", () => {
    expect(SETTINGS_TABS.map((tab) => tab.id)).toEqual([
      "general",
      "terminal",
      "profiles",
      "notifications",
    ]);
  });

  test("has no Projects tab", () => {
    // Deliberate: a project's settings belong to that project and are edited from
    // its sidebar row. A Projects tab would be a second place to find them, and
    // would imply projects are configured globally — which is backwards.
    const ids: readonly string[] = SETTINGS_TABS.map((tab) => tab.id);
    expect(ids).not.toContain("projects");
    expect(SETTINGS_TABS.some((tab) => tab.title === "Projects")).toBe(false);
  });

  test("every tab has a title and an icon name", () => {
    for (const tab of SETTINGS_TABS) {
      expect(tab.title.length).toBeGreaterThan(0);
      expect(tab.iconName.length).toBeGreaterThan(0);
    }
  });
});

describe("the window", () => {
  test("renders one tab per row of the table, and nothing else", () => {
    const titles = tabTitles(renderToStaticMarkup(<SettingsWindow {...props()} />));
    expect(titles).toEqual(["General", "Terminal", "Profiles", "Notifications"]);
    expect(titles).not.toContain("Projects");
  });

  test("opens on General and marks it selected", () => {
    const markup = renderToStaticMarkup(<SettingsWindow {...props()} />);
    expect(markup).toContain('role="tab" aria-selected="true"');
    expect(markup).toContain("Default launch profile");
    expect(markup).toContain("Background service");
  });

  test("opens on the tab it was asked for", () => {
    // How a banner sends someone straight to the pane that fixes their problem.
    expect(renderToStaticMarkup(<SettingsWindow {...props("profiles")} />)).toContain(
      "Launch profiles",
    );
    expect(renderToStaticMarkup(<SettingsWindow {...props("terminal")} />)).toContain(
      "Font family",
    );
    expect(renderToStaticMarkup(<SettingsWindow {...props("notifications")} />)).toContain(
      "Notify when a terminal rings the bell",
    );
  });

  test("every tab renders a pane rather than an empty view", () => {
    for (const tab of SETTINGS_TABS) {
      const markup = renderToStaticMarkup(<SettingsWindow {...props(tab.id)} />);
      expect(markup).toContain('role="tabpanel"');
      expect(markup).toContain("<fieldset");
    }
  });
});

describe("the Terminal pane", () => {
  test("shows the default stack as a placeholder rather than as a value", () => {
    // An empty field means "no override", so the default must not be typed into
    // it — that would make the default look like the user's own choice.
    const markup = renderToStaticMarkup(<SettingsWindow {...props("terminal")} />);
    expect(markup).toContain('placeholder="&quot;SF Mono&quot;');
    expect(markup).toContain('value=""');
  });

  test("bounds the font size", () => {
    const markup = renderToStaticMarkup(<SettingsWindow {...props("terminal")} />);
    expect(markup).toContain('min="8"');
    expect(markup).toContain('max="32"');
  });
});

describe("the Notifications pane", () => {
  test("offers the bell switch and states what always delivers regardless", () => {
    const markup = renderToStaticMarkup(<SettingsWindow {...props("notifications")} />);
    expect(markup).toContain("Notify when a terminal rings the bell");
    expect(markup).toContain("always deliver");
    // The in-app channel needs no permission, and the pane says so.
    expect(markup).toContain("sidebar keeps working");
  });

  test("is one switch, not a rule builder", () => {
    const markup = renderToStaticMarkup(<SettingsWindow {...props("notifications")} />);
    expect([...markup.matchAll(/type="checkbox"/g)]).toHaveLength(1);
  });
});
