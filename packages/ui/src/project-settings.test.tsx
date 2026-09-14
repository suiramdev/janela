import { describe, expect, test } from "bun:test";

import type { AutomationCommand, AutomationEvent, LaunchProfile, Project } from "@janela/core";
import { absolutePath, newAutomationID } from "@janela/core";
import { renderToStaticMarkup } from "react-dom/server";

import { DEFAULT_AUTOMATION_TIMEOUT_SECONDS } from "./automation-editing.ts";
import { ProjectSettingsPane } from "./project-settings.tsx";
import {
  fakeProfile,
  fakeProject,
  fakeSettings,
  fakeShellProfile,
  reportedAvailable,
} from "./test-fakes.ts";

const noop = (): void => {};

const SHELL = fakeShellProfile();
const CLAUDE = fakeProfile({ name: "Claude Code" });
const PROFILES = [SHELL, CLAUDE];
const AVAILABLE = reportedAvailable(SHELL, CLAUDE);

function command(
  event: AutomationEvent,
  argv: readonly string[],
  overrides: Partial<AutomationCommand> = {},
): AutomationCommand {
  return {
    id: newAutomationID(),
    event,
    command: argv,
    isEnabled: true,
    timeoutSeconds: DEFAULT_AUTOMATION_TIMEOUT_SECONDS,
    ...overrides,
  };
}

const REPOSITORY = fakeProject();
const { git: _git, ...FOLDER } = fakeProject();
const CUSTOM_ROOT = fakeProject({
  settings: fakeSettings({
    worktreeRoot: { kind: "custom", directory: absolutePath("/Users/me/trees") },
  }),
});

/** One project value per scenario: a `{...project}` in a prop is a fresh object. */
function projectWith(automation: readonly AutomationCommand[]): Project {
  return { ...REPOSITORY, settings: fakeSettings({ automation }) };
}

const NO_COMMANDS = projectWith([]);
const DEV = command("sessionStart", ["pnpm", "dev"]);
const INSTALL = command("worktreeCreated", ["pnpm", "install"]);
const DOWN = command("sessionTeardown", ["docker", "compose", "down"]);
const DROPDB = command("sessionTeardown", ["dropdb", "scratch"]);

const WITH_DEV = projectWith([DEV]);
const WITH_TEARDOWN = projectWith([DOWN]);
const WITH_NON_BLOCKING = projectWith([DEV, INSTALL]);
const WITH_TWO_TEARDOWNS = projectWith([DEV, DOWN, DROPDB]);
const WITH_ZERO_TIMEOUT = projectWith([
  command("sessionTeardown", ["docker"], { timeoutSeconds: 0 }),
]);
const WITH_BLANK_ENABLED = projectWith([command("sessionStart", [""])]);
const WITH_BLANK_DISABLED = projectWith([command("sessionStart", [""], { isEnabled: false })]);
const WITH_DEV_DISABLED = projectWith([
  command("sessionStart", ["pnpm", "dev"], { isEnabled: false }),
]);

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

/** Switches reading as on: the forge switch is one too, so this is counted. */
function checkedCount(markup: string): number {
  return [...markup.matchAll(/aria-checked="true"/g)].length;
}

describe("automation authoring", () => {
  test("offers all three events, and only three", () => {
    const markup = paneMarkup(NO_COMMANDS);
    expect(markup).toContain("When a worktree is created");
    expect(markup).toContain("When a session is first opened");
    expect(markup).toContain("When a session is deleted");
    expect([...markup.matchAll(/Add Command/g)]).toHaveLength(3);
  });

  test("says plainly when an event runs nothing", () => {
    expect([...paneMarkup(NO_COMMANDS).matchAll(/Nothing runs\./g)]).toHaveLength(3);
  });

  test("shows a command's argv one field per element", () => {
    const markup = paneMarkup(WITH_DEV);
    expect(markup).toContain('value="pnpm"');
    expect(markup).toContain('value="dev"');
    expect(markup).toContain("Executable");
    expect(markup).toContain("Argument 1");
  });

  test("records the security property in the copy the user reads", () => {
    // The one irreversible property: these never come from the repository.
    expect(paneMarkup(NO_COMMANDS)).toContain("never read from the repository");
  });

  test("promises the command runs in a terminal the user can watch", () => {
    expect(paneMarkup(NO_COMMANDS)).toContain("watch and interrupt");
  });
});

describe("the teardown timeout", () => {
  test("is shown for the one blocking event", () => {
    expect(paneMarkup(WITH_TEARDOWN)).toContain("Deletion waits this long");
  });

  test("is not shown for events that block nothing", () => {
    // Showing them a timeout would imply a guarantee that does not exist.
    expect(paneMarkup(WITH_NON_BLOCKING)).not.toContain("Deletion waits this long");
  });

  test("appears exactly once per teardown command", () => {
    const markup = paneMarkup(WITH_TWO_TEARDOWNS);
    expect([...markup.matchAll(/Deletion waits this long/g)]).toHaveLength(2);
  });

  test("a zero timeout is named as a violation", () => {
    // The pane names it; the screen's bar is what refuses to save it, and is
    // tested there.
    expect(paneMarkup(WITH_ZERO_TIMEOUT)).toContain(
      "A teardown timeout must be at least one second.",
    );
  });
});

describe("the commit model", () => {
  test("the pane carries no Save of its own", () => {
    // One bar commits every tab. A second Save here would be two different
    // promises about the same keystrokes.
    const markup = paneMarkup(WITH_TWO_TEARDOWNS);
    expect(markup).not.toContain(">Save</button>");
    expect(markup).not.toContain(">Revert</button>");
  });

  test("shows the settings it is given rather than a copy it took", () => {
    // The draft lives above the pane, so an edit made on another pane — or a
    // Revert — has to arrive through this prop and be rendered.
    const markup = renderToStaticMarkup(
      <ProjectSettingsPane
        project={NO_COMMANDS}
        settings={fakeSettings({ automation: [DEV], isForgeEnabled: false })}
        profiles={PROFILES}
        availability={AVAILABLE}
        onChange={noop}
      />,
    );

    expect(markup).toContain('value="pnpm"');
    expect(checkedCount(markup)).toBe(1);
  });
});

describe("enabled state", () => {
  test("an enabled command reads as checked, a disabled one does not", () => {
    // Counted, not searched: with the forge switch on, a bare "contains checked"
    // would pass whatever the command's state was.
    expect(checkedCount(paneMarkup(WITH_DEV))).toBe(2);
    expect(checkedCount(paneMarkup(WITH_DEV_DISABLED))).toBe(1);
  });

  test("an enabled command with no executable is named as a violation", () => {
    const markup = paneMarkup(WITH_BLANK_ENABLED);
    expect(markup).toContain("An enabled command needs an executable.");
  });

  test("a disabled blank command is not a violation", () => {
    // Disabled means it does not run, so an empty executable is not yet a problem.
    expect(paneMarkup(WITH_BLANK_DISABLED)).not.toContain(
      "An enabled command needs an executable.",
    );
  });
});

describe("worktree settings", () => {
  test("are offered for a repository", () => {
    expect(paneMarkup(NO_COMMANDS)).toContain("Use a directory I choose");
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
    expect(paneMarkup(NO_COMMANDS)).toContain("Use the global default");
  });
});
