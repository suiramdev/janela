/**
 * `@janela/git` — layer 3, daemon side. Git, by way of `git`.
 *
 * Owns worktree creation, enumeration, removal and removal-safety, plus
 * `.worktreeinclude` resolution. Never leaks a raw command string above its own
 * API, and never imports `@janela/forge`: they are peers, and the subprocess
 * plumbing they share lives in `@janela/support/process`.
 */

export * from "./git-runner.ts";
export * from "./worktree-include.ts";
export * from "./worktree-service.ts";
