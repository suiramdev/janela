import type {
  CheckRollup,
  Forge,
  ForgeItem,
  ForgeItems,
  ForgeState,
  Project,
  ProjectID,
  PullRequestSummary,
  Session,
  SessionID,
} from "@janela/core";
import { forgeExecutable, instant, isWebURL, worktreeOf } from "@janela/core";
import type { Logger } from "@janela/support";
import { UserFacingError } from "@janela/support";
import { processRunner, type ProcessRunning } from "@janela/support/process";
import { Data, Effect, Match, Option, Result, Schema } from "effect";

import type { ForgeServing } from "./index.ts";

export interface ForgeServiceOptions {
  readonly environment?: Readonly<Record<string, string>>;
  readonly processes?: ProcessRunning;
  readonly timeoutMs?: number;
  readonly log?: Logger;
  readonly clock?: () => number;
}

interface CacheEntry<T> {
  readonly refreshedAt: number;
  readonly result: Promise<T>;
}

interface DecodedPullRequest {
  readonly pullRequest: PullRequestSummary;
  readonly checks: CheckRollup;
}

interface DecodedHead {
  readonly branch: string;
  readonly isCrossRepository: boolean;
}

export type ForgeFailure =
  | CrossRepository
  | MalformedOutput
  | MissingBinary
  | NetworkFailure
  | NoPullRequest
  | NotLoggedIn
  | OutputTooLarge
  | RateLimited
  | ReadTimedOut
  | SpawnFailure
  | UnclassifiedExit
  | UnknownShape;

export class MissingBinary extends Data.TaggedClass("missingBinary")<Record<never, never>> {}

export class SpawnFailure extends Data.TaggedClass("spawnFailure")<Record<never, never>> {}

export class ReadTimedOut extends Data.TaggedClass("timeout")<Record<never, never>> {}

export class OutputTooLarge extends Data.TaggedClass("outputTooLarge")<Record<never, never>> {}

export class NotLoggedIn extends Data.TaggedClass("notLoggedIn")<Record<never, never>> {}

export class RateLimited extends Data.TaggedClass("rateLimited")<Record<never, never>> {}

export class NetworkFailure extends Data.TaggedClass("networkFailure")<Record<never, never>> {}

export class NoPullRequest extends Data.TaggedClass("noPullRequest")<Record<never, never>> {}

export class CrossRepository extends Data.TaggedClass("crossRepository")<Record<never, never>> {}

export class MalformedOutput extends Data.TaggedClass("malformedOutput")<Record<never, never>> {}

export class UnknownShape extends Data.TaggedClass("unknownShape")<Record<never, never>> {}

export class UnclassifiedExit extends Data.TaggedClass("exit")<Record<never, never>> {}

export class ForgeReadFailed extends Data.TaggedError("ForgeReadFailed")<{
  readonly reason: ForgeFailure;
  readonly exitCode?: number;
}> {
  override get message(): string {
    return `forge read failed: ${forgeFailureLabel(this.reason)}`;
  }
}

export class PullRequestUnavailable extends UserFacingError {
  override readonly summary = "Couldn't find that pull request.";
  readonly number: number;

  constructor(number: number) {
    super(`pull request ${number} could not be resolved through the forge CLI`, {
      recoverySuggestion:
        "Check that you're logged in to gh or glab and that the pull request is in this repository.",
    });

    this.number = number;
  }
}

export const DEFAULT_FORGE_TIMEOUT_MS = 15_000;

export const FORGE_REFRESH_INTERVAL_MS = 60_000;

export const FORGE_LIST_LIMIT = 50;

export const MAXIMUM_FORGE_OUTPUT_CHARACTERS = 1_048_576;

const FALLBACK_PATH = "/usr/bin:/bin";

const SILENT: Logger = {
  debug: () => {},
  info: () => {},
  notice: () => {},
  warning: () => {},
  error: () => {},
};

const FAILURE_SIGNATURES = [
  { signatures: ["unknown json field"], failure: (): ForgeFailure => new UnknownShape() },
  {
    signatures: ["gh auth login", "glab auth login", "not logged in", "no token found", "401"],
    failure: (): ForgeFailure => new NotLoggedIn(),
  },
  { signatures: ["rate limit", "429"], failure: (): ForgeFailure => new RateLimited() },
  {
    signatures: [
      "dial tcp",
      "no such host",
      "connection refused",
      "network is unreachable",
      "i/o timeout",
      "tls handshake",
      "error connecting to",
      "temporary failure in name resolution",
    ],
    failure: (): ForgeFailure => new NetworkFailure(),
  },
  {
    signatures: [
      "no pull requests found",
      "could not resolve to a pullrequest",
      "no open merge request",
      "404",
    ],
    failure: (): ForgeFailure => new NoPullRequest(),
  },
];

const GitHubFailedConclusion = Schema.Literals([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);

const GitHubCheckRun = Schema.Struct({
  __typename: Schema.Literal("CheckRun"),
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
});

const GitHubStatusContext = Schema.Struct({
  __typename: Schema.Literal("StatusContext"),
  state: Schema.String,
});

const GitHubRollupEntry = Schema.Union([GitHubCheckRun, GitHubStatusContext]);

const WebURL = Schema.String.check(Schema.makeFilter<string>(isWebURL));

const IsoInstant = Schema.String.check(
  Schema.makeFilter<string>((raw) => !Number.isNaN(Date.parse(raw))),
);

const GitHubPullRequest = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.Literals(["OPEN", "MERGED", "CLOSED"]),
  isDraft: Schema.Boolean,
  url: WebURL,
  statusCheckRollup: Schema.Array(GitHubRollupEntry),
});

const GitHubActor = Schema.Struct({ login: Schema.String });

const GitHubLabel = Schema.Struct({ name: Schema.String });

const GitHubIssueListing = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED"]),
  url: WebURL,
  author: Schema.NullOr(GitHubActor),
  assignees: Schema.Array(GitHubActor),
  labels: Schema.Array(GitHubLabel),
  updatedAt: IsoInstant,
});

const GitHubPullRequestListing = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.Literals(["OPEN", "MERGED", "CLOSED"]),
  isDraft: Schema.Boolean,
  url: WebURL,
  author: Schema.NullOr(GitHubActor),
  assignees: Schema.Array(GitHubActor),
  reviewRequests: Schema.Array(Schema.Struct({ login: Schema.optionalKey(Schema.String) })),
  labels: Schema.Array(GitHubLabel),
  headRefName: Schema.String,
  updatedAt: IsoInstant,
});

const GitHubViewer = Schema.Struct({ login: Schema.String.check(Schema.isNonEmpty()) });

const GitHubHead = Schema.Struct({
  headRefName: Schema.String.check(Schema.isNonEmpty()),
  isCrossRepository: Schema.Boolean,
});

const GitLabPipeline = Schema.Struct({ status: Schema.String });

const GitLabMergeRequest = Schema.Struct({
  iid: Schema.Number,
  title: Schema.String,
  state: Schema.Literals(["opened", "locked", "merged", "closed"]),
  draft: Schema.Boolean,
  web_url: WebURL,
  head_pipeline: Schema.optionalKey(Schema.NullOr(GitLabPipeline)),
});

const GitLabUser = Schema.Struct({ username: Schema.String });

const GitLabIssueListing = Schema.Struct({
  iid: Schema.Number,
  title: Schema.String,
  state: Schema.Literals(["opened", "locked", "closed"]),
  web_url: WebURL,
  author: Schema.NullOr(GitLabUser),
  assignees: Schema.optionalKey(Schema.NullOr(Schema.Array(GitLabUser))),
  labels: Schema.Array(Schema.String),
  updated_at: IsoInstant,
});

const GitLabMergeRequestListing = Schema.Struct({
  iid: Schema.Number,
  title: Schema.String,
  state: Schema.Literals(["opened", "locked", "merged", "closed"]),
  draft: Schema.Boolean,
  web_url: WebURL,
  author: Schema.NullOr(GitLabUser),
  assignees: Schema.optionalKey(Schema.NullOr(Schema.Array(GitLabUser))),
  reviewers: Schema.optionalKey(Schema.NullOr(Schema.Array(GitLabUser))),
  labels: Schema.Array(Schema.String),
  source_branch: Schema.String,
  updated_at: IsoInstant,
});

const GitLabViewer = Schema.Struct({ username: Schema.String.check(Schema.isNonEmpty()) });

const GitLabHead = Schema.Struct({
  source_branch: Schema.String.check(Schema.isNonEmpty()),
  source_project_id: Schema.Number,
  target_project_id: Schema.Number,
});

const GitLabPipelineStatus = Schema.Literals([
  "success",
  "skipped",
  "failed",
  "canceled",
  "running",
  "pending",
  "created",
  "waiting_for_resource",
  "preparing",
  "scheduled",
  "manual",
]);

const GITHUB_STATE_FIELDS = Object.keys(GitHubPullRequest.fields).join(",");

const GITHUB_HEAD_FIELDS = Object.keys(GitHubHead.fields).join(",");

const GITHUB_ISSUE_FIELDS = Object.keys(GitHubIssueListing.fields).join(",");

const GITHUB_PULL_REQUEST_LIST_FIELDS = Object.keys(GitHubPullRequestListing.fields).join(",");

const GITHUB_LIST_FLAGS = ["--state", "all", "--search", "sort:updated-desc", "--limit"];

const GITLAB_LIST_FLAGS = ["--all", "--order", "updated_at", "--sort", "desc", "--per-page"];

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const decodeGitHubPullRequest = Schema.decodeUnknownOption(GitHubPullRequest);

const decodeGitHubHead = Schema.decodeUnknownOption(GitHubHead);

const decodeGitLabMergeRequest = Schema.decodeUnknownOption(GitLabMergeRequest);

const decodeGitLabHead = Schema.decodeUnknownOption(GitLabHead);

const decodeGitLabPipelineStatus = Schema.decodeUnknownOption(GitLabPipelineStatus);

const decodeGitHubFailedConclusion = Schema.decodeUnknownOption(GitHubFailedConclusion);

type GitHubRollupEntry = typeof GitHubRollupEntry.Type;

type GitLabPipeline = typeof GitLabPipeline.Type;

type GitLabUser = typeof GitLabUser.Type;

export function forgeService(options: ForgeServiceOptions = {}): ForgeServing {
  const processes = options.processes ?? processRunner();
  const timeoutMs = options.timeoutMs ?? DEFAULT_FORGE_TIMEOUT_MS;
  const log = options.log ?? SILENT;
  const clock = options.clock ?? Date.now;
  const environment: Readonly<Record<string, string>> =
    options.environment ??
    Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );

  const states = new Map<SessionID, CacheEntry<ForgeState | undefined>>();
  const listings = new Map<ProjectID, CacheEntry<ForgeItems | undefined>>();
  const availability = new Map<Forge, CacheEntry<boolean>>();

  const cached = <K, T>(
    cache: Map<K, CacheEntry<T>>,
    key: K,
    at: number,
    read: () => Promise<T>,
  ): Promise<T> => {
    for (const [existing, entry] of cache) {
      if (at - entry.refreshedAt >= FORGE_REFRESH_INTERVAL_MS) cache.delete(existing);
    }

    const live = cache.get(key);

    if (live !== undefined) return live.result;

    const result = read();

    cache.set(key, { refreshedAt: at, result });

    return result;
  };

  const invoke = (
    host: Forge,
    args: readonly string[],
    workingDirectory: string,
  ): Effect.Effect<string, ForgeReadFailed> =>
    Effect.gen(function* () {
      const executable = yield* Effect.promise(() =>
        processes.which(forgeExecutable(host), environment["PATH"] ?? FALLBACK_PATH),
      );

      if (executable === undefined)
        return yield* new ForgeReadFailed({ reason: new MissingBinary() });

      const outcome = yield* Effect.tryPromise({
        try: () =>
          processes.run({ executable, arguments: args, workingDirectory, environment, timeoutMs }),
        catch: () => new ForgeReadFailed({ reason: new SpawnFailure() }),
      });

      if (outcome.timedOut) return yield* new ForgeReadFailed({ reason: new ReadTimedOut() });

      if (outcome.standardOutput.length > MAXIMUM_FORGE_OUTPUT_CHARACTERS) {
        return yield* new ForgeReadFailed({ reason: new OutputTooLarge() });
      }

      if (!outcome.succeeded) {
        return yield* new ForgeReadFailed({
          reason: classifyFailure(`${outcome.standardError}\n${outcome.standardOutput}`),
          exitCode: outcome.exitCode,
        });
      }

      return outcome.standardOutput;
    });

  const logFailure = (host: Forge, subcommand: string, failed: ForgeReadFailed): void => {
    const shape = {
      forge: host,
      cli: forgeExecutable(host),
      subcommand,
      failure: forgeFailureLabel(failed.reason),
    };

    const fields = failed.exitCode === undefined ? shape : { ...shape, exitCode: failed.exitCode };

    if (isLoudFailure(failed.reason)) log.warning("forge read failed", fields);
    else log.info("forge read failed", fields);
  };

  const absentOnFailure = <A>(
    host: Forge,
    subcommand: string,
    program: Effect.Effect<A, ForgeReadFailed>,
  ): Promise<A | undefined> =>
    Effect.runPromise(
      program.pipe(
        Effect.catchTag("ForgeReadFailed", (failed) => {
          logFailure(host, subcommand, failed);

          return Effect.succeed(undefined);
        }),
      ),
    );

  const decodedRead = <A>(
    host: Forge,
    subcommand: string,
    args: readonly string[],
    workingDirectory: string,
    decode: (standardOutput: string) => Result.Result<A, ForgeFailure>,
  ): Promise<A | undefined> =>
    absentOnFailure(
      host,
      subcommand,
      Effect.gen(function* () {
        const standardOutput = yield* invoke(host, args, workingDirectory);
        const read = yield* Effect.fromResult(
          Result.mapError(decode(standardOutput), (reason) => new ForgeReadFailed({ reason })),
        );

        log.debug("forge read", { forge: host, cli: forgeExecutable(host), subcommand });

        return read;
      }),
    );

  const readItems = async (host: Forge, project: Project): Promise<ForgeItems | undefined> => {
    const limit = String(FORGE_LIST_LIMIT);
    const directory = project.directory;

    const [pullRequests, issues, viewer] = await (host === "gitHub"
      ? Promise.all([
          decodedRead(
            host,
            "pr list",
            ["pr", "list", ...GITHUB_LIST_FLAGS, limit, "--json", GITHUB_PULL_REQUEST_LIST_FIELDS],
            directory,
            gitHubPullRequestsOf,
          ),
          decodedRead(
            host,
            "issue list",
            ["issue", "list", ...GITHUB_LIST_FLAGS, limit, "--json", GITHUB_ISSUE_FIELDS],
            directory,
            gitHubIssuesOf,
          ),
          decodedRead(host, "api user", ["api", "user"], directory, gitHubViewerOf),
        ])
      : Promise.all([
          decodedRead(
            host,
            "mr list",
            ["mr", "list", ...GITLAB_LIST_FLAGS, limit, "--output", "json"],
            directory,
            gitLabMergeRequestsOf,
          ),
          decodedRead(
            host,
            "issue list",
            ["issue", "list", ...GITLAB_LIST_FLAGS, limit, "--output", "json"],
            directory,
            gitLabIssuesOf,
          ),
          decodedRead(host, "api user", ["api", "user"], directory, gitLabViewerOf),
        ]));

    if (pullRequests === undefined && issues === undefined) return undefined;

    const items = [...(pullRequests ?? []), ...(issues ?? [])];

    return viewer === undefined ? { items } : { viewer, items };
  };

  const readState = (
    host: Forge,
    session: Session,
    at: number,
  ): Promise<ForgeState | undefined> => {
    const subcommand = host === "gitHub" ? "pr view" : "mr view";
    const selector = worktreeOf(session)?.branch;
    const positional = selector === undefined ? [] : [selector];
    const args =
      host === "gitHub"
        ? ["pr", "view", ...positional, "--json", GITHUB_STATE_FIELDS]
        : ["mr", "view", ...positional, "--output", "json"];

    return absentOnFailure(
      host,
      subcommand,
      Effect.gen(function* () {
        const standardOutput = yield* invoke(host, args, session.directory);
        const read = yield* Effect.fromResult(
          Result.mapError(
            host === "gitHub"
              ? gitHubPullRequestOf(standardOutput)
              : gitLabMergeRequestOf(standardOutput),
            (reason) => new ForgeReadFailed({ reason }),
          ),
        );

        log.debug("forge read", { forge: host, cli: forgeExecutable(host), subcommand });

        return {
          host,
          pullRequest: read.pullRequest,
          checks: read.checks,
          refreshedAt: instant(new Date(at)),
        };
      }),
    );
  };

  const readHeadBranch = (
    host: Forge,
    project: Project,
    number: number,
  ): Promise<string | undefined> => {
    const subcommand = host === "gitHub" ? "pr view" : "mr view";
    const args =
      host === "gitHub"
        ? ["pr", "view", String(number), "--json", GITHUB_HEAD_FIELDS]
        : ["mr", "view", String(number), "--output", "json"];

    return absentOnFailure(
      host,
      subcommand,
      Effect.gen(function* () {
        const standardOutput = yield* invoke(host, args, project.directory);
        const head = yield* Effect.fromResult(
          Result.mapError(
            host === "gitHub" ? gitHubHeadOf(standardOutput) : gitLabHeadOf(standardOutput),
            (reason) => new ForgeReadFailed({ reason }),
          ),
        );

        log.debug("forge read", { forge: host, cli: forgeExecutable(host), subcommand });

        if (head.isCrossRepository) {
          return yield* new ForgeReadFailed({ reason: new CrossRepository() });
        }

        return head.branch;
      }),
    );
  };

  return {
    isAvailable(host: Forge): Promise<boolean> {
      return cached(availability, host, clock(), async () => {
        const reachable = await absentOnFailure(
          host,
          "auth status",
          invoke(host, ["auth", "status"], environment["HOME"] ?? "/").pipe(Effect.map(() => true)),
        );

        return reachable ?? false;
      });
    },

    state(request: { readonly project: Project; readonly session: Session }) {
      const host = request.project.git?.forge;

      if (host === undefined) return Promise.resolve(undefined);

      const at = clock();

      return cached(states, request.session.id, at, () => readState(host, request.session, at));
    },

    items(project: Project): Promise<ForgeItems | undefined> {
      const host = project.git?.forge;

      if (host === undefined) return Promise.resolve(undefined);

      return cached(listings, project.id, clock(), () => readItems(host, project));
    },

    pullRequestBranch(request: {
      readonly project: Project;
      readonly number: number;
    }): Promise<string | undefined> {
      const host = request.project.git?.forge;

      if (host === undefined) return Promise.resolve(undefined);

      return readHeadBranch(host, request.project, request.number);
    },
  };
}

export function forgeFailureLabel(failure: ForgeFailure): string {
  return Match.value(failure).pipe(
    Match.tagsExhaustive({
      missingBinary: () => "missingBinary",
      spawnFailure: () => "spawnFailure",
      timeout: () => "timeout",
      outputTooLarge: () => "outputTooLarge",
      notLoggedIn: () => "notLoggedIn",
      rateLimited: () => "rateLimited",
      networkFailure: () => "networkFailure",
      noPullRequest: () => "noPullRequest",
      crossRepository: () => "crossRepository",
      malformedOutput: () => "malformedOutput",
      unknownShape: () => "unknownShape",
      exit: () => "exit",
    }),
  );
}

function isLoudFailure(failure: ForgeFailure): boolean {
  return Match.value(failure).pipe(
    Match.tag("unknownShape", "malformedOutput", "outputTooLarge", "timeout", () => true),
    Match.orElse(() => false),
  );
}

function classifyFailure(text: string): ForgeFailure {
  const haystack = text.toLowerCase();

  for (const candidate of FAILURE_SIGNATURES) {
    if (candidate.signatures.some((signature) => haystack.includes(signature))) {
      return candidate.failure();
    }
  }

  return new UnclassifiedExit();
}

function gitHubPullRequestOf(
  standardOutput: string,
): Result.Result<DecodedPullRequest, ForgeFailure> {
  const json = Option.getOrUndefined(decodeJson(standardOutput));

  if (json === undefined) return Result.fail(new MalformedOutput());

  const decoded = Option.getOrUndefined(decodeGitHubPullRequest(json));

  if (decoded === undefined) return Result.fail(new UnknownShape());

  return Result.succeed({
    pullRequest: {
      number: decoded.number,
      title: decoded.title,
      state: Match.value(decoded.state).pipe(
        Match.when("OPEN", () => "open" as const),
        Match.when("MERGED", () => "merged" as const),
        Match.when("CLOSED", () => "closed" as const),
        Match.exhaustive,
      ),
      isDraft: decoded.isDraft,
      url: decoded.url,
    },
    checks: gitHubRollup(decoded.statusCheckRollup),
  });
}

function gitHubRollup(entries: readonly GitHubRollupEntry[]): CheckRollup {
  if (entries.length === 0) return "none";

  let unfinished = false;

  for (const entry of entries) {
    const outcome = Match.value(entry).pipe(
      Match.discriminator("__typename")("CheckRun", (run) => {
        if (
          run.conclusion !== null &&
          Option.isSome(decodeGitHubFailedConclusion(run.conclusion))
        ) {
          return "failing" as const;
        }

        return run.status === "COMPLETED" ? "passing" : "running";
      }),
      Match.discriminator("__typename")("StatusContext", (context) => {
        if (context.state === "FAILURE" || context.state === "ERROR") return "failing" as const;

        return context.state === "PENDING" || context.state === "EXPECTED" ? "running" : "passing";
      }),
      Match.exhaustive,
    );

    if (outcome === "failing") return "failing";

    if (outcome === "running") unfinished = true;
  }

  return unfinished ? "running" : "passing";
}

function gitHubHeadOf(standardOutput: string): Result.Result<DecodedHead, ForgeFailure> {
  const json = Option.getOrUndefined(decodeJson(standardOutput));

  if (json === undefined) return Result.fail(new MalformedOutput());

  const decoded = Option.getOrUndefined(decodeGitHubHead(json));

  if (decoded === undefined) return Result.fail(new UnknownShape());

  return Result.succeed({
    branch: decoded.headRefName,
    isCrossRepository: decoded.isCrossRepository,
  });
}

function gitLabMergeRequestOf(
  standardOutput: string,
): Result.Result<DecodedPullRequest, ForgeFailure> {
  const json = Option.getOrUndefined(decodeJson(standardOutput));

  if (json === undefined) return Result.fail(new MalformedOutput());

  const decoded = Option.getOrUndefined(decodeGitLabMergeRequest(json));

  if (decoded === undefined) return Result.fail(new UnknownShape());

  return Result.succeed({
    pullRequest: {
      number: decoded.iid,
      title: decoded.title,
      state: Match.value(decoded.state).pipe(
        Match.whenOr("opened", "locked", () => "open" as const),
        Match.when("merged", () => "merged" as const),
        Match.when("closed", () => "closed" as const),
        Match.exhaustive,
      ),
      isDraft: decoded.draft,
      url: decoded.web_url,
    },
    checks: gitLabRollup(decoded.head_pipeline),
  });
}

function gitLabRollup(pipeline: GitLabPipeline | null | undefined): CheckRollup {
  if (pipeline === undefined || pipeline === null) return "none";

  const status = Option.getOrUndefined(decodeGitLabPipelineStatus(pipeline.status));

  if (status === undefined) return "none";

  return Match.value(status).pipe(
    Match.whenOr("success", "skipped", () => "passing" as const),
    Match.whenOr("failed", "canceled", () => "failing" as const),
    Match.whenOr(
      "running",
      "pending",
      "created",
      "waiting_for_resource",
      "preparing",
      "scheduled",
      "manual",
      () => "running" as const,
    ),
    Match.exhaustive,
  );
}

function gitLabHeadOf(standardOutput: string): Result.Result<DecodedHead, ForgeFailure> {
  const json = Option.getOrUndefined(decodeJson(standardOutput));

  if (json === undefined) return Result.fail(new MalformedOutput());

  const decoded = Option.getOrUndefined(decodeGitLabHead(json));

  if (decoded === undefined) return Result.fail(new UnknownShape());

  return Result.succeed({
    branch: decoded.source_branch,
    isCrossRepository: decoded.source_project_id !== decoded.target_project_id,
  });
}

function decodedOutput<A>(
  standardOutput: string,
  schema: Schema.Codec<A, unknown>,
): Result.Result<A, ForgeFailure> {
  const json = decodeJson(standardOutput);

  if (Option.isNone(json)) return Result.fail(new MalformedOutput());

  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(schema)(json.value));

  return decoded === undefined ? Result.fail(new UnknownShape()) : Result.succeed(decoded);
}

function forgeItem(
  fields: Omit<ForgeItem, "author" | "branch" | "updatedAt"> & {
    readonly author: string | undefined;
    readonly branch: string | undefined;
    readonly updatedAt: string;
  },
): ForgeItem {
  const { author, branch, updatedAt, ...rest } = fields;
  const item: ForgeItem = { ...rest, updatedAt: instant(updatedAt) };
  const withAuthor = author === undefined ? item : { ...item, author };

  return branch === undefined || branch.length === 0 ? withAuthor : { ...withAuthor, branch };
}

function usernames(users: readonly GitLabUser[] | null | undefined): readonly string[] {
  return (users ?? []).map((user) => user.username);
}

function gitHubPullRequestsOf(standardOutput: string): Result.Result<ForgeItem[], ForgeFailure> {
  return Result.map(
    decodedOutput(standardOutput, Schema.Array(GitHubPullRequestListing)),
    (listed) =>
      listed.map((entry) =>
        forgeItem({
          kind: "pullRequest",
          number: entry.number,
          title: entry.title,
          state: Match.value(entry.state).pipe(
            Match.when("OPEN", () => "open" as const),
            Match.when("MERGED", () => "merged" as const),
            Match.when("CLOSED", () => "closed" as const),
            Match.exhaustive,
          ),
          isDraft: entry.isDraft,
          url: entry.url,
          author: entry.author?.login,
          assignees: entry.assignees.map((assignee) => assignee.login),
          reviewers: entry.reviewRequests.flatMap((request) =>
            request.login === undefined ? [] : [request.login],
          ),
          labels: entry.labels.map((label) => label.name),
          branch: entry.headRefName,
          updatedAt: entry.updatedAt,
        }),
      ),
  );
}

function gitHubIssuesOf(standardOutput: string): Result.Result<ForgeItem[], ForgeFailure> {
  return Result.map(decodedOutput(standardOutput, Schema.Array(GitHubIssueListing)), (listed) =>
    listed.map((entry) =>
      forgeItem({
        kind: "issue",
        number: entry.number,
        title: entry.title,
        state: entry.state === "OPEN" ? "open" : "closed",
        isDraft: false,
        url: entry.url,
        author: entry.author?.login,
        assignees: entry.assignees.map((assignee) => assignee.login),
        reviewers: [],
        labels: entry.labels.map((label) => label.name),
        branch: undefined,
        updatedAt: entry.updatedAt,
      }),
    ),
  );
}

function gitHubViewerOf(standardOutput: string): Result.Result<string, ForgeFailure> {
  return Result.map(decodedOutput(standardOutput, GitHubViewer), (viewer) => viewer.login);
}

function gitLabMergeRequestsOf(standardOutput: string): Result.Result<ForgeItem[], ForgeFailure> {
  return Result.map(
    decodedOutput(standardOutput, Schema.Array(GitLabMergeRequestListing)),
    (listed) =>
      listed.map((entry) =>
        forgeItem({
          kind: "pullRequest",
          number: entry.iid,
          title: entry.title,
          state: Match.value(entry.state).pipe(
            Match.whenOr("opened", "locked", () => "open" as const),
            Match.when("merged", () => "merged" as const),
            Match.when("closed", () => "closed" as const),
            Match.exhaustive,
          ),
          isDraft: entry.draft,
          url: entry.web_url,
          author: entry.author?.username,
          assignees: usernames(entry.assignees),
          reviewers: usernames(entry.reviewers),
          labels: entry.labels,
          branch: entry.source_branch,
          updatedAt: entry.updated_at,
        }),
      ),
  );
}

function gitLabIssuesOf(standardOutput: string): Result.Result<ForgeItem[], ForgeFailure> {
  return Result.map(decodedOutput(standardOutput, Schema.Array(GitLabIssueListing)), (listed) =>
    listed.map((entry) =>
      forgeItem({
        kind: "issue",
        number: entry.iid,
        title: entry.title,
        state: entry.state === "closed" ? "closed" : "open",
        isDraft: false,
        url: entry.web_url,
        author: entry.author?.username,
        assignees: usernames(entry.assignees),
        reviewers: [],
        labels: entry.labels,
        branch: undefined,
        updatedAt: entry.updated_at,
      }),
    ),
  );
}

function gitLabViewerOf(standardOutput: string): Result.Result<string, ForgeFailure> {
  return Result.map(decodedOutput(standardOutput, GitLabViewer), (viewer) => viewer.username);
}
