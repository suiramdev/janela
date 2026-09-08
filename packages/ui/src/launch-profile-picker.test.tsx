import { describe, expect, test } from "bun:test";

import type { LaunchProfile, LaunchProfileAvailability } from "@janela/core";
import { newLaunchProfileID } from "@janela/core";
import { renderToStaticMarkup } from "react-dom/server";

import {
  LaunchProfilePicker,
  movedSelection,
  preselectedProfileID,
  profileSubtitle,
} from "./launch-profile-picker.tsx";
import { fakeProfile, fakeShellProfile, reportedAvailable } from "./test-fakes.ts";

const noop = (): void => {};

// Module-level so they are not props "created in the same scope", which the
// react-perf rules refuse — the same rule the components themselves obey.
const SHELL = fakeShellProfile();
const CLAUDE = fakeProfile({ name: "Claude Code" });
const MISSING = fakeProfile({ name: "OpenCode", command: ["opencode"] });
const SERVER = fakeProfile({ name: "Dev Server", command: ["pnpm"], isAgent: false });

const SHELL_ONLY = [SHELL];
const SHELL_AND_CLAUDE = [SHELL, CLAUDE];
const SHELL_AND_MISSING = [SHELL, MISSING];
const WITH_MISSING = [SHELL, CLAUDE, MISSING];
const AGENT_AND_PLAIN = [SHELL, CLAUDE, SERVER];
const NO_PROFILES: readonly LaunchProfile[] = [];

const SHELL_AVAILABLE = reportedAvailable(SHELL);
const CLAUDE_AVAILABLE = reportedAvailable(CLAUDE);
const BOTH_AVAILABLE = reportedAvailable(SHELL, CLAUDE);
const ALL_AVAILABLE = reportedAvailable(SHELL, CLAUDE, SERVER);
const NOTHING_REPORTED: LaunchProfileAvailability = {};

describe("preselectedProfileID", () => {
  test("the project's default wins", () => {
    expect(preselectedProfileID(SHELL_AND_CLAUDE, CLAUDE.id, SHELL.id)).toBe(CLAUDE.id);
  });

  test("the global default is used when the project has expressed no view", () => {
    expect(preselectedProfileID(SHELL_AND_CLAUDE, undefined, CLAUDE.id)).toBe(CLAUDE.id);
  });

  test("a project default that is not pickable falls through to the global one", () => {
    // A project can default to a profile the user has since uninstalled.
    // Preselecting it would highlight a row that is not on screen, so ⌘T-Return
    // would start nothing at all.
    expect(preselectedProfileID(SHELL_ONLY, newLaunchProfileID(), SHELL.id)).toBe(SHELL.id);
  });

  test("neither default pickable falls through to the first row", () => {
    expect(preselectedProfileID(SHELL_ONLY, newLaunchProfileID(), newLaunchProfileID())).toBe(
      SHELL.id,
    );
  });

  test("nothing pickable preselects nothing", () => {
    expect(preselectedProfileID(NO_PROFILES, newLaunchProfileID(), undefined)).toBeUndefined();
  });
});

describe("movedSelection", () => {
  test("moves down and up through the list", () => {
    expect(movedSelection(AGENT_AND_PLAIN, SHELL.id, 1)).toBe(CLAUDE.id);
    expect(movedSelection(AGENT_AND_PLAIN, CLAUDE.id, -1)).toBe(SHELL.id);
  });

  test("wraps at both ends, because a menu of four should not need aiming", () => {
    expect(movedSelection(SHELL_AND_CLAUDE, CLAUDE.id, 1)).toBe(SHELL.id);
    expect(movedSelection(SHELL_AND_CLAUDE, SHELL.id, -1)).toBe(CLAUDE.id);
  });

  test("a selection that has vanished starts again from the top", () => {
    expect(movedSelection(SHELL_ONLY, newLaunchProfileID(), 1)).toBe(SHELL.id);
  });

  test("an empty list has nowhere to go", () => {
    expect(movedSelection(NO_PROFILES, undefined, 1)).toBeUndefined();
  });
});

describe("profileSubtitle", () => {
  test("names the login shell rather than showing an empty command", () => {
    expect(profileSubtitle(SHELL)).toBe("Your login shell");
  });

  test("shows the argv as it will run", () => {
    expect(profileSubtitle(fakeProfile({ command: ["claude", "--model", "opus"] }))).toBe(
      "claude --model opus",
    );
  });
});

describe("the picker", () => {
  test("lists available profiles and hides the rest entirely", () => {
    const markup = renderToStaticMarkup(
      <LaunchProfilePicker
        profiles={WITH_MISSING}
        availability={CLAUDE_AVAILABLE}
        onPick={noop}
        onCancel={noop}
      />,
    );

    expect(markup).toContain("Shell");
    expect(markup).toContain("Claude Code");
    // Not greyed out, not annotated — absent. A profile that cannot start is
    // never offered, so there is nothing to explain in a menu.
    expect(markup).not.toContain("OpenCode");
    expect(markup).not.toContain("not installed");
    expect(markup).not.toContain("PATH");
  });

  test("preselects the project's default", () => {
    const markup = renderToStaticMarkup(
      <LaunchProfilePicker
        profiles={SHELL_AND_CLAUDE}
        availability={BOTH_AVAILABLE}
        projectDefaultID={CLAUDE.id}
        onPick={noop}
        onCancel={noop}
      />,
    );

    expect(markup).toContain(`aria-activedescendant="${CLAUDE.id}"`);
    expect(markup).toContain(`id="${CLAUDE.id}" role="option" aria-selected="true"`);
    expect(markup).toContain(`id="${SHELL.id}" role="option" aria-selected="false"`);
  });

  test("preselects the first row when nothing has a default", () => {
    const markup = renderToStaticMarkup(
      <LaunchProfilePicker
        profiles={SHELL_AND_CLAUDE}
        availability={BOTH_AVAILABLE}
        onPick={noop}
        onCancel={noop}
      />,
    );
    expect(markup).toContain(`aria-activedescendant="${SHELL.id}"`);
  });

  test("a project default that is unavailable does not become the highlight", () => {
    const markup = renderToStaticMarkup(
      <LaunchProfilePicker
        profiles={SHELL_AND_MISSING}
        availability={SHELL_AVAILABLE}
        projectDefaultID={MISSING.id}
        onPick={noop}
        onCancel={noop}
      />,
    );
    expect(markup).toContain(`aria-activedescendant="${SHELL.id}"`);
  });

  test("announces itself as a list of options", () => {
    const markup = renderToStaticMarkup(
      <LaunchProfilePicker
        profiles={SHELL_ONLY}
        availability={SHELL_AVAILABLE}
        onPick={noop}
        onCancel={noop}
      />,
    );
    expect(markup).toContain('role="listbox"');
    expect(markup).toContain('aria-label="Launch profile"');
  });

  test("says so plainly when there is nothing to offer", () => {
    const markup = renderToStaticMarkup(
      <LaunchProfilePicker
        profiles={NO_PROFILES}
        availability={NOTHING_REPORTED}
        onPick={noop}
        onCancel={noop}
      />,
    );
    expect(markup).toContain("No launch profiles are available");
  });

  test("nothing is offered while availability is still unreported", () => {
    // Hidden beats optimistic: before the daemon has said anything, a bare
    // command name is not offered. Only the login shell survives, by rule.
    const markup = renderToStaticMarkup(
      <LaunchProfilePicker
        profiles={SHELL_AND_CLAUDE}
        availability={NOTHING_REPORTED}
        onPick={noop}
        onCancel={noop}
      />,
    );
    expect(markup).toContain("Shell");
    expect(markup).not.toContain("Claude Code");
  });

  test("an agent profile carries no ordering or section of its own", () => {
    // `isAgent` is presentational. If it ever earns a heading or a position, the
    // app has started modelling somebody else's tool.
    const markup = renderToStaticMarkup(
      <LaunchProfilePicker
        profiles={AGENT_AND_PLAIN}
        availability={ALL_AVAILABLE}
        onPick={noop}
        onCancel={noop}
      />,
    );

    expect(markup.indexOf("Shell")).toBeLessThan(markup.indexOf("Claude Code"));
    expect(markup.indexOf("Claude Code")).toBeLessThan(markup.indexOf("Dev Server"));
  });
});
