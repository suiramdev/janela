import type { Forge, Project, Session, SessionID } from "@janela/core";
import { forgeExecutable, instant, worktreeOf } from "@janela/core";
import type { Logger } from "@janela/support";
import { UserFacingError } from "@janela/support";
import { processRunner, type ProcessRunning } from "@janela/support/process";

import type { CheckRollup, ForgeServing, ForgeState, PullRequestSummary } from "./index.ts";

/**
 * `ForgeServing` over the user's own `gh` and `glab`.
 *
 * Three rules shape every line below, and none of them is about GitHub:
 *
 * 1. **Absence is the normal answer.** No CLI, not logged in, no pull request,
 *    an enterprise host we cannot reach, a JSON field GitHub renamed — every one
 *    of those resolves to `undefined` and logs a failure *class*. None of them
 *    ever becomes an error banner, and none of them ever puts a stderr line in
 *    front of a person (AGENTS.md § non-negotiables 3 and 10).
 * 2. **The output is not the log.** A pull request's title, branch, URL and the
 *    repository's own name are the user's private data, and the daemon writes to
 *    the same system log the app does. What we log is `{ forge, cli, subcommand,
 *    failure }` — a shape, never a payload.
 * 3. **Nothing here is a source of truth.** Every answer is a cache with a
 *    timestamp, and the cache exists so a logged-out user does not pay for a
 *    process per render.
 */

export const DEFAULT_FORGE_TIMEOUT_MS = 15_000;

/** How long an answer — including "no" — stands before we ask again. */
export const FORGE_REFRESH_INTERVAL_MS = 60_000;

/**
 * JS string length of stdout past which the read is a failure, not data.
 *
 * `@janela/support/process` collects output whole and caps nothing, which is safe
 * only while its callers keep it that way. A `gh pr view` answer is a few
 * kilobytes; a megabyte of it means something else is on the other end.
 */
export const MAXIMUM_FORGE_OUTPUT_CHARACTERS = 1_048_576;

/**
 * Why a read produced nothing.
 *
 * A closed vocabulary rather than a message, because this is what gets logged:
 * the class is the diagnostic, and the CLI's own words stay out of our log.
 */
export type ForgeFailure =
  /** `which` found nothing on the captured `PATH`. The feature is absent, not broken. */
  | "missingBinary"
  /** The process never started. */
  | "spawnFailure"
  | "timeout"
  | "outputTooLarge"
  | "notLoggedIn"
  | "rateLimited"
  | "networkFailure"
  | "noPullRequest"
  /** The head branch lives in a fork, so it is not on `origin` and we cannot cut a worktree from it. */
  | "crossRepository"
  /** stdout was not JSON. */
  | "malformedOutput"
  /** JSON, but not the fields or values we asked for — which is how an API change arrives. */
  | "unknownShape"
  /** A non-zero exit we could not classify. */
  | "exit";

export interface ForgeServiceOptions {
  /**
   * The complete child environment, and the `PATH` the CLI is resolved from.
   * Defaults to this process's, filtered to defined values.
   */
  readonly environment?: Readonly<Record<string, string>>;
  readonly processes?: ProcessRunning;
  readonly timeoutMs?: number;
  /** Where shapes go. Absent means silent, which is the right default for a library. */
  readonly log?: Logger;
  /** The cache's one clock. */
  readonly clock?: () => number;
}

/**
 * Thrown when a pull request the user named resolved to nothing.
 *
 * Lives here rather than in `@janela/session`'s errors so the session side's
 * change stays inside the one branch it owns. The failure *class* is in the log;
 * this is the sentence a person reads.
 */
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

/** Everything `state()` reads. Pinned as a constant because a rename here is a silent regression. */
const GITHUB_STATE_FIELDS = ["number", "title", "state", "isDraft", "url", "statusCheckRollup"];

const SILENT: Logger = {
  debug: () => {},
  info: () => {},
  notice: () => {},
  warning: () => {},
  error: () => {},
};

interface CacheEntry<T> {
  readonly refreshedAt: number;
  readonly result: Promise<T>;
}

type Invocation =
  | { readonly ok: true; readonly standardOutput: string }
  | { readonly ok: false; readonly failure: ForgeFailure; readonly exitCode?: number };

export function forgeService(options?: ForgeServiceOptions): ForgeServing {
  const processes = options?.processes ?? processRunner();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_FORGE_TIMEOUT_MS;
  const log = options?.log ?? SILENT;
  const clock = options?.clock ?? Date.now;
  const environment: Readonly<Record<string, string>> =
    options?.environment ??
    Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );

  // Keyed by session and by forge respectively. Both are swept on every read, so
  // they stay bounded by what is live rather than by what has ever been asked.
  const states = new Map<SessionID, CacheEntry<ForgeState | undefined>>();
  const availability = new Map<Forge, CacheEntry<boolean>>();

  /**
   * The answer for `key`, reading only when the last one has expired.
   *
   * Storing the *promise* is what makes two concurrent reads one process: a
   * second caller arriving before the first resolves joins it instead of
   * spawning its own. Failures are cached exactly like successes — a logged-out
   * user must not trigger `gh` on every render.
   */
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

  /**
   * One bounded invocation, classified.
   *
   * The executable is resolved per call rather than remembered: a user may
   * install `gh` while the daemon is running, and a `PATH` walk once a minute is
   * cheaper than being wrong until a restart.
   */
  const invoke = async (
    cli: string,
    args: readonly string[],
    workingDirectory: string,
  ): Promise<Invocation> => {
    const executable = await processes.which(cli, environment["PATH"] ?? "/usr/bin:/bin");
    if (executable === undefined) return { ok: false, failure: "missingBinary" };

    let outcome;
    try {
      outcome = await processes.run({
        executable,
        arguments: args,
        workingDirectory,
        environment,
        timeoutMs,
      });
    } catch {
      // The error carries a path we would rather not log, and the recovery is the
      // same either way: there is no state.
      return { ok: false, failure: "spawnFailure" };
    }

    if (outcome.timedOut) return { ok: false, failure: "timeout" };
    // Before the success check on purpose: a megabyte of *valid* JSON is still
    // something we refuse to hold.
    if (outcome.standardOutput.length > MAXIMUM_FORGE_OUTPUT_CHARACTERS) {
      return { ok: false, failure: "outputTooLarge" };
    }
    if (!outcome.succeeded) {
      // glab prints its error JSON on stdout and a human banner on stderr, so
      // both halves are classified together.
      return {
        ok: false,
        failure: classifyFailure(`${outcome.standardError}\n${outcome.standardOutput}`),
        exitCode: outcome.exitCode,
      };
    }
    return { ok: true, standardOutput: outcome.standardOutput };
  };

  const logFailure = (
    forge: Forge,
    subcommand: string,
    failure: ForgeFailure,
    exitCode?: number,
  ): void => {
    const fields = {
      forge,
      cli: forgeExecutable(forge),
      subcommand,
      failure,
      ...(exitCode === undefined ? {} : { exitCode }),
    };
    // Our own bug or their API changing is worth a warning; a user who is simply
    // not logged in is not a problem and must not read like one.
    if (LOUD_FAILURES[failure] === true) log.warning("forge read failed", fields);
    else log.info("forge read failed", fields);
  };

  /** Parses, decodes, and turns every disappointment into a logged class. */
  const decoded = <T>(
    forge: Forge,
    subcommand: string,
    standardOutput: string,
    decode: (value: unknown) => T | undefined,
  ): T | undefined => {
    let value: unknown;
    try {
      value = JSON.parse(standardOutput) as unknown;
    } catch {
      logFailure(forge, subcommand, "malformedOutput");
      return undefined;
    }
    const result = decode(value);
    if (result === undefined) {
      logFailure(forge, subcommand, "unknownShape");
      return undefined;
    }
    log.debug("forge read", { forge, cli: forgeExecutable(forge), subcommand });
    return result;
  };

  const readState = async (
    project: Project,
    session: Session,
    at: number,
  ): Promise<ForgeState | undefined> => {
    const host = project.git?.forge;
    if (host === undefined) return undefined;
    const subcommand = host === "gitHub" ? "pr view" : "mr view";
    // A worktree session names its branch; a session in the project's own
    // directory lets the CLI resolve whatever is checked out there.
    const selector = worktreeOf(session)?.branch;
    const positional = selector === undefined ? [] : [selector];
    const args =
      host === "gitHub"
        ? ["pr", "view", ...positional, "--json", GITHUB_STATE_FIELDS.join(",")]
        : ["mr", "view", ...positional, "--output", "json"];

    const outcome = await invoke(forgeExecutable(host), args, session.directory);
    if (!outcome.ok) {
      logFailure(host, subcommand, outcome.failure, outcome.exitCode);
      return undefined;
    }

    const read = decoded(host, subcommand, outcome.standardOutput, (value) =>
      host === "gitHub" ? decodeGitHub(value) : decodeGitLab(value),
    );
    if (read === undefined) return undefined;

    return {
      host,
      pullRequest: read.pullRequest,
      checks: read.checks,
      refreshedAt: instant(new Date(at)),
    };
  };

  return {
    isAvailable(host: Forge): Promise<boolean> {
      return cached(availability, host, clock(), async () => {
        // Run from `HOME`, not a repository: this asks about the CLI's login, not
        // about a project. Note that `glab auth status` with no repository
        // context validates *every* configured instance and fails if any one
        // does, so a stale enterprise host hides the feature — the conservative
        // side of "a false here hides a feature; it never shows a broken one".
        const outcome = await invoke(
          forgeExecutable(host),
          ["auth", "status"],
          environment["HOME"] ?? "/",
        );
        if (outcome.ok) return true;
        logFailure(host, "auth status", outcome.failure, outcome.exitCode);
        return false;
      });
    },

    state(request: { readonly project: Project; readonly session: Session }) {
      // Both exits are silent and spawn nothing: an unrecognised remote and a
      // switched-off integration are the same thing from here.
      if (request.project.git?.forge === undefined) return Promise.resolve(undefined);
      if (!request.project.settings.isForgeEnabled) return Promise.resolve(undefined);

      const at = clock();
      return cached(states, request.session.id, at, () =>
        readState(request.project, request.session, at),
      );
    },

    async pullRequestBranch(request: {
      readonly project: Project;
      readonly number: number;
    }): Promise<string | undefined> {
      const host = request.project.git?.forge;
      if (host === undefined) return undefined;
      // Not cached: this is a user action, and answering it from a minute-old
      // read would create a worktree from a branch that has since moved.
      const subcommand = host === "gitHub" ? "pr view" : "mr view";
      const number = String(request.number);
      const args =
        host === "gitHub"
          ? ["pr", "view", number, "--json", "headRefName,isCrossRepository"]
          : ["mr", "view", number, "--output", "json"];

      const outcome = await invoke(forgeExecutable(host), args, request.project.directory);
      if (!outcome.ok) {
        logFailure(host, subcommand, outcome.failure, outcome.exitCode);
        return undefined;
      }

      const head = decoded(host, subcommand, outcome.standardOutput, (value) =>
        host === "gitHub" ? decodeGitHubHead(value) : decodeGitLabHead(value),
      );
      if (head === undefined) return undefined;
      if (head.isCrossRepository) {
        // A fork's branch is not on our `origin`, so there is nothing to cut a
        // worktree from. Refusing beats creating a fresh branch off HEAD and
        // calling it the pull request.
        logFailure(host, subcommand, "crossRepository");
        return undefined;
      }
      return head.branch;
    },
  };
}

// MARK: - Classification

/** Failures worth a warning: our bug, or their API changing under us. */
const LOUD_FAILURES: Readonly<Partial<Record<ForgeFailure, true>>> = {
  unknownShape: true,
  malformedOutput: true,
  outputTooLarge: true,
  timeout: true,
};

/**
 * A failure class from what the CLI said, first match winning.
 *
 * Substring matching on a human-readable message is not pretty, and it is what
 * shelling out to somebody else's tool costs. `unknown json field` comes first
 * because it is the only signature that tells us *we* are wrong: it fires when a
 * field we ask for has been renamed, and we would rather notice that than log it
 * as a generic exit for a release.
 */
const FAILURE_SIGNATURES: readonly (readonly [ForgeFailure, readonly string[]])[] = [
  ["unknownShape", ["unknown json field"]],
  ["notLoggedIn", ["gh auth login", "glab auth login", "not logged in", "no token found", "401"]],
  ["rateLimited", ["rate limit", "429"]],
  [
    "networkFailure",
    [
      "dial tcp",
      "no such host",
      "connection refused",
      "network is unreachable",
      "i/o timeout",
      "tls handshake",
      "error connecting to",
      "temporary failure in name resolution",
    ],
  ],
  [
    "noPullRequest",
    [
      "no pull requests found",
      "could not resolve to a pullrequest",
      "no open merge request",
      "404",
    ],
  ],
];

function classifyFailure(text: string): ForgeFailure {
  const haystack = text.toLowerCase();
  for (const [failure, signatures] of FAILURE_SIGNATURES) {
    if (signatures.some((signature) => haystack.includes(signature))) return failure;
  }
  return "exit";
}

// MARK: - Decoding

/**
 * The decoders are total functions over `unknown` and every one of them can say
 * "no". That is deliberate: `gh --json` and `glab --output json` are somebody
 * else's API, and the honest failure mode for a shape we do not recognise is
 * absence plus a logged `unknownShape`, not a partially-filled value.
 */
interface DecodedPullRequest {
  readonly pullRequest: PullRequestSummary;
  readonly checks: CheckRollup;
}

interface DecodedHead {
  readonly branch: string;
  readonly isCrossRepository: boolean;
}

function objectOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, unknown>>;
}

function stringOf(from: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const value = from[name];
  return typeof value === "string" ? value : undefined;
}

function numberOf(from: Readonly<Record<string, unknown>>, name: string): number | undefined {
  const value = from[name];
  return typeof value === "number" ? value : undefined;
}

function booleanOf(from: Readonly<Record<string, unknown>>, name: string): boolean | undefined {
  const value = from[name];
  return typeof value === "boolean" ? value : undefined;
}

const GITHUB_STATES: Readonly<Record<string, PullRequestSummary["state"] | undefined>> = {
  OPEN: "open",
  MERGED: "merged",
  CLOSED: "closed",
};

/** Conclusions a person would read as "this went wrong". */
const GITHUB_FAILED_CONCLUSIONS: Readonly<Record<string, true | undefined>> = {
  FAILURE: true,
  TIMED_OUT: true,
  CANCELLED: true,
  ACTION_REQUIRED: true,
  STARTUP_FAILURE: true,
};

function decodeGitHub(value: unknown): DecodedPullRequest | undefined {
  const from = objectOf(value);
  if (from === undefined) return undefined;

  const number = numberOf(from, "number");
  const title = stringOf(from, "title");
  const isDraft = booleanOf(from, "isDraft");
  const url = stringOf(from, "url");
  const state = GITHUB_STATES[stringOf(from, "state") ?? ""];
  const rollup = from["statusCheckRollup"];
  if (
    number === undefined ||
    title === undefined ||
    isDraft === undefined ||
    url === undefined ||
    state === undefined ||
    !Array.isArray(rollup)
  ) {
    return undefined;
  }

  const checks = decodeGitHubRollup(rollup);
  if (checks === undefined) return undefined;
  return { pullRequest: { number, title, state, isDraft, url }, checks };
}

/**
 * The rollup, in precedence order: a failure outranks anything unfinished, which
 * outranks a pass. Nothing at all is `none` rather than `passing` — a pull
 * request with no CI configured has not passed anything.
 */
function decodeGitHubRollup(elements: readonly unknown[]): CheckRollup | undefined {
  let unfinished = false;

  for (const element of elements) {
    const from = objectOf(element);
    if (from === undefined) return undefined;

    switch (stringOf(from, "__typename")) {
      case "CheckRun": {
        const status = stringOf(from, "status");
        const conclusion = from["conclusion"];
        if (status === undefined) return undefined;
        // `null` while a run is in flight, a string once it finishes; anything
        // else is a shape we do not know.
        if (conclusion !== null && typeof conclusion !== "string") return undefined;
        if (typeof conclusion === "string" && GITHUB_FAILED_CONCLUSIONS[conclusion] === true) {
          return "failing";
        }
        if (status !== "COMPLETED") unfinished = true;
        break;
      }
      case "StatusContext": {
        const state = stringOf(from, "state");
        if (state === undefined) return undefined;
        if (state === "FAILURE" || state === "ERROR") return "failing";
        if (state === "PENDING" || state === "EXPECTED") unfinished = true;
        break;
      }
      default:
        // A third element type is an API change, and we would rather see it in
        // the log than average it into a green tick.
        return undefined;
    }
  }

  if (elements.length === 0) return "none";
  return unfinished ? "running" : "passing";
}

function decodeGitHubHead(value: unknown): DecodedHead | undefined {
  const from = objectOf(value);
  if (from === undefined) return undefined;
  const branch = stringOf(from, "headRefName");
  const isCrossRepository = booleanOf(from, "isCrossRepository");
  if (branch === undefined || branch === "" || isCrossRepository === undefined) return undefined;
  return { branch, isCrossRepository };
}

const GITLAB_STATES: Readonly<Record<string, PullRequestSummary["state"] | undefined>> = {
  opened: "open",
  // Locked to further discussion, but still open work.
  locked: "open",
  merged: "merged",
  closed: "closed",
};

const GITLAB_PIPELINE_STATUSES: Readonly<Record<string, CheckRollup | undefined>> = {
  success: "passing",
  skipped: "passing",
  failed: "failing",
  canceled: "failing",
  running: "running",
  pending: "running",
  created: "running",
  waiting_for_resource: "running",
  preparing: "running",
  scheduled: "running",
  manual: "running",
};

function decodeGitLab(value: unknown): DecodedPullRequest | undefined {
  const from = objectOf(value);
  if (from === undefined) return undefined;

  const number = numberOf(from, "iid");
  const title = stringOf(from, "title");
  const isDraft = booleanOf(from, "draft");
  const url = stringOf(from, "web_url");
  const state = GITLAB_STATES[stringOf(from, "state") ?? ""];
  if (
    number === undefined ||
    title === undefined ||
    isDraft === undefined ||
    url === undefined ||
    state === undefined
  ) {
    return undefined;
  }

  const checks = decodeGitLabPipeline(from["head_pipeline"]);
  if (checks === undefined) return undefined;
  return { pullRequest: { number, title, state, isDraft, url }, checks };
}

function decodeGitLabPipeline(value: unknown): CheckRollup | undefined {
  // Absent or null on a merge request nothing has run for yet.
  if (value === undefined || value === null) return "none";
  const from = objectOf(value);
  if (from === undefined) return undefined;
  const status = stringOf(from, "status");
  if (status === undefined) return undefined;
  // An unrecognised status is "none" rather than a refusal: GitLab adds pipeline
  // states, and the pull request itself decoded fine.
  return GITLAB_PIPELINE_STATUSES[status] ?? "none";
}

function decodeGitLabHead(value: unknown): DecodedHead | undefined {
  const from = objectOf(value);
  if (from === undefined) return undefined;
  const branch = stringOf(from, "source_branch");
  const source = numberOf(from, "source_project_id");
  const target = numberOf(from, "target_project_id");
  if (branch === undefined || branch === "" || source === undefined || target === undefined) {
    return undefined;
  }
  return { branch, isCrossRepository: source !== target };
}
