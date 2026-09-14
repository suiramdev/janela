import { describe, expect, test } from "bun:test";

import { SidebarProvider } from "@janela/design";
import { renderToStaticMarkup } from "react-dom/server";

import { DEFAULT_GLOBAL_SETTINGS } from "./global-settings.ts";
import type { SettingsPaneProps, SettingsTabID } from "./settings-window.tsx";
import {
  neighbouringTab,
  SETTINGS_TABS,
  SettingsPane,
  SettingsSidebar,
} from "./settings-window.tsx";
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

const noop = (): void => {};

function props(tab: SettingsTabID = "general"): SettingsPaneProps {
  return {
    tab,
    settings: DEFAULT_GLOBAL_SETTINGS,
    onChangeSettings: () => {},
    profiles: [shell, claude],
    availability: reportedAvailable(shell, claude),
    profileEditing: recordingProfileEditing(),
    sessions: [fakeSession()],
    terminalStates: states(),
    service: recordingService(),
  };
}

function sidebar(tab: SettingsTabID = "general"): string {
  return renderToStaticMarkup(
    <SidebarProvider>
      <SettingsSidebar tab={tab} onSelectTab={noop} onBack={noop} />
    </SidebarProvider>,
  );
}

/** The sidebar's tab labels, so a hint mentioning "project" cannot be mistaken for one. */
function tabTitles(markup: string): readonly string[] {
  // Read from the tab's own text rather than its markup: the title is what a user
  // sees, and the element the design system renders it in is not our contract.
  return [...markup.matchAll(/role="tab"[^>]*>(.*?)<\/button>/g)].map((match) =>
    (match[1] ?? "").replaceAll(/<[^>]*>/g, "").trim(),
  );
}

/** Copy only that pane renders, so "the pane is there" cannot pass on the chrome alone. */
const PANE_COPY: Readonly<Record<SettingsTabID, string>> = {
  general: "Default launch profile",
  terminal: "Font family",
  profiles: "Launch profiles",
  notifications: "Notification Centre",
};

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

  test("every tab has a title", () => {
    for (const tab of SETTINGS_TABS) {
      expect(tab.title.length).toBeGreaterThan(0);
    }
  });

  test("the arrow keys wrap at both ends", () => {
    expect(neighbouringTab("general", -1)).toBe("notifications");
    expect(neighbouringTab("notifications", 1)).toBe("general");
    expect(neighbouringTab("terminal", 1)).toBe("profiles");
  });
});

describe("the sidebar", () => {
  test("renders one tab per row of the table, and nothing else", () => {
    const titles = tabTitles(sidebar());
    expect(titles).toEqual(["General", "Terminal", "Profiles", "Notifications"]);
    expect(titles).not.toContain("Projects");
  });

  test("marks the showing tab selected, and pins Back below the tabs", () => {
    const markup = sidebar("profiles");
    expect(markup).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>(?:(?!<\/button>).)*Profiles/);
    expect([...markup.matchAll(/aria-selected="true"/g)]).toHaveLength(1);
    expect(markup).toContain('data-sidebar="footer"');
    expect(markup.indexOf("Back")).toBeGreaterThan(markup.indexOf("Notifications"));
  });
});

describe("the pane", () => {
  test("opens on General and states the background service", () => {
    const markup = renderToStaticMarkup(<SettingsPane {...props()} />);
    expect(markup).toContain("Default launch profile");
    expect(markup).toContain("Background service");
  });

  test("every tab renders its own pane rather than an empty view", () => {
    for (const tab of SETTINGS_TABS) {
      const markup = renderToStaticMarkup(<SettingsPane {...props(tab.id)} />);
      expect(markup).toContain('role="tabpanel"');
      expect(markup).toContain(PANE_COPY[tab.id]);
    }
  });
});

describe("the Terminal pane", () => {
  test("shows the default stack as a placeholder rather than as a value", () => {
    // An empty field means "no override", so the default must not be typed into
    // it — that would make the default look like the user's own choice.
    const markup = renderToStaticMarkup(<SettingsPane {...props("terminal")} />);
    expect(markup).toContain('placeholder="&quot;SF Mono&quot;');
    expect(markup).toContain('value=""');
  });

  test("bounds the font size", () => {
    const markup = renderToStaticMarkup(<SettingsPane {...props("terminal")} />);
    expect(markup).toContain('min="8"');
    expect(markup).toContain('max="32"');
  });
});

describe("the Notifications pane", () => {
  test("offers the bell switch and states what always delivers regardless", () => {
    const markup = renderToStaticMarkup(<SettingsPane {...props("notifications")} />);
    expect(markup).toContain("Notify when a terminal rings the bell");
    expect(markup).toContain("always deliver");
    // The in-app channel needs no permission, and the pane says so.
    expect(markup).toContain("sidebar keeps working");
  });

  test("is one switch, not a rule builder", () => {
    const markup = renderToStaticMarkup(<SettingsPane {...props("notifications")} />);
    expect([...markup.matchAll(/role="switch"/g)]).toHaveLength(1);
  });
});
