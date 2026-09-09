import type { Instant, Forge, Project, Session } from "@janela/core";

/**
 * `@janela/forge` — layer 3, daemon side.
 *
 * GitHub and GitLab state, read through the user's own `gh` and `glab`. The
 * interfaces below are the contract.
 *
 * Three properties are load-bearing and none of them is about GitHub:
 *
 * 1. **We shell out to the user's own `gh` and `glab`, already authenticated.** We
 *    never ask for a token, never store one, and never implement a forge API
 *    client. A missing or logged-out CLI is *silence*, not an error banner.
 * 2. **Everything here is a cache with a timestamp**, never a source of truth, and
 *    every field is optional because the CLI may be missing, logged out,
 *    rate-limited, or pointed at an enterprise host we cannot reach. Absence
 *    renders as absence.
 * 3. **Nothing waits on it.** A forge refresh is network-bound and must never be
 *    awaited on a path a client is waiting for. It publishes when it arrives.
 *
 * A peer of `@janela/git`, and the two must never import each other. Shared
 * subprocess plumbing lives in `@janela/support/process`.
 */

/**
 * Read-only, cached, per-session, and derived from the session's branch.
 *
 * Not a domain entity: a pull request is not something Janela owns, and modelling
 * one would make us look like we did. It hangs off a session as a value.
 */
export interface ForgeState {
  readonly host: Forge;
  readonly pullRequest?: PullRequestSummary;
  readonly checks?: CheckRollup;
  readonly refreshedAt: Instant;
}

export interface PullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "merged" | "closed";
  readonly isDraft: boolean;
  readonly url: string;
}

export type CheckRollup = "passing" | "failing" | "running" | "none";

export interface ForgeServing {
  /**
   * Whether the CLI for this forge is present and logged in.
   *
   * Called before anything is offered. A `false` here hides a feature; it never
   * shows a broken one.
   */
  isAvailable(host: Forge): Promise<boolean>;

  /**
   * State for the branch a session is on. Resolves to `undefined` for every
   * ordinary reason — no CLI, not logged in, no PR, unreachable host.
   */
  state(request: {
    readonly project: Project;
    readonly session: Session;
  }): Promise<ForgeState | undefined>;

  /**
   * The head branch of a pull request, for "new session from PR".
   *
   * Resolves the branch and hands it back so a *worktree* can be created from it.
   * Never `gh pr checkout`, which would mutate the user's own checkout — that is
   * the whole reason this method returns a string instead of doing the work.
   */
  pullRequestBranch(request: {
    readonly project: Project;
    readonly number: number;
  }): Promise<string | undefined>;
}

export * from "./forge-service.ts";
