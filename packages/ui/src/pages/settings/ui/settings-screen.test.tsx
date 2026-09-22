import { describe, expect, test } from "bun:test";

import type { Project } from "@janela/core";
import { absolutePath } from "@janela/core";
import { SidebarProvider } from "@janela/design";
import { renderToStaticMarkup } from "react-dom/server";

import {
  environmentOver,
  fakeClientEnvironment,
  fakeFolderProject,
  fakeProject,
  fakeSession,
  fakeSettings,
  recordingAppearance,
  recordingNotificationSound,
  recordingService,
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
  withDraftProjectSettings,
  withDraftSettings,
  withNotificationEvent,
  withSilencedConfirmation,
  withTerminalFontSize,
} from "../../../shared/model/index.ts";
import { SETTINGS_TAB_INFO, projectSections, sectionElementID } from "../model/settings-index.ts";
import {
  SETTINGS_TABS,
  SettingsPane,
  type SettingsPaneProps,
  SettingsScreen,
  SettingsSidebar,
} from "./settings-screen.tsx";

const noop = (): void => {};

const JANELA = fakeProject({ name: "janela", directory: absolutePath("/Users/me/code/janela") });

const API = fakeProject({ name: "api", directory: absolutePath("/Users/me/code/api") });

const NOTES = fakeFolderProject({ name: "notes" });

const PROJECTS: readonly Project[] = [JANELA, API];

const tabRoute = (tab: SettingsTabID): SettingsRoute => ({ kind: "tab", tab });

const projectRoute = (project: Project): SettingsRoute => ({
  kind: "project",
  projectID: project.id,
});

const PANE_COPY = {
  appearance: "Font family",
  notifications: "rings the bell",
  shortcuts: "Close Pane",
  integrations: "Janela reads nothing else",
  permissions: "Ask before closing a running terminal",
} satisfies Record<SettingsTabID, string>;

const withProjects = (): ClientEnvironment => environmentOver({ sessions: [], projects: PROJECTS });

const barButton = (markup: string, label: "Save" | "Revert"): string =>
  new RegExp(`<button[^>]*>${label}</button>`).exec(markup)?.[0] ?? "";

function props(
  route: SettingsRoute = tabRoute("appearance"),
  projects: readonly Project[] = PROJECTS,
  draft: SettingsDraft = EMPTY_SETTINGS_DRAFT,
): SettingsPaneProps {
  return {
    route,
    settings: DEFAULT_GLOBAL_SETTINGS,
    sessions: [fakeSession()],
    terminalStates: states(),
    service: recordingService(),
    appearance: recordingAppearance(),
    sound: recordingNotificationSound(),
    connection: fakeClientEnvironment().connection,
    projects,
    draft,
    onRecordingShortcut: noop,
    onChangeDraft: () => {},
  };
}

function sidebar(
  route: SettingsRoute = tabRoute("appearance"),
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
  test("is one subject per pane, in the order the sidebar shows", () => {
    expect(SETTINGS_TABS.map((tab) => tab.id)).toEqual([
      "appearance",
      "notifications",
      "shortcuts",
      "integrations",
      "permissions",
    ]);
  });

  test("has no General: a pane named after nothing collects everything", () => {
    const titles: readonly string[] = SETTINGS_TABS.map((tab) => tab.title);

    expect(titles).not.toContain("General");
    expect(titles).not.toContain("Advanced");
  });

  test("has no Projects tab: the projects are rows, not a sixth pane", () => {
    const ids: readonly string[] = SETTINGS_TABS.map((tab) => tab.id);

    expect(ids).not.toContain("projects");
    expect(SETTINGS_TABS.some((tab) => tab.title === "Projects")).toBe(false);
  });

  test("every pane says what it is for and holds at least one setting", () => {
    for (const info of SETTINGS_TAB_INFO) {
      expect(info.title.length).toBeGreaterThan(0);
      expect(info.description.length).toBeGreaterThan(0);
      expect(info.sections.length).toBeGreaterThan(0);
    }
  });
});

describe("the section index", () => {
  test("every global section it advertises is on the pane it names", () => {
    for (const info of SETTINGS_TAB_INFO) {
      const markup = renderToStaticMarkup(<SettingsPane {...props(tabRoute(info.id))} />);

      for (const section of info.sections) {
        expect(markup).toContain(sectionElementID(section.id));
        expect(markup).toContain(section.title);

        for (const field of section.fields) expect(markup).toContain(field);
      }
    }
  });

  test("every project section it advertises is on the project pane", () => {
    const markup = renderToStaticMarkup(<SettingsPane {...props(projectRoute(JANELA))} />);

    for (const section of projectSections(JANELA)) {
      expect(markup).toContain(sectionElementID(section.id));
      expect(markup).toContain(section.title);

      for (const field of section.fields) expect(markup).toContain(field);
    }
  });

  test("a folder project is offered no worktree section, and does not render one", () => {
    const ids = projectSections(NOTES).map((section) => section.id);
    const markup = renderToStaticMarkup(<SettingsPane {...props(projectRoute(NOTES), [NOTES])} />);

    expect(ids).not.toContain("projectWorktrees");
    expect(markup).not.toContain("Use a directory I choose");
  });
});

describe("the sidebar", () => {
  test("groups the global panes under Janela, then every project", () => {
    const markup = sidebar();

    expect(rowTitles(markup)).toEqual([
      "Appearance",
      "Notifications",
      "Shortcuts",
      "Integrations",
      "Permissions",
      "janela",
      "api",
    ]);

    expect(markup.indexOf("Janela")).toBeLessThan(markup.indexOf("Projects"));
    expect(markup.indexOf("Projects")).toBeLessThan(markup.indexOf(`tab-project-${JANELA.id}`));
  });

  test("is one tablist across both groups, so the rows are numbered together", () => {
    const markup = sidebar();

    expect([...markup.matchAll(/role="tablist"/g)]).toHaveLength(1);
  });

  test("offers a search field above the groups", () => {
    const markup = sidebar();

    expect(markup).toContain('placeholder="Search settings"');
    expect(markup.indexOf("Search settings")).toBeLessThan(markup.indexOf("Appearance"));
    expect(markup).not.toContain('aria-label="Clear search"');
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
    const markup = sidebar(tabRoute("integrations"));

    expect(markup).toMatch(
      /role="tab"[^>]*aria-selected="true"[^>]*>(?:(?!<\/button>).)*Integrations/,
    );

    expect([...markup.matchAll(/aria-selected="true"/g)]).toHaveLength(1);
    expect(markup).toContain('data-sidebar="footer"');
    expect(markup.indexOf("Back")).toBeGreaterThan(markup.indexOf(`tab-project-${API.id}`));
  });

  test("says which nothing it is when no project has been added", () => {
    const markup = sidebar(tabRoute("appearance"), []);

    expect(markup).toContain("Projects");
    expect(markup).toContain("No projects yet.");
    expect(rowTitles(markup)).toEqual([
      "Appearance",
      "Notifications",
      "Shortcuts",
      "Integrations",
      "Permissions",
    ]);
  });

  test("is the window's own surface, and collapses like the default sidebar", () => {
    const markup = sidebar();

    expect(markup).toContain('data-variant="inset"');
    expect(markup).toContain('data-sidebar="trigger"');
  });
});

describe("the pane", () => {
  test("heads every pane with its title and what it is for", () => {
    const markup = renderToStaticMarkup(<SettingsPane {...props(tabRoute("permissions"))} />);

    expect(markup).toContain('id="janela-settings-pane-title"');
    expect(markup).toContain("Permissions");
    expect(markup).toContain("What Janela asks before it acts");
    expect(markup).toContain('aria-labelledby="janela-settings-pane-title"');
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
      renderToStaticMarkup(<SettingsPane {...props(tabRoute("appearance"), PROJECTS, draft)} />),
    ).toContain('value="21"');

    expect(
      renderToStaticMarkup(<SettingsPane {...props(projectRoute(JANELA), PROJECTS, draft)} />),
    ).toContain('value="/tmp/trees"');
  });

  test("carries no Save of its own: the bar is a sibling of the panel", () => {
    const markup = renderToStaticMarkup(<SettingsPane {...props(projectRoute(JANELA))} />);

    expect(markup).not.toContain("</footer>");
    expect(markup).not.toContain(">Save</button>");
  });
});

describe("the Appearance pane", () => {
  test("shows the default stack as a placeholder rather than as a value", () => {
    const markup = renderToStaticMarkup(<SettingsPane {...props(tabRoute("appearance"))} />);

    expect(markup).toContain('placeholder="&quot;SF Mono&quot;');
    expect(markup).toContain('value=""');
  });

  test("bounds the font size", () => {
    const markup = renderToStaticMarkup(<SettingsPane {...props(tabRoute("appearance"))} />);

    expect(markup).toContain('min="8"');
    expect(markup).toContain('max="32"');
  });
});

describe("the Permissions pane", () => {
  test("holds the question asked before a terminal is closed", () => {
    const markup = renderToStaticMarkup(<SettingsPane {...props(tabRoute("permissions"))} />);

    expect(markup).toContain("Ask before closing a running terminal");
    expect(markup).toContain("Idle and finished terminals never ask");
  });

  test("states how the notification permission is asked, without a control", () => {
    const markup = renderToStaticMarkup(<SettingsPane {...props(tabRoute("permissions"))} />);

    expect(markup).toContain("Notification Centre");
    expect(markup).toContain("sidebar keeps working");
  });

  test("reads the closing question as off once it has been silenced", () => {
    const asks = renderToStaticMarkup(<SettingsPane {...props(tabRoute("permissions"))} />);
    const silenced = renderToStaticMarkup(
      <SettingsPane
        {...props(
          tabRoute("permissions"),
          PROJECTS,
          withDraftSettings(
            EMPTY_SETTINGS_DRAFT,
            withSilencedConfirmation(DEFAULT_GLOBAL_SETTINGS, "closeTerminals", true),
          ),
        )}
      />,
    );

    expect(/role="switch"[^>]*aria-checked="(?<state>[a-z]+)"/u.exec(asks)?.groups?.["state"]).toBe(
      "true",
    );

    expect(
      /role="switch"[^>]*aria-checked="(?<state>[a-z]+)"/u.exec(silenced)?.groups?.["state"],
    ).toBe("false");
  });
});

describe("the Notifications pane", () => {
  test("is one row per event, each with its own switch and sound", () => {
    const markup = renderToStaticMarkup(<SettingsPane {...props(tabRoute("notifications"))} />);

    expect([...markup.matchAll(/role="switch"/g)]).toHaveLength(4);
    expect([...markup.matchAll(/<select/g)]).toHaveLength(4);
    expect(markup).toContain("A terminal rings the bell");
    expect(markup).toContain("An agent is waiting for you");
    expect(markup).toContain("An agent finishes");
    expect(markup).toContain("An agent stops with an error");
  });

  test("says what always delivers regardless of the switch", () => {
    const markup = renderToStaticMarkup(<SettingsPane {...props(tabRoute("notifications"))} />);

    expect(markup).toContain("always delivers");
  });

  test("each row's sound reads that event's setting, not another's", () => {
    const settings = withNotificationEvent(DEFAULT_GLOBAL_SETTINGS, "failed", {
      notifies: true,
      sound: { kind: "system", name: "Basso" },
    });

    const markup = renderToStaticMarkup(
      <SettingsPane {...props(tabRoute("notifications"))} settings={settings} />,
    );

    const selected = [...markup.matchAll(/<option[^>]*value="([^"]*)" selected=""/g)].map(
      (match) => match[1],
    );

    expect(selected).toEqual(["silent", "silent", "silent", "system:Basso"]);
  });

  test("a row whose switch is off cannot be given a sound", () => {
    const markup = renderToStaticMarkup(<SettingsPane {...props(tabRoute("notifications"))} />);
    const bellSelect = /<select[^>]*aria-label="Sound — A terminal rings the bell"[^>]*/.exec(
      markup,
    );

    const waitingSelect = /<select[^>]*aria-label="Sound — An agent is waiting for you"[^>]*/.exec(
      markup,
    );

    expect(bellSelect?.[0]).toContain('disabled=""');
    expect(waitingSelect?.[0]).not.toContain('disabled=""');
  });

  test("the browser client, which cannot play a sound, shows the switches alone", () => {
    const markup = renderToStaticMarkup(
      <SettingsPane {...props(tabRoute("notifications"))} sound={undefined} />,
    );

    expect([...markup.matchAll(/role="switch"/g)]).toHaveLength(4);
    expect(markup).not.toContain("<select");
  });
});

describe("the screen", () => {
  test("fills the window the way the workspace does", () => {
    const markup = screen(tabRoute("appearance"), withProjects());

    expect(markup).toContain('data-variant="inset"');
    expect(markup).toContain('data-slot="sidebar-inset"');
    expect(markup).toContain("Font family");
  });

  test("a project's settings are a pane in the screen, reached by route", () => {
    const markup = screen(projectRoute(JANELA), withProjects());

    expect(markup).toContain("When a session is first opened");
    expect(markup).toContain("/Users/me/code/janela");
    expect(markup).toMatch(/aria-selected="true"[^>]*>(?:(?!<\/button>).)*janela/);
  });

  test("a project the mirror does not have falls back to the first pane", () => {
    const markup = screen(projectRoute(fakeProject({ name: "gone" })), withProjects());

    expect(markup).toContain("Font family");
    expect(markup).not.toContain("When a session is first opened");
    expect([...markup.matchAll(/aria-selected="true"/g)]).toHaveLength(1);
  });

  describe("the commit bar", () => {
    test("is quiet at rest: nothing to save, and it does not say so twice", () => {
      const markup = screen(tabRoute("appearance"), withProjects());

      expect(barButton(markup, "Save")).toContain('disabled=""');
      expect(barButton(markup, "Revert")).toContain('disabled=""');
      expect(markup).not.toContain("unsaved change");
    });

    test("counts an edit made on a pane the user has since left", () => {
      const environment = withProjects();
      environment.view.editSettingsDraft(
        withDraftProjectSettings(EMPTY_SETTINGS_DRAFT, JANELA.id, {
          worktreeRoot: { kind: "siblingDirectory" },
          automation: {},
        }),
      );

      const markup = screen(tabRoute("appearance"), environment);

      expect(markup).toContain("1 unsaved change");
      expect(barButton(markup, "Save")).not.toContain('disabled=""');
      expect(barButton(markup, "Revert")).not.toContain('disabled=""');
    });

    test("refuses a save the daemon would reject, and names the pane to fix it on", () => {
      const environment = withProjects();
      environment.view.editSettingsDraft(
        withDraftProjectSettings(EMPTY_SETTINGS_DRAFT, JANELA.id, {
          worktreeRoot: { kind: "siblingDirectory" },
          automation: { sessionTeardown: { script: "docker compose down", timeoutSeconds: 0 } },
        }),
      );

      const markup = screen(tabRoute("notifications"), environment);

      expect(barButton(markup, "Save")).toContain('disabled=""');
      expect(markup).toContain("A teardown timeout must be at least one second.");
      expect(markup).toContain("janela");
      expect(barButton(markup, "Revert")).not.toContain('disabled=""');
    });
  });
});
