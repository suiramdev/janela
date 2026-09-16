import { realpath, rm } from "node:fs/promises";

import { absolutePath, type AbsolutePath } from "@janela/core";
import { Data, Match, Option } from "effect";

import { GitError, type GitRunning, WorktreeNotListed } from "./git-runner.ts";

export interface GitWorktree {
  readonly path: AbsolutePath;
  readonly head?: string;
  readonly branch?: string;
  readonly isBare: boolean;
  readonly isDetached: boolean;
  readonly lockReason?: string;
  readonly isPrunable: boolean;
}

export interface WorktreeServing {
  worktrees(repository: AbsolutePath): Promise<readonly GitWorktree[]>;

  branches(repository: AbsolutePath): Promise<readonly string[]>;

  checkoutBranch(repository: AbsolutePath, branch: string): Promise<void>;

  createWorktree(request: {
    readonly repository: AbsolutePath;
    readonly directory: AbsolutePath;
    readonly branch?: string;
    readonly startPoint?: string;
    readonly force?: boolean;
  }): Promise<GitWorktree>;

  removalSafety(worktree: GitWorktree): Promise<WorktreeRemovalSafety>;

  removeWorktree(request: {
    readonly directory: AbsolutePath;
    readonly repository: AbsolutePath;
    readonly force: boolean;
  }): Promise<void>;
}

export interface WorktreeRemovalSafety {
  readonly hasUncommittedChanges: boolean;
  readonly hasUntrackedFiles: boolean;
  readonly hasUnpushedCommits: boolean;
  readonly isLocked: boolean;
  readonly hasRunningSessions: boolean;
}

interface WorktreeDraft {
  readonly path: string | undefined;
  readonly head: string | undefined;
  readonly branch: string | undefined;
  readonly lockReason: string | undefined;
  readonly isBare: boolean;
  readonly isDetached: boolean;
  readonly isPrunable: boolean;
}

interface StatusSummary {
  readonly modified: boolean;
  readonly untracked: boolean;
}

export type RemovalObstacle =
  | LockedByAnotherProcess
  | RunningSessions
  | UncommittedChanges
  | UnpushedCommits
  | UntrackedFiles;

type MutableWorktree = { -readonly [Key in keyof GitWorktree]: GitWorktree[Key] };

const RECORD_SEPARATOR = "\0\0";

const ATTRIBUTE_SEPARATOR = "\0";

const SHORT_BRANCH = /^refs\/heads\//;

const EMPTY_DRAFT: WorktreeDraft = {
  path: undefined,
  head: undefined,
  branch: undefined,
  lockReason: undefined,
  isBare: false,
  isDetached: false,
  isPrunable: false,
};

const asWorktreePath = Option.liftThrowable(absolutePath);

export class UncommittedChanges extends Data.TaggedClass("uncommittedChanges")<
  Record<never, never>
> {}

export class UntrackedFiles extends Data.TaggedClass("untrackedFiles")<Record<never, never>> {}

export class UnpushedCommits extends Data.TaggedClass("unpushedCommits")<Record<never, never>> {}

export class LockedByAnotherProcess extends Data.TaggedClass("locked")<Record<never, never>> {}

export class RunningSessions extends Data.TaggedClass("runningSessions")<Record<never, never>> {}

export function removalObstacles(safety: WorktreeRemovalSafety): readonly RemovalObstacle[] {
  const obstacles: RemovalObstacle[] = [];

  if (safety.hasUncommittedChanges) obstacles.push(new UncommittedChanges());

  if (safety.hasUntrackedFiles) obstacles.push(new UntrackedFiles());

  if (safety.hasUnpushedCommits) obstacles.push(new UnpushedCommits());

  if (safety.isLocked) obstacles.push(new LockedByAnotherProcess());

  if (safety.hasRunningSessions) obstacles.push(new RunningSessions());

  return obstacles;
}

export function removalObstacleLabel(obstacle: RemovalObstacle): string {
  return Match.value(obstacle).pipe(
    Match.tag("uncommittedChanges", () => "uncommittedChanges"),
    Match.tag("untrackedFiles", () => "untrackedFiles"),
    Match.tag("unpushedCommits", () => "unpushedCommits"),
    Match.tag("locked", () => "locked"),
    Match.tag("runningSessions", () => "runningSessions"),
    Match.exhaustive,
  );
}

export function isTriviallySafe(safety: WorktreeRemovalSafety): boolean {
  return removalObstacles(safety).length === 0;
}

function withAttribute(
  draft: WorktreeDraft,
  attribute: string,
  value: string | undefined,
): WorktreeDraft {
  return Match.value(attribute).pipe(
    Match.when("worktree", () => ({ ...draft, path: value })),
    Match.when("HEAD", () => ({ ...draft, head: value })),
    Match.when("branch", () => ({ ...draft, branch: value?.replace(SHORT_BRANCH, "") })),
    Match.when("locked", () => ({ ...draft, lockReason: value ?? "" })),
    Match.when("bare", () => ({ ...draft, isBare: true })),
    Match.when("detached", () => ({ ...draft, isDetached: true })),
    Match.when("prunable", () => ({ ...draft, isPrunable: true })),
    Match.orElse(() => draft),
  );
}

function toWorktree(draft: WorktreeDraft): GitWorktree | undefined {
  const path =
    draft.path === undefined ? undefined : Option.getOrUndefined(asWorktreePath(draft.path));

  if (path === undefined) return undefined;

  const listed: MutableWorktree = {
    path,
    isBare: draft.isBare,
    isDetached: draft.isDetached,
    isPrunable: draft.isPrunable,
  };

  if (draft.head !== undefined) listed.head = draft.head;

  if (draft.branch !== undefined) listed.branch = draft.branch;

  if (draft.lockReason !== undefined) listed.lockReason = draft.lockReason;

  return listed;
}

function parseWorktreeList(output: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];

  for (const record of output.split(RECORD_SEPARATOR)) {
    if (record === "") continue;

    let draft = EMPTY_DRAFT;

    for (const line of record.split(ATTRIBUTE_SEPARATOR)) {
      if (line === "") continue;

      const separator = line.indexOf(" ");

      draft = withAttribute(
        draft,
        separator === -1 ? line : line.slice(0, separator),
        separator === -1 ? undefined : line.slice(separator + 1),
      );
    }

    const listed = toWorktree(draft);

    if (listed !== undefined) worktrees.push(listed);
  }

  return worktrees;
}

function parseStatus(output: string): StatusSummary {
  const tokens = output.split(ATTRIBUTE_SEPARATOR);
  let modified = false;
  let untracked = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index];

    if (entry === undefined || entry === "") continue;

    const code = entry.slice(0, 2);

    if (code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") {
      index += 1;
    }

    if (code === "??") untracked = true;
    else if (code !== "!!") modified = true;
  }

  return { modified, untracked };
}

export function worktreeService(git: GitRunning): WorktreeServing {
  const worktrees = async (repository: AbsolutePath): Promise<readonly GitWorktree[]> =>
    parseWorktreeList(await git.run(["worktree", "list", "--porcelain", "-z"], repository));

  return {
    worktrees,

    async branches(repository: AbsolutePath): Promise<readonly string[]> {
      const output = await git.run(
        ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
        repository,
      );

      return output.split("\n").filter((line) => line !== "");
    },

    async checkoutBranch(repository: AbsolutePath, branch: string): Promise<void> {
      await git.run(["checkout", branch], repository);
    },

    async createWorktree({
      repository,
      directory,
      branch,
      startPoint,
      force,
    }): Promise<GitWorktree> {
      const start = startPoint === undefined ? [] : [startPoint];
      const forced = force === true ? ["--force"] : [];

      if (branch === undefined) {
        await git.run(["worktree", "add", ...forced, "--detach", directory, ...start], repository);
      } else {
        const existing = await git.probe(
          ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
          repository,
        );

        if (existing.succeeded) {
          await git.run(["worktree", "add", ...forced, directory, branch], repository);
        } else {
          await git.run(["worktree", "add", "-b", branch, directory, ...start], repository);
        }
      }

      const created = await realpath(directory);
      const listed = (await worktrees(repository)).find((entry) => entry.path === created);

      if (listed === undefined) {
        throw new GitError({ reason: new WorktreeNotListed({ directory }) });
      }

      return listed;
    },

    async removalSafety(worktree: GitWorktree): Promise<WorktreeRemovalSafety> {
      const isLocked = worktree.lockReason !== undefined;

      if (worktree.isPrunable) {
        return {
          hasUncommittedChanges: false,
          hasUntrackedFiles: false,
          hasUnpushedCommits: false,
          isLocked,
          hasRunningSessions: false,
        };
      }

      const status = parseStatus(await git.run(["status", "--porcelain=v1", "-z"], worktree.path));
      const ahead = await git.probe(
        ["log", "--format=%H", "-n", "1", "@{upstream}..HEAD"],
        worktree.path,
      );

      let hasUnpushedCommits: boolean;

      if (ahead.succeeded) {
        hasUnpushedCommits = ahead.standardOutput.trim() !== "";
      } else {
        const unreachable = await git.run(
          [
            "log",
            "--format=%H",
            "-n",
            "1",
            "HEAD",
            "--not",
            "--remotes",
            ...(worktree.isDetached ? ["--branches"] : []),
          ],
          worktree.path,
        );

        hasUnpushedCommits = unreachable.trim() !== "";
      }

      return {
        hasUncommittedChanges: status.modified,
        hasUntrackedFiles: status.untracked,
        hasUnpushedCommits,
        isLocked,
        hasRunningSessions: false,
      };
    },

    async removeWorktree({ directory, repository, force }): Promise<void> {
      await git.run(["worktree", "remove", ...(force ? ["--force"] : []), directory], repository);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
