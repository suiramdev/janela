import type { LaunchProfile } from "@janela/core";
import { newLaunchProfileID } from "@janela/core";

export function profileViolations(profile: Omit<LaunchProfile, "id">): readonly string[] {
  const violations: string[] = [];

  if (profile.name.trim().length === 0) violations.push("A profile needs a name.");

  const executable = profile.command[0];

  if (executable !== undefined && executable.trim().length === 0) {
    violations.push("The first argument is the executable, and cannot be blank.");
  }

  return violations;
}

export function canRemoveProfile(profile: LaunchProfile): boolean {
  return !profile.isBuiltIn;
}

export function canRenameProfile(profile: LaunchProfile): boolean {
  return !profile.isBuiltIn;
}

export function duplicatedProfile(profile: LaunchProfile): LaunchProfile {
  return {
    ...profile,
    id: newLaunchProfileID(),
    name: `${profile.name} Copy`,
    isBuiltIn: false,
  };
}

export function profileTitle(profile: Pick<LaunchProfile, "name">): string {
  return profile.name.trim().length === 0 ? "New profile" : profile.name;
}
