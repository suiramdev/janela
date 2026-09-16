import type { LaunchProfile } from "@janela/core";
import { newLaunchProfileID } from "@janela/core";

import { FALLBACK_ICON_NAME } from "../config/index.ts";

export interface ArgumentDraft {
  readonly id: string;
  readonly value: string;
}

export interface VariableDraft {
  readonly id: string;
  readonly key: string;
  readonly value: string;
}

export interface ProfileDraft {
  readonly profile: LaunchProfile;
  readonly argumentDrafts: readonly ArgumentDraft[];
  readonly variableDrafts: readonly VariableDraft[];
}

export function argumentDrafts(argv: readonly string[]): readonly ArgumentDraft[] {
  return argv.map((value) => ({ id: crypto.randomUUID(), value }));
}

export function argvOf(drafts: readonly ArgumentDraft[]): readonly string[] {
  return drafts.map((draft) => draft.value);
}

export function argumentsAppending(drafts: readonly ArgumentDraft[]): readonly ArgumentDraft[] {
  return [...drafts, { id: crypto.randomUUID(), value: "" }];
}

export function variableDrafts(
  environment: Readonly<Record<string, string>>,
): readonly VariableDraft[] {
  return Object.keys(environment)
    .toSorted()
    .map((key) => ({ id: crypto.randomUUID(), key, value: environment[key] ?? "" }));
}

export function environmentOf(drafts: readonly VariableDraft[]): Readonly<Record<string, string>> {
  const entries: [string, string][] = [];

  for (const draft of drafts) {
    const key = draft.key.trim();

    if (key.length === 0) continue;

    entries.push([key, draft.value]);
  }

  return Object.fromEntries(entries);
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

export function profileOf(draft: ProfileDraft): LaunchProfile {
  return {
    ...draft.profile,
    command: argvOf(draft.argumentDrafts),
    environment: environmentOf(draft.variableDrafts),
  };
}

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
