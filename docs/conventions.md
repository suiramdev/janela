# Conventions

> [!WARNING]
> **This document predates the Tauri/TypeScript migration and is stale.**
> It describes the Swift stack — `make` targets, SwiftPM modules, SwiftTerm, GRDB,
> Xcode. The architecture, the domain model and the product thesis it serves are
> unchanged; the stack it names is gone.
>
> Current: [`AGENTS.md`](../AGENTS.md) for commands and layering,
> [`architecture.md`](architecture.md) for the system,
> [`MIGRATION_MAP.md`](MIGRATION_MAP.md) for where every module, type and seam went.
> Rewriting this file is a tracked follow-up.


How Janela's code is written. `AGENTS.md` has the short version; this is the
reasoning and the edge cases.

Formatting is not in here, because formatting is not a discussion:
`swift-format` decides, `.swift-format` configures it, and `make format` applies
it.

---

## Compiler settings we opted into

Set in `Packages/JanelaKit/Package.swift` and applied to every target.

### `swiftLanguageMode(.v6)`

Strict concurrency, checked.

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

**A failing automation script is shown in its own terminal, not in a dialog.**
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

There are none. `oxslop/no-comments` rejects every comment in a `.ts` or
`.tsx` file except the five kinds below, and a doc comment is not among them.
Its `allowJsdoc` option defaults to true; `.oxlintrc.json` sets it to false, so
that the exempt set stays the closed one below. The one exception is `*.d.ts`,
where an ambient `declare module` has no name or type to carry why the specifier
is declared at all.

What a doc comment used to carry now lives somewhere a reader can find it and a
refactor cannot silently invalidate:

| Was a comment about | Now lives in |
| --- | --- |
| What a function does | its name and signature |
| What a value may be | its type, or the `Schema` that parses it |
| An invariant a caller must hold | a type that makes the wrong call unrepresentable, or a test named after it |
| Why a package is shaped as it is | `docs/packages/<name>.md` |
| Why an architectural edge exists | `docs/architecture.md` |
| A performance budget | `docs/performance.md` |

A per-package note is terse and keyed by module: a heading per file, then the
facts the code cannot state. It is not narration, and it does not restate
signatures.

A fact that lives on a seam belongs to one side by name: if you move it to the
other package's note, tell whoever owns that note and confirm it landed — two
packages each deferring to the other is how a fact a comment kept badly gets kept
nowhere.

---

## Comments in code

Five kinds survive, because the linter exempts them:

| Kind | Example |
| --- | --- |
| A safety justification | `// SAFETY: the UUID form was checked on the line above; the brand is nominal.` |
| A compiler directive | `// @ts-expect-error the fixture is deliberately the wrong shape` |
| A tooling directive | `// oxlint-disable-next-line no-await-in-loop` |
| A triple-slash reference | `/// <reference types="bun" />` |
| A shebang | `#!/usr/bin/env bun` |

`SAFETY:` is the only one that is a judgement call, and it earns its place only
when the invariant is real and the type system cannot state it — branding a
string that was just validated, or indexing a slot the line above proved
occupied. It must name the evidence. "SAFETY: this is fine" is a rule violation
with extra steps, and so is a `SAFETY:` added to silence
`require-safety-comment-for-type-assertion` on an assertion that should have
been a `Schema` decode.

The exemption test is applied to each comment's own text, so a multi-line
justification must be one `/* … */` block. A second `//` line is a separate
comment, it does not start with `SAFETY:`, and it fails the build.

`oxlint-disable` for anything else is not allowed. If a rule is wrong for a
whole class of file, that is an override in `.oxlintrc.json` with a reason next
to it, which is a decision somebody can find and argue with.

---

## Banned

| Thing | Why | Instead |
| --- | --- | --- |
| `any` | A promise to the compiler with no evidence behind it | A real type, or `Schema` at the boundary that produces one |
| Non-null `!` | Same | A narrowing check, or a type that cannot be absent |
| `as T` without `SAFETY:` | An assertion is a claim; a claim needs evidence | A `Schema` decode, or a precise type |
| `x as unknown as T` | Two assertions hide what one would have shown | Parse the value |
| `console.log` | Unlevelled, unsearchable, and in the daemon nobody reads it | The `log` categories in `@janela/support` |
| `switch` | Falls through silently, never reports a missing case | `Match`, with `Match.exhaustive` |
| `try`/`catch`/`finally` | Erases the error type and catches failures you did not mean to handle | `Effect.try`, `Effect.tryPromise`, `Effect.ensuring` |
| `typeof` / `in` as a shape check | Narrows a representation without establishing a contract | Parse at the boundary, branch on the domain value |
| `error._tag === "…"` | Reads a discriminant the library owns | `Match.tag`, `Effect.catchTag`, `Predicate.isTagged` |
| `...(x ? {} : { k: v })` | Hides an omission behind an empty object | Build the object in steps, or type the field `T \| undefined` |
| `{ k: undefined }` under `exactOptionalPropertyTypes` | Present-and-undefined is not absent | Omit the key |
| An optional parameter `x?: T` | A caller cannot tell absence from a value never passed | A default, or an explicit `T \| undefined` |
| A comment that is not `SAFETY:` or a directive | Drifts out of step with the code beneath it | A name, a type, a test, or `docs/packages/<name>.md` |
| Fixed paths in tests | Files share one process, so leftovers outlive the file that made them — and `--parallel` must stay possible | `temporaryDirectory` from `@janela/test-support` |
| An undeclared third-party import | Bun's hoisting resolves it anyway, and the graph becomes a lie | Declare it in that package's `package.json` |
