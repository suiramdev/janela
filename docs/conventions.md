# Conventions

How Janela's code is written. `AGENTS.md` has the short version; this is the
reasoning and the edge cases.

Formatting is not in here, because formatting is not a discussion:
`swift-format` decides, `.swift-format` configures it, and `make format` applies
it.

---

## Compiler settings we opted into

Set in `Packages/JanelaKit/Package.swift` and applied to every target.

### `swiftLanguageMode(.v6)`

Strict concurrency, checked. See
[`decisions/0003-concurrency-model.md`](decisions/0003-concurrency-model.md).

`@preconcurrency import` is permitted **only** for third-party modules that have
not adopted Swift 6 — in practice SwiftTerm, which compiles in Swift 5 mode. Each
use gets a comment naming the dependency and the condition under which it can be
removed.

### `ExistentialAny`

`any` is required on existentials: `any GitRunning`, not `GitRunning`. The keyword
makes the existential box visible at the call site, which is exactly where the
cost is.

### `MemberImportVisibility`

Using a member requires importing the module that defines it. So a file calling
`Logger.error` needs `import OSLog` even if it already imports something that
re-exports it.

This is stricter than it sounds and it will catch you. It is worth it: it makes
each file's real dependencies explicit and stops a module's API surface expanding
by accident.

### Not enabled: `InternalImportsByDefault`

Would require `public import Foundation` in every file exposing a Foundation type
in public API. The churn outweighs the benefit at this size. Reconsider if build
times become a problem.

---

## Naming

- **Types**: `UpperCamelCase`. Protocols describing a capability end in `-ing`
  (`GitRunning`, `WorktreeServing`, `TerminalEmulating`, `AttentionDelivering`);
  the concrete type drops it (`GitRunner`, `WorktreeService`).
- **Modules**: `Janela` + one noun. The prefix is deliberate — `Core` and
  `Terminal` are far too generic to be unqualified module names.
- **Domain nouns are used exactly as `domain-model.md` defines them.** A `Session`
  is not a terminal, a `Tab` is not a session, and nothing is a workspace. A type
  or property whose name disagrees with that document is a bug in one of the two,
  and the document wins unless you change it in the same PR.
- **`LiveTerminal`, not `Terminal`.** SwiftTerm exports a `Terminal`, and a
  same-named type inside the module that imports it is resolved by whichever
  import wins. The `Live` prefix marks the running object as distinct from its
  persistable `TerminalDescriptor`.
- **Booleans** read as assertions: `isPinned`, `hasUnseenAttention`,
  `startsAutomatically`.
- **No abbreviations** except universally understood ones (`id`, `url`, `pty`).
- `db` is allowed as a closure parameter, because GRDB names it that throughout
  its own API and docs; renaming locally would make our code read differently from
  every example. Configured in `.swiftlint.yml`.

---

## Types

**Prefer value types.** Everything in `JanelaCore` is a `Sendable` struct or enum.
Reference types appear when identity or observation is needed: `@Observable`
stores, actors owning a resource.

**Model states as enums with payloads**, not booleans plus optionals.
`SessionState.exited(code:)` cannot be confused with `.failed(message:)`, whereas
`isRunning`/`exitCode`/`errorMessage` has invalid combinations.

**Use typed identifiers.** `Identifier<Session>` is a phantom-typed wrapper, so a
`TerminalID` cannot be passed where a `SessionID` belongs. Free at runtime, and it
matters more now that the model has three nested levels whose ids are all UUIDs.

**Bound recursive types at the type level.** `SessionLayout.Pane` is `indirect` and
decoded from disk, so its depth limit is enforced in `init(from:)` rather than
documented in a comment. Any future recursive `Codable` gets the same treatment.

**Use typed throws** where the error set is closed: `throws(Failure)` on
`PseudoTerminal`. It documents the failures and removes a cast at the call site.

---

## Errors

Two categories, and the distinction is enforced by the type system:

- **`UserFacingError`** — shown to a person. `summary` is one short sentence with
  no error codes or jargon. `reason` and `recoverySuggestion` are optional.
- **Everything else** — logged, never surfaced raw. Wrap in `UnexpectedFailure`.

Never put `error.localizedDescription` or a git stderr dump in a dialog headline.
It produces a bug report, not a recovery path. Detailed output belongs in a
disclosure triangle or the log.

**Some failures are neither shown nor logged as errors — they are absences.** A
missing `gh`, a logged-out `gh`, or a forge request that timed out means the app
shows no pull-request information and says nothing at all. Rendering an optional
feature's unavailability as an error is how a nice-to-have becomes an irritation.
See [`decisions/0012-forge-integration.md`](decisions/0012-forge-integration.md).

**A failing automation command is shown in its own terminal, not in a dialog.**
The user gets the real output, scrollback included, which is strictly better than
anything we could summarise.

---

## Logging

Use the `Log` categories in `JanelaSupport`. Never `print()` — invisible in
release, unsearchable in Console.

**Never log terminal traffic, command output, file contents, or environment
values.** That is the user's private data and it must not reach the system log.
Log the *shape* of things: a git subcommand and its exit status, a terminal id and
its state transition.

Three additions that follow from features added since:

- **Never log a notification body.** OSC 9/777 payloads are the user's own program
  talking; they go to `UNUserNotificationCenter` and nowhere else.
- **Never log `gh`/`glab` output.** It contains branch names, PR titles, and
  sometimes private repository names. Log the subcommand and the failure class.
- **Never log the paths `.worktreeinclude` copied.** Log the count and the total
  size; a path list is a description of the user's project.

Prefer `.debug` on hot paths; it compiles to nearly nothing when the subsystem is
not being collected. Use `privacy: .public` only for values that are definitionally
not sensitive, such as an enum case name.

---

## Dependency injection

Constructor injection, always. No singletons, no `.shared`, no service locator.
`AppEnvironment.live()` is the one place the real graph is assembled.

This is what makes `SessionStore` testable with an in-memory database and a fake
`WorktreeServing`, and `AttentionPolicy` testable with a recording
`AttentionDelivering`, with no global state to reset between parallel tests.

---

## Documentation comments

Explain **why**. The signature already says what.

```swift
// Useless:
/// Creates a worktree.
func createWorktree(...)

// Useful:
/// Creates a worktree. `branch` is created if it does not exist, checked out if
/// it does. When `branch` is nil the worktree is detached at `startPoint`.
```

`swift-format`'s `ValidateDocumentationComments` rule is on, so a doc comment that
documents parameters must document *all* of them, and must use plural
`- Parameters:` when there is more than one. It also requires `- Returns:` and
`- Throws:` where applicable. This is checked by `make lint`.

Where a decision is non-obvious, link the ADR from the doc comment. That is how a
reader gets from code to reasoning.

---

## Comments in code

Comment the surprising, not the obvious. Good candidates:

- A constraint from outside (`argv[0]` must start with `-` or zsh skips
  `.zprofile`; `git ls-files -i` requires an exclude option).
- A performance reason (`ContiguousArray` rather than `Data`; `clonefile` rather
  than a recursive copy).
- A deliberate omission (why there is no `.agentThinking` state; why automation
  commands are not read from the repository).

`// TODO:` is allowed and is used throughout the current scaffold to mark the
seams. Each one sits under a doc comment describing what belongs there.

---

## Banned

| Thing | Why | Instead |
| --- | --- | --- |
| `try!` | Crashes on a recoverable condition | `do`/`catch`, or `preconditionFailure` with a message if truly impossible |
| Force unwrap | Same | `guard let`, `if let` |
| `print()` | Invisible in release | `Log.*` |
| `DispatchQueue.main.async` in new code | Use structured concurrency | `@MainActor`, `await` |
| `NSLog` | Superseded | `Logger` |
| Implicitly unwrapped optionals | Deferred crash | Real optionals or `let` |
| Fixed paths in tests | Breaks parallel runs | `TemporaryDirectory` |
