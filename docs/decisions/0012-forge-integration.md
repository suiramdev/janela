# 0012. GitHub and GitLab through the user's `gh` and `glab`

- **Status:** Accepted
- **Date:** 2026-08-19

## Context

A worktree-backed session is a branch. The two questions a developer asks about a
branch are "is there a PR for this?" and "is CI green?", and today they answer them
by leaving the app.

The scope worth serving is small and read-mostly:

- the pull/merge request for a session's branch — number, title, state, draft flag
- a check rollup: passing, failing, running, or nothing
- one write action: **start a session from a PR**, which is `git worktree add` on
  the PR's branch and nothing more

Doing that means calling GitHub's or GitLab's API, which means credentials. That is
the entire difficulty. The options:

**Our own OAuth app.** Register a GitHub App and a GitLab application, run a
callback, store tokens in the Keychain, refresh them, handle revocation, and repeat
the exercise for every GitHub Enterprise and self-hosted GitLab install. It is
weeks of work, it makes Janela a credential holder — a thing worth attacking — and
it asks the user to grant a second set of permissions for data their own tools
already have.

**Ask for a personal access token.** Cheaper. Also asks users to paste a long-lived
credential into a text field, which is precisely the habit the ecosystem has spent
five years training people out of, and we would then be storing it.

**Use the tools the user already has.** `gh` and `glab` are near-universal on
developer machines, are already authenticated — including to enterprise hosts,
including through SSO — and both emit JSON on request. `gh pr view --json` and
`glab mr view --output json` are stable, documented interfaces.

This is the same argument [ADR 0007](0007-git-integration.md) makes about git: the
user's machine is configured for their tools, and a reimplementation diverges
silently in someone else's environment.

## Decision

Forge integration shells out to **`gh`** and **`glab`**, through the shared
`ProcessRunning` in `JanelaSupport`, inside a `JanelaForge` module that sits beside
`JanelaGit` in the capability layer.

- **Janela never holds a credential.** No token field, no Keychain item, no OAuth
  flow. If the user is logged in, it works; if not, the feature is absent.
- **Detection is per project.** The remote URL determines the forge; `gh`/`glab`
  presence on `PATH` determines availability. Both are cached on the project's
  `GitDescriptor` and re-checked lazily, never on the launch path.
- **All reads are JSON with an explicit field list.** `gh pr view --json
  number,title,state,isDraft,url,statusCheckRollup`. Never scrape human output.
- **Everything is cached with a timestamp** on the session's `ForgeState`, refreshed
  when a session becomes visible and at most once a minute per branch. Rate limits
  are the user's, and we spend them sparingly.
- **Failure is silence.** Missing binary, logged out, rate limited, offline, or an
  enterprise host we cannot reach all render as "no PR information". Never an error
  banner, never a dialog, never a retry loop. The log records the failure class,
  never the output.
- **One write action:** `.fromPullRequest` as a `SessionCreationRequest` case. It
  resolves the PR's head branch with `gh`, then creates a worktree with git. We do
  not use `gh pr checkout`, because it mutates the current checkout, and the whole
  point is that we do not touch the user's working directory.
- **Everything else opens a browser.** Reviewing, commenting, merging, approving:
  `open <url>`. See [`../product.md`](../product.md) § Non-goals — not a forge
  client.

## Consequences

**Good.** Zero credential surface. Janela cannot leak a token it never had, and a
security review of this feature is a review of an argv array.

**Good.** Enterprise, self-hosted GitLab, SSO, and unusual host configurations work
on day one, because `gh`/`glab` already solved them and the user already configured
them.

**Good.** The feature is genuinely optional. Users without `gh` see an app with no
forge column and no nagging, which is the correct experience for someone who does
not want it.

**Bad.** A dependency on a binary we do not ship and cannot version. `gh`'s JSON
field names are a public interface but not a promised-forever one; a rename breaks
us. Mitigated by requesting an explicit field list — an unknown field is an error
we can detect and degrade on, rather than a silently missing value.

**Bad.** Subprocess latency, ~200–400 ms per call including network. Acceptable
because nothing waits on it: forge state renders when it arrives and is absent
before that.

**Bad.** We inherit whatever the user's `gh` is authenticated as. If they are
logged into a different account than the repository expects, we show what `gh`
shows. That is arguably correct, and it is certainly explainable.

**Bad.** No GitHub Enterprise-only features, no GitLab-only niceties. The
intersection of the two CLIs is the feature set, deliberately.

## Alternatives considered

**Our own OAuth app / GitHub App.** The "proper" answer, and what a product with a
backend would do. Rejected: weeks of work, a credential store to defend, and a
second permission grant for data the user's own tooling already has. Reconsider
only if Janela ever gains a server, at which point this ADR is superseded.

**Personal access token in the Keychain.** Rejected: it trains a bad habit, it
handles enterprise SSO poorly, and it still leaves us holding a secret.

**Read `gh`'s own credentials** from `~/.config/gh/hosts.yml` and call the API
directly. Removes the subprocess cost. Rejected firmly: reading another
application's credential store is a hostile pattern, it breaks the moment `gh`
changes storage, and it converts "we never hold a token" into "we hold someone
else's token".

**Swift GitHub/GitLab API clients.** A dependency per forge, plus the credential
problem unsolved. Rejected on both counts.

**Nothing — open the browser for everything.** The honest minimum, and it remains
the fallback for every action beyond the two questions above. Rejected as the whole
answer because "is CI green?" is a glance, and making it a context switch is the
friction this app exists to remove.

## Revisit when

- `gh` or `glab` ships a breaking change to the JSON we request. The fix is a field
  list, not an architecture.
- Users ask for a third forge (Bitbucket, Gitea, Forgejo). The shape generalises —
  a forge is a binary, a subcommand, and a field mapping — but each one is a new
  dependency on someone else's CLI and needs its own decision.
- Janela gains a server component, which changes the credential calculus entirely.
