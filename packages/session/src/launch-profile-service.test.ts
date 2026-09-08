import { describe, expect, test } from "bun:test";

import type { LaunchProfile } from "@janela/core";
import { BUILT_IN_PROFILES, newLaunchProfileID } from "@janela/core";
import { temporaryDatabase } from "@janela/db";

import { BuiltInProfileProtected, UnknownLaunchProfile } from "./errors.ts";
import type { LaunchProfileService } from "./launch-profile-service.ts";
import { createLaunchProfileService } from "./launch-profile-service.ts";
import type { ShellEnvironment } from "./shell-environment.ts";
import { silentLogger } from "./silent-logger.ts";
import { scriptedProcesses } from "./test-fakes.ts";

const shell: ShellEnvironment = {
  loginShell: "/opt/homebrew/bin/fish",
  resolved: { PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/Users/x" },
  loginShellArguments: () => ["-fish"],
};

function profile(overrides: Partial<LaunchProfile> = {}): LaunchProfile {
  return {
    id: newLaunchProfileID(),
    name: "Claude Code",
    iconName: "sparkles",
    command: ["claude"],
    environment: {},
    isAgent: true,
    isBuiltIn: false,
    ...overrides,
  };
}

/** A service over a real database, because the store is half of what is tested. */
async function withService(
  options: {
    readonly which?: Readonly<Record<string, string>>;
  },
  work: (fixture: {
    readonly service: LaunchProfileService;
    readonly whichCalls: readonly { executable: string; path: string }[];
    readonly stored: () => Promise<readonly LaunchProfile[]>;
  }) => Promise<void>,
): Promise<void> {
  const database = await temporaryDatabase({ log: silentLogger });
  const scripted = scriptedProcesses(options.which === undefined ? {} : { which: options.which });
  const service = createLaunchProfileService({
    repository: database.launchProfiles,
    shell,
    processes: scripted.processes,
    log: silentLogger,
  });

  try {
    await work({
      service,
      whichCalls: scripted.whichCalls,
      stored: () => database.launchProfiles.all(),
    });
  } finally {
    await database.dispose();
  }
}

describe("loading", () => {
  test("seeds the built-ins and reports each one's availability", async () => {
    await withService({ which: { claude: "/opt/homebrew/bin/claude" } }, async (fixture) => {
      await fixture.service.load();

      expect(fixture.service.profiles).toHaveLength(BUILT_IN_PROFILES.length);
      const byName = new Map(fixture.service.profiles.map((held) => [held.name, held]));
      const shellProfile = byName.get("Shell");
      const claude = byName.get("Claude Code");
      const codex = byName.get("Codex");
      if (shellProfile === undefined || claude === undefined || codex === undefined) {
        throw new Error("the built-ins are missing");
      }

      // An empty argv is the login shell, which exists by construction and is
      // never probed.
      expect(fixture.service.availability[shellProfile.id]).toBe(true);
      expect(fixture.service.availability[claude.id]).toBe(true);
      // Nothing installed it, so it is reported unavailable rather than hidden
      // here: hiding is the client's decision, and this is the fact it needs.
      expect(fixture.service.availability[codex.id]).toBe(false);
      expect(fixture.whichCalls.map((call) => call.path)).not.toContain(undefined);
    });
  });

  test("probes against the captured login-shell PATH, not the daemon's own", async () => {
    await withService({}, async (fixture) => {
      await fixture.service.load();

      expect(fixture.whichCalls.every((call) => call.path === shell.resolved["PATH"])).toBe(true);
    });
  });
});

describe("saving", () => {
  test("stores a new profile, probes it, and hands back what was stored", async () => {
    await withService({ which: { aider: "/usr/local/bin/aider" } }, async (fixture) => {
      const value = profile({ name: "Aider", command: ["aider"] });
      const saved = await fixture.service.save(value);

      expect(saved).toEqual(value);
      expect(await fixture.stored()).toContainEqual(value);
      expect(fixture.service.profiles).toContainEqual(value);
    });
  });

  test("replaces a profile in place rather than adding a second one", async () => {
    await withService({ which: { claude: "/opt/homebrew/bin/claude" } }, async (fixture) => {
      const value = profile();
      await fixture.service.save(value);
      await fixture.service.save({ ...value, name: "Claude" });

      expect(fixture.service.profiles.filter((held) => held.id === value.id)).toHaveLength(1);
      expect(fixture.service.profiles[0]?.name).toBe("Claude");
    });
  });

  test("isBuiltIn is ours: a caller can neither mint one nor demote one", async () => {
    await withService({ which: { claude: "/opt/homebrew/bin/claude" } }, async (fixture) => {
      await fixture.service.load();
      const builtIn = fixture.service.profiles.find((held) => held.isBuiltIn);
      if (builtIn === undefined) throw new Error("no built-in was seeded");

      const claimed = await fixture.service.save(profile({ isBuiltIn: true }));
      expect(claimed.isBuiltIn).toBe(false);

      // Editing a built-in is offered; demoting it is not, because that is how a
      // shipped profile would become deletable and stop coming back.
      const edited = await fixture.service.save({ ...builtIn, name: "Mine", isBuiltIn: false });
      expect(edited.isBuiltIn).toBe(true);
      expect(edited.name).toBe("Mine");
    });
  });

  test("a saved profile's availability is re-probed, not carried over", async () => {
    await withService({ which: {} }, async (fixture) => {
      const value = profile({ command: ["nowhere"] });
      await fixture.service.save(value);
      expect(fixture.service.availability[value.id]).toBe(false);

      await fixture.service.save({ ...value, command: [] });
      expect(fixture.service.availability[value.id]).toBe(true);
    });
  });
});

describe("removing", () => {
  test("removes a user profile and forgets its availability", async () => {
    await withService({ which: { claude: "/opt/homebrew/bin/claude" } }, async (fixture) => {
      const value = profile();
      await fixture.service.save(value);
      await fixture.service.remove(value.id);

      expect(fixture.service.profiles).toEqual([]);
      expect(await fixture.stored()).toEqual([]);
      // Not left behind as a stale `true`: a client that merged the record would
      // keep offering a profile that no longer exists.
      expect(Object.hasOwn(fixture.service.availability, value.id)).toBe(false);
    });
  });

  test("refuses a built-in, which would come back on the next open anyway", async () => {
    await withService({ which: { claude: "/opt/homebrew/bin/claude" } }, async (fixture) => {
      await fixture.service.load();
      const builtIn = fixture.service.profiles.find((held) => held.isBuiltIn);
      if (builtIn === undefined) throw new Error("no built-in was seeded");

      await expect(fixture.service.remove(builtIn.id)).rejects.toBeInstanceOf(
        BuiltInProfileProtected,
      );
      expect(await fixture.stored()).toHaveLength(BUILT_IN_PROFILES.length);
    });
  });

  test("a profile that is already gone is an error a person can read", async () => {
    await withService({}, async (fixture) => {
      await expect(fixture.service.remove(newLaunchProfileID())).rejects.toBeInstanceOf(
        UnknownLaunchProfile,
      );
    });
  });
});
