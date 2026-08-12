# 0008. Unsandboxed, hardened, notarized, outside the App Store

- **Status:** Accepted
- **Date:** 2026-08-12

## Context

Janela's purpose is to run the user's own tools — their login shell, their
compilers, their coding agents — in directories the user chooses, with the user's
own environment.

The App Sandbox cannot express that. It is designed to constrain an app to
declared resources, and Janela's declared resource is "any executable, any path".
The available workarounds each break something:

- **Security-scoped bookmarks per repository.** Would work for paths the user picks
  in an open panel, but a `cd ..` in a terminal, a build writing to a sibling
  directory, or an agent reading `~/.config` all fall outside. The terminal would
  be constrained in ways a terminal never is.
- **A privileged helper.** Moves the unsandboxed code somewhere else without
  removing it, and adds an XPC boundary on the hot path.
- **`com.apple.security.inherit` on children.** Sandboxes the child too, which is
  precisely wrong: the user's compiler needs to write to the user's disk.

The security argument for sandboxing is also weaker than usual here. A sandbox
protects the user from the *app*. Janela's child processes are the user's own
tools, running with the user's authority, which they could equally start from
Terminal.app — which is itself not sandboxed.

## Decision

- **App Sandbox: off.**
- **Hardened Runtime: on** (required for notarization), with
  `com.apple.security.cs.disable-library-validation` so we can spawn and load the
  user's unsigned tooling.
- **Distribution:** Developer ID signed, notarized, stapled, direct download.
  **Not** the Mac App Store — the sandbox is mandatory there, so this decision
  forecloses that channel.
- **No network entitlement is requested.** Janela does not phone home.

## Consequences

**Good.** Terminals behave like terminals. No permission prompts mid-session, no
mysterious failures when a build touches a path outside a bookmark.

**Good.** Direct distribution means we control release cadence and there is no
review process to design around.

**Bad.** No Mac App Store. Accepted deliberately, and it is the hardest part of
this decision to reverse.

**Bad.** We must run notarization ourselves, including signing credentials in CI.
Those live outside the repository; `.gitignore` covers `*.p12` and
`notarization-credentials.json`, and `DEVELOPMENT_TEAM` belongs in a local,
gitignored `Secrets.xcconfig`.

**Bad.** Users still see TCC prompts for Desktop/Documents/Downloads, triggered by
*child* processes but attributed to Janela. `Info.plist` usage strings say so
honestly rather than pretending Janela wants the access itself.

**Note.** Some agents run their own sandboxing — Codex defaults to a Seatbelt
`workspace-write` profile
([`../research/agents-and-git.md`](../research/agents-and-git.md) § 746). That is
the agent's business and we neither add to nor subtract from it. It is also the
right layer for that control: per-tool, user-configured, not imposed by the
terminal.

## Alternatives considered

**Sandboxed with security-scoped bookmarks.** Rejected above: it constrains the
terminal in ways that break ordinary developer work, and the failures are confusing
rather than explicit.

**Sandboxed app + unsandboxed privileged helper.** Rejected: the same code runs
unsandboxed either way, and we would pay an XPC hop plus a much more complex
install and update story for a security boundary that mostly protects nothing.

## Revisit when

- Apple provides an entitlement that expresses "developer tool that runs user
  processes" — there has been movement in this area for other categories.
- Mac App Store distribution becomes a business requirement, at which point this
  ADR is superseded and a large amount of work follows.
