import { describe, expect, test } from "bun:test";

import type { Project } from "@janela/core";
import { absolutePath } from "@janela/core";
import { SidebarProvider } from "@janela/design";
import { renderToStaticMarkup } from "react-dom/server";

import { ClientEnvironmentProvider } from "./client-environment.tsx";
import { DEFAULT_GLOBAL_SETTINGS, withTerminalFontSize } from "./global-settings.ts";
import { profileDraft } from "./profile-editing.ts";
import type { SettingsDraft } from "./settings-draft.ts";
import {
  EMPTY_SETTINGS_DRAFT,
  withDraftProfile,
  withDraftProjectSettings,
  withDraftSettings,
} from "./settings-draft.ts";
import type { SettingsPaneProps } from "./settings-window.tsx";
import { SETTINGS_TABS, SettingsPane, SettingsSidebar } from "./settings-window.tsx";
import {
  fakeClientEnvironment,
  fakeProfile,
  fakeProject,
  fakeSession,
  fakeSettings,
  fakeShellProfile,
  recordingService,
  reportedAvailable,
  states,
} from "./test-fakes.ts";
import type { SettingsRoute, SettingsTabID } from "./view-state.ts";

const shell = fakeShellProfile();
const claude = fakeProfile({ name: "Claude Code" });

const noop = (): void => {};

const JANELA = fakeProject({ name: "janela", directory: absolutePath("/Users/me/code/janela") });
const API = fakeProject({ name: "api", directory: absolutePath("/Users/me/code/api") });
const PROJECTS: readonly Project[] = [JANELA, API];

const tabRoute = (tab: SettingsTabID): SettingsRoute => ({ kind: "tab", tab });
const projectRoute = (project: Project): SettingsRoute => ({
  kind: "project",
  projectID: project.id,
});

function props(
  route: SettingsRoute = tabRoute("general"),
  projects: readonly Project[] = PROJECTS,
  draft: SettingsDraft = EMPTY_SETTINGS_DRAFT,
): SettingsPaneProps {
  return {
    route,
    settings: DEFAULT_GLOBAL_SETTINGS,
    profiles: [shell, claude],
    availability: reportedAvailable(shell, claude),
    sessions: [fakeSession()],
    terminalStates: states(),
    service: recordingService(),
    projects,
    draft,
    onChangeDraft: () => {},
  };
}

function sidebar(
  route: SettingsRoute = tabRoute("general"),
  projects: readonly Project[] = PROJECTS,
): string {
  // Under a provider: the navigation's subject is its props, but its first row
  // is the window's own — it makes room for the traffic lights the same way the
  // workspace sidebar does, and that fact comes from the environment.
  return renderToStaticMarkup(
    <ClientEnvironmentProvider environment={fakeClientEnvironment()}>
      <SidebarProvider>
        <SettingsSidebar route={route} projects={projects} onSelect={noop} onBack={noop} />
      </SidebarProvider>
    </ClientEnvironmentProvider>,
  );
}

/** The navigation's row labels, so a hint mentioning "project" cannot be mistaken for one. */
function rowTitles(markup: string): readonly string[] {
  // Read from the row's own text rather than its markup: the title is what a user
  // sees, and the element the design system renders it in is not our contract.
  //
  // `aria-hidden` spans are dropped first: the row's label is drawn twice, once
  // invisibly at the heaviest weight to reserve the width its own hover state
  // will need, so the raw text of a row is its title twice over.
  return [...markup.matchAll(/role="tab"[^>]*>(.*?)<\/button>/g)].map((match) =>
    (match[1] ?? "")
      .replaceAll(/<span[^>]*aria-hidden="true"[^>]*>.*?<\/span>/g, "")
      .replaceAll(/<[^>]*>/g, "")
      .trim(),
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

  test("has no Projects tab: the projects are rows, not a fifth pane", () => {
    // A tab would be one destination for a list of forms. Each project is its own
    // route instead, which is what lets a menu item deep-link to one.
    const ids: readonly string[] = SETTINGS_TABS.map((tab) => tab.id);
    expect(ids).not.toContain("projects");
    expect(SETTINGS_TABS.some((tab) => tab.title === "Projects")).toBe(false);
  });

  test("every tab has a title", () => {
    for (const tab of SETTINGS_TABS) {
      expect(tab.title.length).toBeGreaterThan(0);
    }
  });
});

describe("the sidebar", () => {
  test("lists the four tabs and then every project, under a Projects heading", () => {
    const markup = sidebar();
    expect(rowTitles(markup)).toEqual([
      "General",
      "Terminal",
      "Profiles",
      "Notifications",
      "janela",
      "api",
    ]);
    // Positioned by the rows' own ids: every element id in this window starts
    // with `janela-`, so searching the markup for a project's *name* would find
    // the chrome instead.
    expect(markup.indexOf("Projects")).toBeGreaterThan(markup.indexOf("Notifications"));
    expect(markup.indexOf("Projects")).toBeLessThan(markup.indexOf(`tab-project-${JANELA.id}`));
  });

  test("is one tablist across both groups, so the rows are numbered together", () => {
    // Two lists would announce "tab 1 of 2" for the first project, which is a
    // different claim about where the user is.
    const markup = sidebar();
    expect([...markup.matchAll(/role="tablist"/g)]).toHaveLength(1);
  });

  test("marks the showing project selected, and nothing else", () => {
    const markup = sidebar(projectRoute(API));
    expect(markup).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>(?:(?!<\/button>).)*api/);
    expect([...markup.matchAll(/aria-selected="true"/g)]).toHaveLength(1);
  });

  test("a project row carries the same generated icon its workspace row has", () => {
    // Recognising the row before reading it is the whole reason the workspace
    // sidebar generates these; a bare list of names here would be a second,
    // worse view of the same projects. `DitherAvatar` labels itself with its
    // seed, which is the project's directory.
    expect(sidebar()).toContain(`${JANELA.directory} avatar`);
  });

  test("marks the showing tab selected, and pins Back below the projects", () => {
    const markup = sidebar(tabRoute("profiles"));
    expect(markup).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>(?:(?!<\/button>).)*Profiles/);
    expect([...markup.matchAll(/aria-selected="true"/g)]).toHaveLength(1);
    expect(markup).toContain('data-sidebar="footer"');
    expect(markup.indexOf("Back")).toBeGreaterThan(markup.indexOf(`tab-project-${API.id}`));
  });

  test("says which nothing it is when no project has been added", () => {
    // A heading over an empty list reads as a list that failed to load.
    const markup = sidebar(tabRoute("general"), []);
    expect(markup).toContain("Projects");
    expect(markup).toContain("No projects yet.");
    expect(rowTitles(markup)).toEqual(["General", "Terminal", "Profiles", "Notifications"]);
  });

  test("is the window's own surface, and collapses like the default sidebar", () => {
    const markup = sidebar();

    // `inset` is what puts the content on a card and the sidebar on the window;
    // the trigger is the only way to collapse it, and settings had neither.
    expect(markup).toContain('data-variant="inset"');
    expect(markup).toContain('data-sidebar="trigger"');
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
      const markup = renderToStaticMarkup(<SettingsPane {...props(tabRoute(tab.id))} />);
      expect(markup).toContain('role="tabpanel"');
      expect(markup).toContain(PANE_COPY[tab.id]);
    }
  });

  test("a project route heads the pane with its name and its directory", () => {
    const markup = renderToStaticMarkup(<SettingsPane {...props(projectRoute(JANELA))} />);
    expect(markup).toContain("janela");
    // The path is what tells two clones of one repository apart.
    expect(markup).toContain(JANELA.directory);
    expect(markup).toContain("When a session is first opened");
  });

  test("a project the mirror no longer has renders no editor", () => {
    // The daemon is the source of truth, and it has said this project is gone.
    const markup = renderToStaticMarkup(<SettingsPane {...props(projectRoute(JANELA), [API])} />);
    expect(markup).toContain('role="tabpanel"');
    expect(markup).not.toContain("When a session is first opened");
  });

  test("reads the draft rather than the store, on a tab and on a project alike", () => {
    // The whole point of the screen-wide draft: an unsaved edit is what the pane
    // shows, whatever the mirror and the settings store still say.
    const draft = withDraftProjectSettings(
      withDraftSettings(EMPTY_SETTINGS_DRAFT, withTerminalFontSize(DEFAULT_GLOBAL_SETTINGS, 21)),
      JANELA.id,
      fakeSettings({ worktreeRoot: { kind: "custom", directory: absolutePath("/tmp/trees") } }),
    );

    expect(
      renderToStaticMarkup(<SettingsPane {...props(tabRoute("terminal"), PROJECTS, draft)} />),
    ).toContain('value="21"');
    expect(
      renderToStaticMarkup(<SettingsPane {...props(projectRoute(JANELA), PROJECTS, draft)} />),
    ).toContain('value="/tmp/trees"');
  });

  test("a profile renamed but not saved reads the same in every picker", () => {
    // The pickers are on other panes than the editor that renamed it. Reading
    // the mirror there would show one profile under two names at once.
    const draft = withDraftProfile(EMPTY_SETTINGS_DRAFT, profileDraft({ ...claude, name: "Opus" }));

    for (const route of [tabRoute("general"), projectRoute(JANELA)]) {
      const markup = renderToStaticMarkup(<SettingsPane {...props(route, PROJECTS, draft)} />);
      expect(markup).toContain("Opus");
      expect(markup).not.toContain("Claude Code");
    }
  });

  test("carries no Save of its own: the bar is a sibling of the panel", () => {
    // The bar commits every tab, so it cannot live inside the one on screen —
    // and it must not scroll away with the form either.
    const markup = renderToStaticMarkup(<SettingsPane {...props(projectRoute(JANELA))} />);
    expect(markup).not.toContain("</footer>");
    expect(markup).not.toContain(">Save</button>");
  });
});

describe("the Terminal pane", () => {
  test("shows the default stack as a placeholder rather than as a value", () => {
    // An empty field means "no override", so the default must not be typed into
    // it — that would make the default look like the user's own choice.
    const markup = renderToStaticMarkup(<SettingsPane {...props(tabRoute("terminal"))} />);
    expect(markup).toContain('placeholder="&quot;SF Mono&quot;');
    expect(markup).toContain('value=""');
  });

  test("bounds the font size", () => {
    const markup = renderToStaticMarkup(<SettingsPane {...props(tabRoute("terminal"))} />);
    expect(markup).toContain('min="8"');
    expect(markup).toContain('max="32"');
  });
});

describe("the Notifications pane", () => {
  test("offers the bell switch and states what always delivers regardless", () => {
    const markup = renderToStaticMarkup(<SettingsPane {...props(tabRoute("notifications"))} />);
    expect(markup).toContain("Notify when a terminal rings the bell");
    expect(markup).toContain("always deliver");
    // The in-app channel needs no permission, and the pane says so.
    expect(markup).toContain("sidebar keeps working");
  });

  test("is one switch, not a rule builder", () => {
    const markup = renderToStaticMarkup(<SettingsPane {...props(tabRoute("notifications"))} />);
    expect([...markup.matchAll(/role="switch"/g)]).toHaveLength(1);
  });
});
