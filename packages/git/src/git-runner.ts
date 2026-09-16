import type { AbsolutePath } from "@janela/core";
import { UserFacingError } from "@janela/support";
import { processRunner, type ProcessRunning } from "@janela/support/process";
import { Data, Effect, Match } from "effect";

export interface GitRunning {
  run(args: readonly string[], directory: AbsolutePath): Promise<string>;
  probe(args: readonly string[], directory: AbsolutePath): Promise<GitOutcome>;
}

export interface GitOutcome {
  readonly standardOutput: string;
  readonly standardError: string;
  readonly exitCode: number;
  readonly succeeded: boolean;
}

export interface GitRunnerOptions {
  readonly executable?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly processes?: ProcessRunning;
  readonly timeoutMs?: number;
}

export type GitErrorReason = CloneUnavailable | EntryUnreadable | GitUnrunnable | WorktreeNotListed;

export const DEFAULT_GIT_TIMEOUT_MS = 120_000;

const FALLBACK_PATH = "/usr/bin:/bin";

const READ_ONLY_COMMANDS: readonly (readonly string[])[] = [
  ["status"],
  ["log"],
  ["diff"],
  ["rev-parse"],
  ["ls-files"],
  ["show"],
  ["for-each-ref"],
  ["worktree", "list"],
];

export class GitFailure extends UserFacingError {
  readonly subcommand: string;

  readonly exitCode: number;

  readonly standardError: string;

  override readonly summary: string;

  constructor(subcommand: string, exitCode: number, standardError: string) {
    super(`git ${subcommand} failed`, standardError === "" ? {} : { reason: standardError });
    this.summary = `git ${subcommand} failed.`;
    this.subcommand = subcommand;
    this.exitCode = exitCode;
    this.standardError = standardError;
  }
}

export class GitNotFound extends UserFacingError {
  override readonly summary = "git was not found.";

  constructor() {
    super("git not found on PATH", {
      recoverySuggestion: "Install git (for example with Homebrew) and restart Janela.",
    });
  }
}

export class GitUnrunnable extends Data.TaggedClass("unrunnable")<{
  readonly cause: unknown;
}> {}

export class WorktreeNotListed extends Data.TaggedClass("worktreeNotListed")<{
  readonly directory: AbsolutePath;
}> {}

export class CloneUnavailable extends Data.TaggedClass("cloneUnavailable")<{
  readonly code: string;
}> {}

export class EntryUnreadable extends Data.TaggedClass("entryUnreadable")<{
  readonly code: string;
}> {}

export class GitError extends Data.TaggedError("GitError")<{
  readonly reason: GitErrorReason;
}> {
  override get message(): string {
    return `git error: ${gitErrorLabel(this)}`;
  }
}

export function gitErrorLabel(error: GitError): string {
  return Match.value(error.reason).pipe(
    Match.tag("cloneUnavailable", () => "cloneUnavailable"),
    Match.tag("entryUnreadable", () => "entryUnreadable"),
    Match.tag("unrunnable", () => "unrunnable"),
    Match.tag("worktreeNotListed", () => "worktreeNotListed"),
    Match.exhaustive,
  );
}

function isReadOnly(args: readonly string[]): boolean {
  return READ_ONLY_COMMANDS.some((prefix) => prefix.every((token, index) => args[index] === token));
}

function subcommandOf(args: readonly string[]): string {
  const index = args.findIndex((token) => !token.startsWith("-"));
  const first = index === -1 ? undefined : args[index];

  if (first === undefined) return "git";

  if (first !== "worktree") return first;

  const second = args[index + 1];

  return second === undefined ? first : `${first} ${second}`;
}

export function gitRunner(options: GitRunnerOptions = {}): GitRunning {
  const processes = options.processes ?? processRunner();
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const environment =
    options.environment ??
    Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
  const configured = options.executable;

  let resolving: Promise<string> | undefined;

  const resolveExecutable = (): Promise<string> => {
    resolving ??= (async () => {
      if (configured !== undefined) return configured;

      const found = await processes.which("git", environment["PATH"] ?? FALLBACK_PATH);

      if (found === undefined) throw new GitNotFound();

      return found;
    })();

    return resolving;
  };

  const probe = (args: readonly string[], directory: AbsolutePath): Promise<GitOutcome> =>
    Effect.runPromise(
      Effect.tryPromise({
        try: async () =>
          processes.run({
            executable: await resolveExecutable(),
            arguments: ["-C", directory, ...args],
            workingDirectory: directory,
            environment: isReadOnly(args)
              ? { ...environment, GIT_OPTIONAL_LOCKS: "0" }
              : environment,
            timeoutMs,
          }),
        catch: (cause) =>
          cause instanceof GitNotFound
            ? cause
            : new GitError({ reason: new GitUnrunnable({ cause }) }),
      }).pipe(
        Effect.map((outcome): GitOutcome => ({
          standardOutput: outcome.standardOutput,
          standardError: outcome.standardError,
          exitCode: outcome.exitCode,
          succeeded: outcome.succeeded,
        })),
      ),
    );

  return {
    async run(args: readonly string[], directory: AbsolutePath): Promise<string> {
      const outcome = await probe(args, directory);

      if (!outcome.succeeded) {
        throw new GitFailure(subcommandOf(args), outcome.exitCode, outcome.standardError.trimEnd());
      }

      return outcome.standardOutput;
    },
    probe,
  };
}
