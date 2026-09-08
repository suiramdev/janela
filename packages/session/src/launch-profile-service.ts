import type { LaunchProfile, LaunchProfileID } from "@janela/core";
import type { LaunchProfileRepository } from "@janela/db";
import type { Logger } from "@janela/support";
import { processRunner, type ProcessRunning } from "@janela/support/process";

import { BuiltInProfileProtected, UnknownLaunchProfile } from "./errors.ts";
import type { ShellEnvironment } from "./shell-environment.ts";
import { silentLogger } from "./silent-logger.ts";

/**
 * The launch profiles, and whether this machine can actually run them.
 *
 * Separate from `SessionService` because it answers a different question: that one
 * owns "what is the user working on", this one owns "what can be started". It
 * lives in the daemon for the same reason everything else here does — a profile's
 * availability depends on the captured login-shell `PATH`, which only the daemon
 * has (see `shell-environment.ts`).
 *
 * A profile is *not* an integration. We resolve its executable and start it; we do
 * not model the tool. See docs/product.md § Non-goals.
 */
export interface LaunchProfileService {
  /** Every profile, built-in and user-authored, in the repository's order. */
  readonly profiles: readonly LaunchProfile[];

  /**
   * Whether each profile's executable was found. Keyed by id and separate from
   * the profile itself: it is a fact about this machine now, not something the
   * user authored, and installing the tool must not require editing the profile.
   */
  readonly availability: Readonly<Record<LaunchProfileID, boolean>>;

  /** Seeds the built-ins, reads them all, and probes `PATH`. Called at startup. */
  load(): Promise<void>;

  /**
   * Upsert, keyed by the profile's own id.
   *
   * A built-in may be edited — that is what the settings surface offers — and
   * stays a built-in; anything the store has not seen becomes a user profile.
   * `isBuiltIn` on the argument is ignored either way: it describes where a
   * profile came from, and a caller able to set it could make its own profile
   * undeletable or a shipped one removable.
   */
  save(profile: LaunchProfile): Promise<LaunchProfile>;

  /**
   * @throws {BuiltInProfileProtected} for a built-in.
   * @throws {UnknownLaunchProfile} when it is already gone.
   */
  remove(id: LaunchProfileID): Promise<void>;
}

export interface LaunchProfileServiceDependencies {
  readonly repository: LaunchProfileRepository;
  /** For the `PATH` a profile's executable is resolved against. */
  readonly shell: ShellEnvironment;
  /** The `which` seam. Production passes nothing. */
  readonly processes?: ProcessRunning;
  readonly log?: Logger;
}

export function createLaunchProfileService(
  dependencies: LaunchProfileServiceDependencies,
): LaunchProfileService {
  return new StoredLaunchProfileService(dependencies);
}

const FALLBACK_PATH = "/usr/bin:/bin";

class StoredLaunchProfileService implements LaunchProfileService {
  private readonly deps: LaunchProfileServiceDependencies;
  private readonly log: Logger;
  private readonly processes: ProcessRunning;
  private known: LaunchProfile[] = [];
  private probed: Record<LaunchProfileID, boolean> = {};

  constructor(deps: LaunchProfileServiceDependencies) {
    this.deps = deps;
    this.log = deps.log ?? silentLogger;
    this.processes = deps.processes ?? processRunner();
  }

  get profiles(): readonly LaunchProfile[] {
    return this.known;
  }

  get availability(): Readonly<Record<LaunchProfileID, boolean>> {
    return this.probed;
  }

  async load(): Promise<void> {
    await this.deps.repository.seedBuiltIns();
    this.known = [...(await this.deps.repository.all())];
    this.probed = {};
    // Sequential on purpose: `which` is a subprocess, and a user with thirty
    // profiles should not open thirty shells at once during daemon startup.
    for (const profile of this.known) {
      // oxlint-disable-next-line no-await-in-loop
      this.probed[profile.id] = await this.isAvailable(profile);
    }
    this.log.debug("launch profiles loaded", {
      count: this.known.length,
      available: Object.values(this.probed).filter(Boolean).length,
    });
  }

  async save(profile: LaunchProfile): Promise<LaunchProfile> {
    const existing = this.known.find((held) => held.id === profile.id);

    const stored: LaunchProfile = {
      id: profile.id,
      name: profile.name,
      iconName: profile.iconName,
      // Copied, not aliased: the caller's arrays and records are its own, and a
      // client's object graph has no business being the daemon's state.
      command: [...profile.command],
      environment: { ...profile.environment },
      isAgent: profile.isAgent,
      // Ours, not the caller's: editing a built-in keeps it built-in, and nothing
      // sent from outside can mint one.
      isBuiltIn: existing?.isBuiltIn ?? false,
    };

    await this.deps.repository.save(stored);
    const index = this.known.findIndex((held) => held.id === stored.id);
    if (index === -1) this.known.push(stored);
    else this.known[index] = stored;
    this.probed[stored.id] = await this.isAvailable(stored);
    return stored;
  }

  async remove(id: LaunchProfileID): Promise<void> {
    const existing = this.known.find((held) => held.id === id);
    if (existing === undefined) throw new UnknownLaunchProfile(id);
    if (existing.isBuiltIn) throw new BuiltInProfileProtected(id);

    await this.deps.repository.remove(id);
    this.known = this.known.filter((held) => held.id !== id);
    // A record, not a map: `delete` on the object we hand out would leave a
    // mirror that merged it holding a stale `true`.
    const { [id]: _removed, ...rest } = this.probed;
    this.probed = rest;
  }

  /**
   * Whether the profile's executable is on the captured `PATH`.
   *
   * `which` answers for a path-ish name too — it checks that it points at
   * something runnable — which is what makes "hidden rather than shown broken"
   * true for a profile naming `/opt/homebrew/bin/claude` that a `brew uninstall`
   * took away.
   */
  private async isAvailable(profile: LaunchProfile): Promise<boolean> {
    const first = profile.command[0];
    // No argv is the login shell, which exists by construction.
    if (first === undefined) return true;

    const path = profile.environment["PATH"] ?? this.deps.shell.resolved["PATH"] ?? FALLBACK_PATH;
    try {
      return (await this.processes.which(first, path)) !== undefined;
    } catch {
      // A `which` that cannot run tells us nothing about the tool. Reporting
      // "unavailable" would hide a profile that works.
      this.log.warning("launch profile probe failed", { profile: profile.id });
      return true;
    }
  }
}
