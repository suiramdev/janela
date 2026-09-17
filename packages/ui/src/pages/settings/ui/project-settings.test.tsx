import { describe, expect, test } from "bun:test";

import type { AutomationScripts, LaunchProfile, Project } from "@janela/core";
import { absolutePath, AUTOMATION_VARIABLES } from "@janela/core";
import { renderToStaticMarkup } from "react-dom/server";

import {
  fakeProfile,
  fakeProject,
  fakeSettings,
  fakeShellProfile,
  reportedAvailable,
} from "../../../shared/lib/test-fakes/index.ts";
import { ProjectSettingsPane } from "./project-settings.tsx";

const noop = (): void => {};

const SHELL = fakeShellProfile();

const CLAUDE = fakeProfile({ name: "Claude Code" });

const PROFILES = [SHELL, CLAUDE];

const AVAILABLE = reportedAvailable(SHELL, CLAUDE);

const REPOSITORY = fakeProject();

const { git: _git, ...FOLDER } = fakeProject();

const CUSTOM_ROOT = fakeProject({
  settings: fakeSettings({
    worktreeRoot: { kind: "custom", directory: absolutePath("/Users/me/trees") },
  }),
});

const NO_SCRIPTS = projectWith({});

const WITH_DEV = projectWith({ sessionStart: { script: "pnpm dev", timeoutSeconds: 30 } });

const WITH_TEARDOWN = projectWith({
  sessionTeardown: { script: "docker compose down", timeoutSeconds: 30 },
});

const WITH_NON_BLOCKING = projectWith({
  sessionStart: { script: "pnpm dev", timeoutSeconds: 30 },
  worktreeCreated: { script: "pnpm install", timeoutSeconds: 30 },
});

const WITH_ZERO_TIMEOUT = projectWith({
  sessionTeardown: { script: "docker compose down", timeoutSeconds: 0 },
});

const WITH_COMMENTED_TEARDOWN = projectWith({
  sessionTeardown: { script: "# docker compose down", timeoutSeconds: 0 },
});

function projectWith(automation: AutomationScripts): Project {
  return { ...REPOSITORY, settings: fakeSettings({ automation }) };
}

function paneMarkup(project: Project, profiles: readonly LaunchProfile[] = PROFILES): string {
  return renderToStaticMarkup(
    <ProjectSettingsPane
      project={project}
      settings={project.settings}
      profiles={profiles}
      availability={AVAILABLE}
      onChange={noop}
    />,
  );
}

function editorValues(markup: string): readonly string[] {
  return [...markup.matchAll(/<textarea[^>]*>([^<]*)<\/textarea>/g)].map((match) => match[1] ?? "");
}

describe("automation authoring", () => {
  test("offers one script editor per event, and only three", () => {
    const markup = paneMarkup(NO_SCRIPTS);

    expect(markup).toContain("When a worktree is created");
    expect(markup).toContain("When a session is first opened");
    expect(markup).toContain("When a session is deleted");
    expect([...markup.matchAll(/data-slot="shell-script-editor"/g)]).toHaveLength(3);
  });

  test("shows the script it is given, in the editor for its event, and blanks for the rest", () => {
    expect(editorValues(paneMarkup(WITH_DEV))).toEqual(["", "pnpm dev", ""]);
  });

  test("names every variable a script can read, with its meaning", () => {
    const markup = paneMarkup(NO_SCRIPTS);

    for (const variable of AUTOMATION_VARIABLES) {
      expect(markup).toContain(`$${variable.name}`);
      expect(markup).toContain(variable.meaning.replaceAll("'", "&#x27;"));
    }
  });

  test("the placeholder shows the copy-a-file case, so the variables are learned by example", () => {
    expect(paneMarkup(NO_SCRIPTS)).toContain("$JANELA_PROJECT_DIRECTORY/.env");
  });

  test("records the security property in the copy the user reads", () => {
    expect(paneMarkup(NO_SCRIPTS)).toContain("never read from the repository");
  });

  test("promises the script runs in a terminal the user can watch, by their login shell", () => {
    const markup = paneMarkup(NO_SCRIPTS);

    expect(markup).toContain("watch and interrupt");
    expect(markup).toContain("login shell");
  });

  test("until Monaco mounts the editor is a real textarea holding the script, with prose helpers off", () => {
    const markup = paneMarkup(WITH_DEV);

    expect([...markup.matchAll(/data-editor="textarea"/g)]).toHaveLength(3);
    expect(markup).toContain('spellCheck="false"');
    expect(markup).toContain('autoCapitalize="off"');
  });
});

describe("the teardown timeout", () => {
  test("is shown for the one blocking event, once it has a script", () => {
    expect(paneMarkup(WITH_TEARDOWN)).toContain("Deletion waits this long");
    expect(paneMarkup(NO_SCRIPTS)).not.toContain("Deletion waits this long");
  });

  test("is not shown for events that block nothing", () => {
    expect(paneMarkup(WITH_NON_BLOCKING)).not.toContain("Deletion waits this long");
  });

  test("a zero timeout on a script that runs something is named as a violation", () => {
    expect(paneMarkup(WITH_ZERO_TIMEOUT)).toContain(
      "A teardown timeout must be at least one second.",
    );
  });

  test("a zero timeout on a comment-only script is not, because nothing waits", () => {
    expect(paneMarkup(WITH_COMMENTED_TEARDOWN)).not.toContain(
      "A teardown timeout must be at least one second.",
    );
  });
});

describe("the commit model", () => {
  test("the pane carries no Save of its own", () => {
    const markup = paneMarkup(WITH_TEARDOWN);

    expect(markup).not.toContain(">Save</button>");
    expect(markup).not.toContain(">Revert</button>");
  });

  test("shows the settings it is given rather than a copy it took", () => {
    const markup = renderToStaticMarkup(
      <ProjectSettingsPane
        project={NO_SCRIPTS}
        settings={fakeSettings({
          automation: { sessionStart: { script: "make dev", timeoutSeconds: 30 } },
        })}
        profiles={PROFILES}
        availability={AVAILABLE}
        onChange={noop}
      />,
    );

    expect(editorValues(markup)).toEqual(["", "make dev", ""]);
  });
});

describe("worktree settings", () => {
  test("are offered for a repository", () => {
    expect(paneMarkup(NO_SCRIPTS)).toContain("Use a directory I choose");
  });

  test("are absent for a plain folder, which cannot have worktrees", () => {
    expect(paneMarkup(FOLDER)).not.toContain("Use a directory I choose");
  });

  test("a custom root shows its directory", () => {
    expect(paneMarkup(CUSTOM_ROOT)).toContain('value="/Users/me/trees"');
  });
});

describe("the project's default profile", () => {
  test("offers to fall back to the global default rather than to nothing", () => {
    expect(paneMarkup(NO_SCRIPTS)).toContain("Use the global default");
  });
});
