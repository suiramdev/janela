import { describe, expect, test } from "bun:test";

import type { LaunchProfile, LaunchProfileAvailability } from "@janela/core";
import { renderToStaticMarkup } from "react-dom/server";

import type { ProfileDraft } from "./profile-editing.ts";
import { profileDraft } from "./profile-editing.ts";
import type { SettingsDraft } from "./settings-draft.ts";
import { EMPTY_SETTINGS_DRAFT, withDraftProfile, withoutDraftProfile } from "./settings-draft.ts";
import { ProfileEditor, SettingsProfiles } from "./settings-profiles.tsx";
import { fakeProfile, fakeShellProfile, reportedAvailable } from "./test-fakes.ts";

const noop = (): void => {};

const SHELL = fakeShellProfile();
const AGENT = fakeProfile({ name: "Claude Code", isAgent: true });
const MISSING = fakeProfile({ name: "OpenCode", command: ["opencode"] });

const SHELL_ONLY = [SHELL];
const SHELL_AND_MISSING = [SHELL, MISSING];
const SHELL_AND_AGENT = [SHELL, AGENT];

const SHELL_AVAILABLE = reportedAvailable(SHELL);
const SHELL_AND_AGENT_AVAILABLE = reportedAvailable(SHELL, AGENT);

const BUILT_IN_DRAFT = profileDraft(fakeProfile({ name: "Codex", isBuiltIn: true }));
const USER_DRAFT = profileDraft(fakeProfile({ isBuiltIn: false }));
const SHELL_ARGV_DRAFT = profileDraft(fakeProfile({ command: ["zsh", "-lc", "claude"] }));
const NAMELESS_DRAFT = profileDraft(fakeProfile({ name: "" }));
const MISSING_DRAFT = profileDraft(fakeProfile({ command: ["opencode"] }));

function editorMarkup(draft: ProfileDraft, isAvailable = true, isStored = true): string {
  return renderToStaticMarkup(
    <ProfileEditor
      draft={draft}
      isAvailable={isAvailable}
      isStored={isStored}
      onChange={noop}
      onRemove={noop}
      onDuplicate={noop}
    />,
  );
}

function listMarkup(
  profiles: readonly LaunchProfile[],
  availability: LaunchProfileAvailability,
  draft: SettingsDraft = EMPTY_SETTINGS_DRAFT,
): string {
  return renderToStaticMarkup(
    <SettingsProfiles
      profiles={profiles}
      availability={availability}
      draft={draft}
      onChangeDraft={noop}
    />,
  );
}

describe("the profile list", () => {
  test("shows an unavailable profile, and says why it is hidden elsewhere", () => {
    // The counterpart to the picker's rule. Hiding exists so nobody is offered a
    // profile that cannot start; this is the one surface where it can be fixed,
    // so here it is visible and explained.
    const markup = listMarkup(SHELL_AND_MISSING, SHELL_AVAILABLE);

    expect(markup).toContain("OpenCode");
    expect(markup).toContain("Not on your PATH");
    expect(markup).toContain("hidden from the picker");
  });

  test("an available profile carries no such note", () => {
    expect(listMarkup(SHELL_ONLY, SHELL_AVAILABLE)).not.toContain("Not on your PATH");
  });

  test("labels built-ins and agents without reordering them", () => {
    const markup = listMarkup(SHELL_AND_AGENT, SHELL_AND_AGENT_AVAILABLE);

    expect(markup).toContain("Built-in");
    expect(markup).toContain("Agent");
    expect(markup.indexOf("Shell")).toBeLessThan(markup.indexOf("Claude Code"));
  });

  test("opens with no editor, so nothing is being edited by accident", () => {
    expect(listMarkup(SHELL_ONLY, SHELL_AVAILABLE)).not.toContain("Add Argument");
  });

  test("shows a staged rename, a staged addition and no staged removal", () => {
    // The list is the mirror's read through the draft. Without that, a profile
    // renamed here would keep its old name in the row that renamed it.
    const renamed = withDraftProfile(
      EMPTY_SETTINGS_DRAFT,
      profileDraft({ ...AGENT, name: "Sonnet" }),
    );
    const added = withDraftProfile(renamed, profileDraft(fakeProfile({ name: "Codex" })));
    const markup = listMarkup(SHELL_AND_AGENT, SHELL_AND_AGENT_AVAILABLE, added);

    expect(markup).toContain("Sonnet");
    expect(markup).not.toContain("Claude Code");
    expect(markup).toContain("Codex");

    const removed = withoutDraftProfile(EMPTY_SETTINGS_DRAFT, AGENT.id, SHELL_AND_AGENT);
    expect(listMarkup(SHELL_AND_AGENT, SHELL_AND_AGENT_AVAILABLE, removed)).not.toContain(
      "Claude Code",
    );
  });

  test("a profile with no name yet still has a row you can read", () => {
    // A blank row reads as a list that failed to render. The editor's heading
    // and the row say the same placeholder.
    const draft = withDraftProfile(EMPTY_SETTINGS_DRAFT, profileDraft(fakeProfile({ name: "" })));
    expect(listMarkup(SHELL_ONLY, SHELL_AVAILABLE, draft)).toContain("New profile");
  });
});

describe("the editor", () => {
  test("offers one field per argv element, and no command-line box", () => {
    // A single box would have to split a string into argv, which has no correct
    // implementation. The label set is the evidence there is no such field.
    const markup = editorMarkup(SHELL_ARGV_DRAFT);

    expect(markup).toContain("Executable");
    expect(markup).toContain("Argument 1");
    expect(markup).toContain("Argument 2");
    expect(markup).toContain('value="zsh"');
    expect(markup).toContain('value="-lc"');
    expect(markup).toContain('value="claude"');
  });

  test("a built-in cannot be deleted and cannot be renamed", () => {
    const markup = editorMarkup(BUILT_IN_DRAFT);

    expect(markup).not.toContain(">Delete<");
    // The hint is the whole of the read-only story the user gets: a field they
    // cannot type in has to say why, so asserting the copy asserts the rule.
    expect(markup).toContain("Duplicate it to make a copy you can rename");
    // Duplicating is the supported way to get a copy you own.
    expect(markup).toContain(">Duplicate<");
  });

  test("a user profile can be deleted and renamed", () => {
    const markup = editorMarkup(USER_DRAFT);

    expect(markup).toContain(">Delete<");
    expect(markup).not.toContain("Duplicate it to make a copy you can rename");
  });

  test("says plainly that the agent switch changes nothing", () => {
    const markup = editorMarkup(USER_DRAFT);
    expect(markup).toContain("Show as an agent");
    expect(markup).toContain("changes no behaviour");
  });

  test("an unavailable profile explains what to do about it", () => {
    const markup = editorMarkup(MISSING_DRAFT, false);
    expect(markup).toContain("is not on your PATH");
    expect(markup).toContain("absolute path");
  });

  test("names a blank name as a violation, and leaves refusing to the bar", () => {
    // The editor has no Save to disable: the screen's bar is what refuses, and
    // `draftViolations` is what tells it to.
    const markup = editorMarkup(NAMELESS_DRAFT);
    expect(markup).toContain("A profile needs a name.");
    expect(markup).not.toContain(">Save</button>");
  });

  test("a valid profile is named as nothing wrong", () => {
    expect(editorMarkup(USER_DRAFT)).not.toContain("A profile needs a name.");
  });

  test("an unsaved profile is discarded rather than deleted", () => {
    // Nothing to delete: the daemon has never heard of it. The label says which
    // of the two the button is about to do.
    expect(editorMarkup(USER_DRAFT, true, false)).toContain(">Discard</button>");
    expect(editorMarkup(USER_DRAFT, true, false)).not.toContain(">Delete</button>");
  });

  test("offers a closed set of icons rather than a text field", () => {
    const markup = editorMarkup(USER_DRAFT);
    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain("sparkles");
    expect(markup).toContain("terminal");
  });
});
