import type { LaunchProfileID } from "./identifiers.ts";

export interface LaunchProfile {
  readonly id: LaunchProfileID;
  name: string;
  iconName: string;
  command: readonly string[];
  environment: Readonly<Record<string, string>>;
  isAgent: boolean;
  isBuiltIn: boolean;
}

export type LaunchProfileAvailability = Readonly<Record<LaunchProfileID, boolean>>;

export const BUILT_IN_PROFILES: readonly Omit<LaunchProfile, "id">[] = [
  {
    name: "Shell",
    iconName: "terminal",
    command: [],
    environment: {},
    isAgent: false,
    isBuiltIn: true,
  },
  {
    name: "Claude Code",
    iconName: "sparkles",
    command: ["claude"],
    environment: {},
    isAgent: true,
    isBuiltIn: true,
  },
  {
    name: "Codex",
    iconName: "code",
    command: ["codex"],
    environment: {},
    isAgent: true,
    isBuiltIn: true,
  },
  {
    name: "OpenCode",
    iconName: "box",
    command: ["opencode"],
    environment: {},
    isAgent: true,
    isBuiltIn: true,
  },
];

export function usesLoginShell(profile: Pick<LaunchProfile, "command">): boolean {
  return profile.command[0] === undefined;
}

export function needsPathLookup(executable: string): boolean {
  return !executable.includes("/");
}

export function profileAvailability(
  profiles: readonly LaunchProfile[],
  isOnPath: (executable: string) => boolean,
): LaunchProfileAvailability {
  return Object.fromEntries(
    profiles.map((profile) => {
      const executable = profile.command[0];

      return [
        profile.id,
        executable === undefined || !needsPathLookup(executable) || isOnPath(executable),
      ] as const;
    }),
  );
}

export function isProfileAvailable(
  profile: LaunchProfile,
  availability: LaunchProfileAvailability,
): boolean {
  const executable = profile.command[0];

  if (executable === undefined || !needsPathLookup(executable)) return true;

  return availability[profile.id] ?? false;
}

export function availableProfiles(
  profiles: readonly LaunchProfile[],
  availability: LaunchProfileAvailability,
): readonly LaunchProfile[] {
  return profiles.filter((profile) => isProfileAvailable(profile, availability));
}
