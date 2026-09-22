import { absolutePath, type AbsolutePath } from "@janela/core";
import { Result, Schema } from "effect";

export interface BranchWorktree {
  readonly directory: AbsolutePath;
  readonly branch?: string;
  readonly isMain: boolean;
}

export interface BranchOverview {
  readonly branches: readonly string[];
  readonly worktrees: readonly BranchWorktree[];
}

interface EncodedWorktree {
  directory: string;
  branch?: string;
  isMain: boolean;
}

interface DecodedWorktree {
  directory: AbsolutePath;
  branch?: string;
  isMain: boolean;
}

const WireWorktree = Schema.Struct({
  directory: Schema.String.check(Schema.isStartsWith("/")),
  branch: Schema.optionalKey(Schema.String),
  isMain: Schema.Boolean,
});

const WireOverview = Schema.Struct({
  branches: Schema.Array(Schema.String),
  worktrees: Schema.Array(WireWorktree),
});

const decodeOverviewText = Schema.decodeUnknownResult(Schema.fromJsonString(WireOverview));

export function serializeBranchOverview(overview: BranchOverview): string {
  return JSON.stringify({
    branches: [...overview.branches],
    worktrees: overview.worktrees.map((worktree) => {
      const encoded: EncodedWorktree = {
        directory: worktree.directory,
        isMain: worktree.isMain,
      };

      if (worktree.branch !== undefined) encoded.branch = worktree.branch;

      return encoded;
    }),
  });
}

export function parseBranchOverview(text: string): BranchOverview {
  const decoded = Result.mapError(
    decodeOverviewText(text),
    (error) => new TypeError(`not a branch overview: ${error.message}`),
  );

  const wire = Result.getOrThrowWith(decoded, (error) => error);

  return {
    branches: wire.branches,
    worktrees: wire.worktrees.map((worktree) => {
      const parsed: DecodedWorktree = {
        directory: absolutePath(worktree.directory),
        isMain: worktree.isMain,
      };

      if (worktree.branch !== undefined) parsed.branch = worktree.branch;

      return parsed;
    }),
  };
}
