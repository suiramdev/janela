import type {
  ForgeItems,
  ForgeOverview,
  ForgeRepository,
  Project,
  ProjectID,
  Session,
  SessionForgeLink,
} from "@janela/core";
import { worktreeOf } from "@janela/core";
import type { ForgeServing } from "@janela/forge";
import type { GitWorktree, WorktreeServing } from "@janela/git";
import { Effect } from "effect";

import { repositoryPath, type ProjectService } from "./project-service.ts";
import type { SessionService } from "./session-service.ts";

export interface ForgeOverviewing {
  overview(): Promise<ForgeOverview>;
}

export interface ForgeOverviewDependencies {
  readonly projects: Pick<ProjectService, "projects">;
  readonly sessions: Pick<SessionService, "sessions">;
  readonly worktrees: Pick<WorktreeServing, "worktrees">;
  readonly forge: ForgeServing;
}

interface ProjectReading {
  readonly project: Project;
  readonly worktrees: readonly GitWorktree[];
  readonly listed: ForgeItems | undefined;
}

export const FORGE_READ_CONCURRENCY = 4;

export function createForgeOverview(deps: ForgeOverviewDependencies): ForgeOverviewing {
  const readProject = async (project: Project): Promise<ProjectReading> => {
    const [worktrees, listed] = await Promise.all([
      project.git === undefined
        ? Promise.resolve([])
        : Effect.runPromise(
            Effect.tryPromise(() => deps.worktrees.worktrees(project.directory)).pipe(
              Effect.orElseSucceed((): readonly GitWorktree[] => []),
            ),
          ),
      deps.forge.items(project),
    ]);

    return { project, worktrees, listed };
  };

  const linkSession = async (
    session: Session,
    readings: ReadonlyMap<ProjectID, ProjectReading>,
  ): Promise<SessionForgeLink> => {
    const reading = session.projectID === undefined ? undefined : readings.get(session.projectID);
    const branch = reading === undefined ? undefined : sessionBranch(session, reading.worktrees);
    const link: SessionForgeLink =
      branch === undefined ? { sessionID: session.id } : { sessionID: session.id, branch };

    if (reading?.listed === undefined) return link;

    const forge = await deps.forge.state({ project: reading.project, session });

    return forge === undefined ? link : { ...link, forge };
  };

  return {
    async overview(): Promise<ForgeOverview> {
      const projects = deps.projects.projects;
      const sessions = deps.sessions.sessions;

      const readings = await Effect.runPromise(
        Effect.forEach(projects, (project) => Effect.promise(() => readProject(project)), {
          concurrency: FORGE_READ_CONCURRENCY,
        }),
      );

      const byProject = new Map(readings.map((reading) => [reading.project.id, reading]));

      const links = await Effect.runPromise(
        Effect.forEach(
          sessions,
          (session) => Effect.promise(() => linkSession(session, byProject)),
          {
            concurrency: FORGE_READ_CONCURRENCY,
          },
        ),
      );

      return {
        repositories: readings.flatMap((reading) => repositoryOf(reading)),
        sessions: links,
      };
    },
  };
}

function sessionBranch(session: Session, worktrees: readonly GitWorktree[]): string | undefined {
  const binding = worktreeOf(session);
  const checkout = binding?.path ?? session.directory;
  const listed = worktrees.find((entry) => entry.path === checkout);

  if (listed !== undefined) return listed.branch;

  if (binding !== undefined) return binding.branch;

  return session.backing.kind === "projectDirectory" ? worktrees[0]?.branch : undefined;
}

function repositoryOf(reading: ProjectReading): readonly ForgeRepository[] {
  const { project, listed } = reading;
  const host = project.git?.forge;

  if (host === undefined) return [];

  const remote = project.git?.remoteURL;
  const name = (remote === undefined ? undefined : repositoryPath(remote)) ?? project.name;
  const repository: ForgeRepository = {
    projectID: project.id,
    host,
    name,
    isAvailable: listed !== undefined,
    items: listed?.items ?? [],
  };

  return [listed?.viewer === undefined ? repository : { ...repository, viewer: listed.viewer }];
}
