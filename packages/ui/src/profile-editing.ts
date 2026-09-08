import type { LaunchProfile } from "@janela/core";
import { newLaunchProfileID } from "@janela/core";

import { FALLBACK_ICON_NAME } from "./profile-icons.tsx";

/**
 * Editing a launch profile, as pure functions over the value.
 *
 * ## The rule this whole file exists to protect
 *
 * **`command` is argv, and the editor edits it one element at a time.** There is
 * no field anywhere that takes `claude --model opus` and splits it, because the
 * moment one exists, Janela owns a quoting bug class it does not currently have:
 * `zsh -lc "echo 'a b'"` has no correct split, and every implementation picks a
 * different wrong one. A user who wants a shell types `zsh`, `-lc` and the script
 * into three fields, or writes one argument containing spaces and has chosen that.
 *
 * See AGENTS.md § Conventions and docs/decisions/0014-project-automation.md.
 *
 * ## Why the editor does not edit the domain value directly
 *
 * `command` is `readonly string[]` and `environment` is a `Record`, and neither
 * can represent what a user is halfway through typing: a blank variable name, two
 * rows that currently collide, or a duplicate argument. Both are also *positional*
 * in a way React needs identity for — remove argument 1 of three and an
 * index-keyed field list remounts arguments 2 and 3, which drops the caret out of
 * the field the user is typing in. So the editor holds drafts with ids, and the
 * conversions below are the only place the two representations meet.
 */

/** One argv element, with an identity that survives its neighbours moving. */
export interface ArgumentDraft {
  readonly id: string;
  readonly value: string;
}

/** One environment variable, mid-edit: the name may be blank or duplicated. */
export interface VariableDraft {
  readonly id: string;
  readonly key: string;
  readonly value: string;
}

/**
 * A profile as the editor holds it.
 *
 * `profile` carries the fields that need no draft representation; the two lists
 * replace `command` and `environment` until the user saves.
 */
export interface ProfileDraft {
  readonly profile: LaunchProfile;
  readonly argumentDrafts: readonly ArgumentDraft[];
  readonly variableDrafts: readonly VariableDraft[];
}

export function argumentDrafts(argv: readonly string[]): readonly ArgumentDraft[] {
  return argv.map((value) => ({ id: crypto.randomUUID(), value }));
}

/**
 * The argv the drafts describe.
 *
 * Values pass through **verbatim** — not trimmed, not filtered. A trailing empty
 * argument and an argument of two spaces are both things a program can be given,
 * and deciding they are mistakes would be us editing the user's command.
 */
export function argvOf(drafts: readonly ArgumentDraft[]): readonly string[] {
  return drafts.map((draft) => draft.value);
}

export function argumentsAppending(drafts: readonly ArgumentDraft[]): readonly ArgumentDraft[] {
  return [...drafts, { id: crypto.randomUUID(), value: "" }];
}

/**
 * Explodes the stored record into editable rows, sorted by name.
 *
 * Sorted so the editor does not reorder itself when a value is saved and read
 * back: object key order is insertion order, and a round trip through a JSON
 * column is not required to preserve it.
 */
export function variableDrafts(
  environment: Readonly<Record<string, string>>,
): readonly VariableDraft[] {
  return Object.keys(environment)
    .toSorted()
    .map((key) => ({ id: crypto.randomUUID(), key, value: environment[key] ?? "" }));
}

/**
 * Collapses editable rows back into the stored record.
 *
 * Blank names are dropped — that is a row the user has started and not named, not
 * a variable called "". A repeated name keeps the last row, matching what a
 * process sees when its environment array carries a duplicate.
 */
export function environmentOf(drafts: readonly VariableDraft[]): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const draft of drafts) {
    const key = draft.key.trim();
    if (key.length === 0) continue;
    environment[key] = draft.value;
  }
  return environment;
}

export function variablesAppending(drafts: readonly VariableDraft[]): readonly VariableDraft[] {
  return [...drafts, { id: crypto.randomUUID(), key: "", value: "" }];
}

export function profileDraft(profile: LaunchProfile): ProfileDraft {
  return {
    profile,
    argumentDrafts: argumentDrafts(profile.command),
    variableDrafts: variableDrafts(profile.environment),
  };
}

/** The value to save: the drafts collapsed back onto the profile. */
export function profileOf(draft: ProfileDraft): LaunchProfile {
  return {
    ...draft.profile,
    command: argvOf(draft.argumentDrafts),
    environment: environmentOf(draft.variableDrafts),
  };
}

/**
 * Why this profile cannot be saved yet, empty when it can.
 *
 * Deliberately short. A profile is a command Janela starts, so the only things we
 * can know are wrong are the ones that would make it unstartable or unnameable —
 * whether `claude` is a good idea is not ours to judge, and whether it is
 * *installed* is answered by availability, not by validation.
 */
export function profileViolations(profile: Omit<LaunchProfile, "id">): readonly string[] {
  const violations: string[] = [];
  if (profile.name.trim().length === 0) violations.push("A profile needs a name.");

  const executable = profile.command[0];
  if (executable !== undefined && executable.trim().length === 0) {
    // Note the asymmetry: a *later* blank argument is legal. `["zsh", "-lc", ""]`
    // passes an empty argument on purpose, and refusing it would be us deciding
    // what the user's program accepts.
    violations.push("The first argument is the executable, and cannot be blank.");
  }
  return violations;
}

/**
 * Whether the user may delete this profile.
 *
 * Built-ins are overridden by copying, never removed: `BUILT_IN_PROFILES` is
 * re-seeded on every open, so a deleted one would silently return and look like a
 * bug in deletion.
 */
export function canRemoveProfile(profile: LaunchProfile): boolean {
  return !profile.isBuiltIn;
}

/**
 * Whether the user may rename this profile.
 *
 * The same answer as deletion, for an unrelated reason worth stating separately —
 * these two rules coincide today and would not have to. Seeding matches built-ins
 * **by name**, because ids are minted at seed time and a hardcoded one would
 * collide with a user's own copy. So renaming "Codex" makes the next open insert a
 * fresh "Codex" beside it. Duplicating is the supported way to get a renamable
 * copy, and the editor says so rather than leaving it to be discovered.
 */
export function canRenameProfile(profile: LaunchProfile): boolean {
  return !profile.isBuiltIn;
}

/**
 * A copy the user owns.
 *
 * `isBuiltIn` drops to false — that is the entire point, and it is what makes the
 * copy renamable and removable. The id is minted rather than reused, because two
 * rows with one id is a lost profile.
 */
export function duplicatedProfile(profile: LaunchProfile): LaunchProfile {
  return {
    ...profile,
    id: newLaunchProfileID(),
    name: `${profile.name} Copy`,
    isBuiltIn: false,
  };
}

/**
 * A new, empty user profile.
 *
 * Starts with one blank argv element rather than none, so the editor shows an
 * executable field and `profileViolations` explains what is missing. Starting with
 * `[]` would present a valid profile — the login shell — that the user did not ask
 * for and would have to notice.
 */
export function blankProfile(): LaunchProfile {
  return {
    id: newLaunchProfileID(),
    name: "",
    iconName: FALLBACK_ICON_NAME,
    command: [""],
    environment: {},
    isAgent: false,
    isBuiltIn: false,
  };
}
