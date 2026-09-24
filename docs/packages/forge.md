# @janela/forge

Layer 3, daemon side: pull-request state and check rollups, read by running the
user's own `gh` and `glab`. It asks for no token, stores none, and implements no
forge API client — AGENTS.md non-negotiable 3. It may not own credentials, block
a request, or import `@janela/git`: the two are peers, and the subprocess
plumbing they share lives in `@janela/support/process`.

Nothing waits on it. A refresh is network-bound and publishes when it arrives;
see [`performance.md`](../performance.md) § Interaction, where forge is named as
"best effort, never awaited" and as never being on a path anything waits for.

## Absence is the answer, not an error

No CLI on `PATH`, a logged-out CLI, no pull request for the branch, an
enterprise host we cannot reach, a JSON field GitHub renamed — every one of them
resolves to `undefined` and logs a failure *class*. None becomes an error
banner, and none puts a stderr line in front of a person
([`conventions.md`](../conventions.md) § Errors, AGENTS.md non-negotiables 3 and
10). Rendering an optional feature's unavailability as an error is how a
nice-to-have becomes an irritation.

So failures here are *values*: `ForgeReadFailed` is raised inside the Effect
program and mapped to absence at the package boundary, never thrown at a caller
and never discarded into a void effect. The one exception is
`PullRequestUnavailable`, below, which answers a thing the user asked for.

The output is not the log. A pull request's title, branch and URL, and the
repository's own name, are the user's private data, and the daemon writes to the
same system log the app does. What is logged is `{ forge, cli, subcommand,
failure }` plus an `exitCode` when the CLI gave one — a shape, never a payload
(`conventions.md` § Logging, [`support.md`](support.md) § log.ts).

## index.ts

The value types — `ForgeState`, `PullRequestSummary`, `CheckRollup`, `ForgeItem`,
`ForgeItems` — live in `@janela/core` (`forge.ts`), because they cross the socket
and `@janela/protocol` cannot see this package. `ForgeServing` is the contract
here, and every field of `ForgeState` is optional
because the CLI may be missing, logged out, rate-limited or pointed somewhere
unreachable. `ForgeState` is not a domain entity: a pull request is not
something Janela owns, and modelling one would make us look like we did. It
hangs off a session as a cached value with a timestamp, never as a source of
truth.

`isAvailable` is called before anything is offered. A `false` hides a feature;
it never shows a broken one.

`items` answers the Inbox for one project: its pull or merge requests, its issues,
and the signed-in login, read concurrently. Each of the three is absence on its
own — a rate-limited issue list still leaves the pull requests — and only both
lists failing makes the whole answer `undefined`, which the Inbox reads as "this
CLI could not be used for this repository", never as an empty inbox. It lists by
last update across every state, so the Inbox can offer merged and closed as well as
open. Only identifying metadata is asked for; no body, comment or diff is ever
fetched, because the Inbox never shows one.

`pullRequestBranch` hands back a branch *name* so a worktree can be created from
it. Never `gh pr checkout`, which would move the user's own checkout — that is
the whole reason the method returns a string instead of doing the work.

`test-fakes.ts` is deliberately not re-exported here: a fake on a public API is
a fake somebody ships.

## forge-service.ts

### What is invoked, and why those

| Purpose | argv | Working directory |
| --- | --- | --- |
| Session state, GitHub | `gh pr view [branch] --json <fields>` | the session's directory |
| Session state, GitLab | `glab mr view [branch] --output json` | the session's directory |
| Head branch of a PR | `gh pr view <n> --json headRefName,isCrossRepository` | the project's directory |
| Head branch of an MR | `glab mr view <n> --output json` | the project's directory |
| Inbox, GitHub | `gh pr list` / `gh issue list --state all --search sort:updated-desc --limit 50 --json <fields>` | the project's directory |
| Inbox, GitLab | `glab mr list` / `glab issue list --all --order updated_at --sort desc --per-page 50 --output json` | the project's directory |
| Signed-in login | `gh api user` / `glab api user` | the project's directory |
| Availability | `gh auth status` / `glab auth status` | `HOME` |

A worktree-backed session names its branch; a session in the project's own
directory passes no positional argument and lets the CLI resolve whatever is
checked out there.

The GitHub `--json` field lists are `Object.keys(...)` of the schemas that decode
the answer, so argv and decoder cannot drift: a field added to the schema is
asked for, and a field renamed by GitHub comes back as `unknown json field`,
which is classified as `unknownShape` rather than a generic exit. `glab` has no
field list — `--output json` returns the whole merge request — and it prints its
error JSON on *stdout* with a human banner on stderr, so both halves are
classified together.

Availability runs from `HOME` rather than a repository, because it asks about the
CLI's login and not about a project. `glab auth status` with no repository
context validates *every* configured instance and fails if any one does, so a
stale enterprise host hides the feature. That is the conservative side of "a
`false` hides a feature; it never shows a broken one".

The executable is resolved per call rather than remembered: a user may install
`gh` while the daemon is running, and a `PATH` walk once a minute is cheaper
than being wrong until a restart.

### Bounds

`MAXIMUM_FORGE_OUTPUT_CHARACTERS` is 1 MiB of JS string length, and stdout past
it is a failure rather than data. `@janela/support/process` collects output whole
and caps nothing, which is safe only while its callers keep it that way; a
`gh pr view` answer is a few kilobytes, so a megabyte of it means something else
is on the other end. The check runs *before* the success check on purpose: a
megabyte of valid JSON is still something we refuse to hold (AGENTS.md
non-negotiable 9).

`FORGE_LIST_LIMIT` is 50 per list per project: the 50 most recently updated pull
requests and the 50 most recently updated issues. An open item nobody has touched
while fifty others moved falls out of the Inbox; that is the price of a bounded
read, and the forge's own page is one click away.

The 15 s bound (`DEFAULT_FORGE_TIMEOUT_MS`) is enforced by the subprocess runner
through `ProcessRequest.timeoutMs`, which kills the child and reports
`timedOut`. There is deliberately no second `Effect.timeout` around it: an
Effect-side interrupt would abandon a live `gh` process rather than end it.

`FORGE_REFRESH_INTERVAL_MS` is 60 s and is how long an answer — including "no" —
stands before we ask again. Both caches store the *promise*, which is what makes
two concurrent reads one process: a second caller arriving before the first
resolves joins it instead of spawning its own. Failures are cached exactly like
successes, so a logged-out user does not trigger `gh` on every render. Both
caches are swept on every read, so they stay bounded by what is live rather than
by what has ever been asked. The Inbox lists are cached per project the same way.
`pullRequestBranch` is **not** cached: it is a user
action, and answering it from a minute-old read would create a worktree from a
branch that has since moved.

### Failure classes

`ForgeReadFailed` is a `Data.TaggedError` carrying a tagged `reason`, the shape
`FrameError` in `@janela/protocol` established. Each reason is a
`Data.TaggedClass` whose tag is the string that reaches the log, so log output
did not move when the string union became classes. Branch with `Match.tag`,
`Effect.catchTag` or `Predicate.isTagged`, never by reading `_tag`;
`forgeFailureLabel` turns a reason into its log field.

| Reason | Tag | Means | Level |
| --- | --- | --- | --- |
| `MissingBinary` | `missingBinary` | `which` found nothing on the captured `PATH`; the feature is absent, not broken | info |
| `SpawnFailure` | `spawnFailure` | the process never started | info |
| `ReadTimedOut` | `timeout` | the runner killed it at `timeoutMs` | warning |
| `OutputTooLarge` | `outputTooLarge` | stdout exceeded the cap | warning |
| `NotLoggedIn` | `notLoggedIn` | the CLI is present and has no usable credential | info |
| `RateLimited` | `rateLimited` | the forge said so | info |
| `NetworkFailure` | `networkFailure` | DNS, TLS, connect or an unreachable enterprise host | info |
| `NoPullRequest` | `noPullRequest` | nothing open for this branch, or no such number | info |
| `CrossRepository` | `crossRepository` | the head branch lives in a fork | info |
| `MalformedOutput` | `malformedOutput` | stdout was not JSON | warning |
| `UnknownShape` | `unknownShape` | JSON, but not the fields or values we asked for | warning |
| `UnclassifiedExit` | `exit` | a non-zero exit we could not classify | info |

The four warnings are the ones that mean *our* bug or their API changing under
us. Everything else is `info`: a user who is simply not logged in is not a
problem and must not read like one.

Classification is substring matching on a human-readable message, first match
winning. It is not pretty, and it is what shelling out to somebody else's tool
costs. `unknown json field` is checked first because it is the only signature
that tells us we are wrong.

A fork's head branch is refused rather than resolved: it is not on our `origin`,
so there is nothing to cut a worktree from, and refusing beats creating a fresh
branch off `HEAD` and calling it the pull request.

### Decoding

`gh --json` and `glab --output json` are somebody else's API, so they are an
untrusted boundary and get a `Schema`, not a hand-rolled walk over an untyped
object. Each invocation decodes twice over one parse: `fromJsonString` first, so
"not JSON at all" stays `malformedOutput`, then the struct, so "JSON with the
wrong fields" stays `unknownShape`. Only the second of those says our field list
is wrong, which is why they are not one class.

`__typename` discriminates GitHub's `statusCheckRollup` elements: `CheckRun` is
an Actions job, carrying `status` plus a `conclusion` that is `null` until it
finishes, and `StatusContext` is a commit status posted by an external service,
carrying only `state`. The two are a `Schema.Union` matched with
`Match.discriminator("__typename")`, so a third element type is a decode failure
— an API change we would rather see in the log than average into a green tick.

The rollup is in precedence order: a failure outranks anything unfinished, which
outranks a pass. No elements at all is `none` rather than `passing`, because a
pull request with no CI configured has not passed anything. An unrecognised
`conclusion` string is not a failure; the failed set is a closed literal list.

Every URL is checked to be `http(s)` at decode time, so the only thing a client is
ever handed to open is a web page; a list with one odd element is `unknownShape`
as a whole, logged loudly, rather than half-believed. `reviewRequests` entries
without a `login` are teams, and are dropped rather than refused.

GitLab's `locked` state is still `open` to a reader — locked to further
discussion, but open work. An unrecognised pipeline status decodes to `none`
rather than a refusal: GitLab adds pipeline states, and the merge request itself
decoded fine. An absent or null `head_pipeline` is `none`; a `head_pipeline`
without a `status` is `unknownShape`. `source_project_id !== target_project_id`
is how GitLab says "fork".

### PullRequestUnavailable

Lives here rather than in `@janela/session`'s errors so the session side's change
stays inside the one branch it owns, and keeps its `UserFacingError` base because
that `instanceof` crosses the daemon/client decision. It is the only sentence
this package puts in front of a person, and it earns that because "new session
from this pull request" is something the user asked for: silence would leave a
dialog that did nothing. The failure *class* is in the log; this is the sentence.

## test-fakes.ts

Forge is faked by design ([`testing.md`](../testing.md)): what is faked is the
*subprocess*, because the logic under test is the decision — which argv we build,
how a failure is classified, what we log, and what the cache does with time.
`gh` and `glab` themselves are exercised by a real-CLI smoke run, not by a test
that would only prove our assumptions. The failure cases matter more than the
success one, and each of binary missing, logged out, malformed output and timeout
has a test asserting it renders as absence.

`ScriptedProcesses.hold()` blocks every subsequent `run` until the returned
function is called. That is what proves two concurrent `state()` calls share one
invocation without a timer: the first cannot finish, so a second invocation would
have to be a second entry in `invocations`. An `Error` in `outcomes` rejects,
which is how a spawn failure arrives.

`recordingLogger` is structural so a test can assert that we log shapes rather
than content — every failure test re-serialises the records and refuses to find
the title, the URL, the branch, the session directory or the CLI's own words in
them. `manualClock` exists so the cache's expiry is asserted rather than slept
through.

`@janela/session` has its own copy of these fakes rather than importing them:
forge sits below session, and a test-only import upward would be a dependency
edge that `scripts/layers.ts` would have to allow.
