import { describe, expect, test } from "bun:test";

import type { Project } from "@janela/core";
import { absolutePath, newAutomationID } from "@janela/core";
import { SidebarProvider } from "@janela/design";
import { renderToStaticMarkup } from "react-dom/server";

import {
  environmentOver,
  fakeClientEnvironment,
  fakeProfile,
  fakeProject,
  fakeSession,
  fakeSettings,
  fakeShellProfile,
  recordingService,
  reportedAvailable,
  states,
} from "../../../shared/lib/test-fakes/index.ts";
import {
  ClientEnvironmentProvider,
  type ClientEnvironment,
  DEFAULT_GLOBAL_SETTINGS,
  EMPTY_SETTINGS_DRAFT,
  type SettingsDraft,
  type SettingsRoute,
  type SettingsTabID,
  profileDraft,
  withDraftProfile,
  withDraftProjectSettings,
  withDraftSettings,
  withTerminalFontSize,
} from "../../../shared/model/index.ts";
import {
  SETTINGS_TABS,
  SettingsPane,
  type SettingsPaneProps,
  SettingsScreen,
  SettingsSidebar,
} from "./settings-screen.tsx";

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

const PANE_COPY = {
  general: "Default launch profile",
  terminal: "Font family",
  profiles: "Launch profiles",
  notifications: "Notification Centre",
} satisfies Record<SettingsTabID, string>;

const withProjects = (): ClientEnvironment => environmentOver({ sessions: [], projects: PROJECTS });

const barButton = (markup: string, label: "Save" | "Revert"): string =>
  new RegExp(`<button[^>]*>${label}</button>`).exec(markup)?.[0] ?? "";

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
  return renderToStaticMarkup(
    <ClientEnvironmentProvider environment={fakeClientEnvironment()}>
      <SidebarProvider>
        <SettingsSidebar route={route} projects={projects} onSelect={noop} onBack={noop} />
      </SidebarProvider>
    </ClientEnvironmentProvider>,
  );
}

function rowTitles(markup: string): readonly string[] {
  return [...markup.matchAll(/role="tab"[^>]*>(.*?)<\/button>/g)].map((match) =>
    (match[1] ?? "")
      .replaceAll(/<span[^>]*aria-hidden="true"[^>]*>.*?<\/span>/g, "")
      .replaceAll(/<[^>]*>/g, "")
      .trim(),
  );
}

function screen(route: SettingsRoute, environment: ClientEnvironment): string {
  return renderToStaticMarkup(
    <ClientEnvironmentProvider environment={environment}>
      <SidebarProvider>
        <SettingsScreen route={route} />
      </SidebarProvider>
    </ClientEnvironmentProvider>,
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

  test("has no Projects tab: the projects are rows, not a fifth pane", () => {
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
    expect(markup.indexOf("Projects")).toBeGreaterThan(markup.indexOf("Notifications"));
    expect(markup.indexOf("Projects")).toBeLessThan(markup.indexOf(`tab-project-${JANELA.id}`));
  });

  test("is one tablist across both groups, so the rows are numbered together", () => {
    const markup = sidebar();

    expect([...markup.matchAll(/role="tablist"/g)]).toHaveLength(1);
  });

  test("marks the showing project selected, and nothing else", () => {
    const markup = sidebar(projectRoute(API));

    expect(markup).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>(?:(?!<\/button>).)*api/);
    expect([...markup.matchAll(/aria-selected="true"/g)]).toHaveLength(1);
  });

  test("a project row carries the same generated icon its workspace row has", () => {
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
    const markup = sidebar(tabRoute("general"), []);

    expect(markup).toContain("Projects");
    expect(markup).toContain("No projects yet.");
    expect(rowTitles(markup)).toEqual(["General", "Terminal", "Profiles", "Notifications"]);
  });

  test("is the window's own surface, and collapses like the default sidebar", () => {
    const markup = sidebar();

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
    expect(markup).toContain(JANELA.directory);
    expect(markup).toContain("When a session is first opened");
  });

  test("a project the mirror no longer has renders no editor", () => {
    const markup = renderToStaticMarkup(<SettingsPane {...props(projectRoute(JANELA), [API])} />);

    expect(markup).toContain('role="tabpanel"');
    expect(markup).not.toContain("When a session is first opened");
  });

  test("reads the draft rather than the store, on a tab and on a project alike", () => {
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
    const draft = withDraftProfile(EMPTY_SETTINGS_DRAFT, profileDraft({ ...claude, name: "Opus" }));

    for (const route of [tabRoute("general"), projectRoute(JANELA)]) {
      const markup = renderToStaticMarkup(<SettingsPane {...props(route, PROJECTS, draft)} />);

      expect(markup).toContain("Opus");
      expect(markup).not.toContain("Claude Code");
    }
  });

  test("carries no Save of its own: the bar is a sibling of the panel", () => {
    const markup = renderToStaticMarkup(<SettingsPane {...props(projectRoute(JANELA))} />);

    expect(markup).not.toContain("</footer>");
    expect(markup).not.toContain(">Save</button>");
  });
});

describe("the Terminal pane", () => {
  test("shows the default stack as a placeholder rather than as a value", () => {
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
    expect(markup).toContain("sidebar keeps working");
  });

  test("is one switch, not a rule builder", () => {
    const markup = renderToStaticMarkup(<SettingsPane {...props(tabRoute("notifications"))} />);

    expect([...markup.matchAll(/role="switch"/g)]).toHaveLength(1);
  });
});

describe("the screen", () => {
  test("fills the window the way the workspace does", () => {
    const markup = screen(tabRoute("general"), withProjects());

    expect(markup).toContain('data-variant="inset"');
    expect(markup).toContain('data-slot="sidebar-inset"');
    expect(markup).toContain("Background service");
  });

  test("a project's settings are a pane in the screen, reached by route", () => {
    const markup = screen(projectRoute(JANELA), withProjects());

    expect(markup).toContain("When a session is first opened");
    expect(markup).toContain("/Users/me/code/janela");
    expect(markup).toMatch(/aria-selected="true"[^>]*>(?:(?!<\/button>).)*janela/);
  });

  test("a project the mirror does not have falls back to General, not to an empty pane", () => {
    const markup = screen(projectRoute(fakeProject({ name: "gone" })), withProjects());

    expect(markup).toContain("Background service");
    expect(markup).not.toContain("When a session is first opened");
    expect([...markup.matchAll(/aria-selected="true"/g)]).toHaveLength(1);
  });

  describe("the commit bar", () => {
    test("is quiet at rest: nothing to save, and it does not say so twice", () => {
      const markup = screen(tabRoute("general"), withProjects());

      expect(barButton(markup, "Save")).toContain('disabled=""');
      expect(barButton(markup, "Revert")).toContain('disabled=""');
      expect(markup).not.toContain("unsaved change");
    });

    test("counts an edit made on a pane the user has since left", () => {
      const environment = withProjects();
      environment.view.editSettingsDraft(
        withDraftProjectSettings(EMPTY_SETTINGS_DRAFT, JANELA.id, {
          worktreeRoot: { kind: "siblingDirectory" },
          automation: [],
          isForgeEnabled: true,
        }),
      );

      const markup = screen(tabRoute("terminal"), environment);

      expect(markup).toContain("1 unsaved change");
      expect(barButton(markup, "Save")).not.toContain('disabled=""');
      expect(barButton(markup, "Revert")).not.toContain('disabled=""');
    });

    test("refuses a save the daemon would reject, and names the pane to fix it on", () => {
      const environment = withProjects();
      environment.view.editSettingsDraft(
        withDraftProjectSettings(EMPTY_SETTINGS_DRAFT, JANELA.id, {
          worktreeRoot: { kind: "siblingDirectory" },
          automation: [
            {
              id: newAutomationID(),
              event: "sessionStart",
              command: [""],
              isEnabled: true,
              timeoutSeconds: 30,
            },
          ],
          isForgeEnabled: false,
        }),
      );

      const markup = screen(tabRoute("notifications"), environment);

      expect(barButton(markup, "Save")).toContain('disabled=""');
      expect(markup).toContain("An enabled command needs an executable.");
      expect(markup).toContain("janela");
      expect(barButton(markup, "Revert")).not.toContain('disabled=""');
    });
  });
});
