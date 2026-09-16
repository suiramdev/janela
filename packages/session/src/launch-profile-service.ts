import type { LaunchProfile, LaunchProfileID } from "@janela/core";
import type { LaunchProfileRepository } from "@janela/db";
import type { Logger } from "@janela/support";
import { processRunner, type ProcessRunning } from "@janela/support/process";
import { Effect } from "effect";

import { BuiltInProfileProtected, UnknownLaunchProfile } from "./errors.ts";
import type { ShellEnvironment } from "./shell-environment.ts";
import { silentLogger } from "./silent-logger.ts";

export interface LaunchProfileService {
  readonly profiles: readonly LaunchProfile[];

  readonly availability: Readonly<Record<LaunchProfileID, boolean>>;

  load(): Promise<void>;

  save(profile: LaunchProfile): Promise<LaunchProfile>;

  remove(id: LaunchProfileID): Promise<void>;
}

export interface LaunchProfileServiceDependencies {
  readonly repository: LaunchProfileRepository;
  readonly shell: ShellEnvironment;
  readonly processes?: ProcessRunning;
  readonly log?: Logger;
}

const FALLBACK_PATH = "/usr/bin:/bin";

export function createLaunchProfileService(
  dependencies: LaunchProfileServiceDependencies,
): LaunchProfileService {
  return new StoredLaunchProfileService(dependencies);
}

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
      command: [...profile.command],
      environment: { ...profile.environment },
      isAgent: profile.isAgent,
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

    const { [id]: _forgotten, ...rest } = this.probed;
    this.probed = rest;
  }

  private isAvailable(profile: LaunchProfile): Promise<boolean> {
    const first = profile.command[0];

    if (first === undefined) return Promise.resolve(true);

    const path = profile.environment["PATH"] ?? this.deps.shell.resolved["PATH"] ?? FALLBACK_PATH;

    return Effect.runPromise(
      Effect.tryPromise({
        try: () => this.processes.which(first, path),
        catch: (cause: unknown) => cause,
      }).pipe(
        Effect.match({
          onFailure: () => {
            this.log.warning("launch profile probe failed", { profile: profile.id });

            return true;
          },
          onSuccess: (executable) => executable !== undefined,
        }),
      ),
    );
  }
}
