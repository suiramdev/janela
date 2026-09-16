# @janela/git

Layer 3, daemon side. Git, by way of the user's own `git`: worktree creation,
enumeration, removal and removal-safety, plus `.worktreeinclude`.

What this package must not do: leak a raw command string or a repository path
above its own API, import `@janela/forge` — the two are peers and share
`@janela/support/process` — or reimplement anything git already does. Every
answer here is re-read from git rather than cached; git is the source of truth
and reconciling with it is a class of bug we decline to own.

Budgets for `git worktree add` and for the `.worktreeinclude` copy live in
[`../performance.md`](../performance.md) § Session creation.

## git-runner.ts

### Why the CLI

The same reason libgit2 was refused before the language changed: every
JavaScript git implementation is further from the CLI than libgit2 was, and the
CLI is what the user's repositories are configured for — hooks, credential
helpers, `includeIf`, LFS, sparse-checkout, `core.fsmonitor`. Shelling out costs
a few milliseconds per call and buys correctness.

The user's `git` is resolved over `PATH`, not hardcoded to `/usr/bin/git`: the
system git is older and lacks some worktree flags, and the daemon is handed the
login shell's captured environment so Homebrew's wins. Resolution happens once
and is remembered *including its failure*, so a machine without git does not pay
for a `PATH` walk per call.

Every invocation is scoped with `-C <directory>`; nothing ever `chdir`s, because
one daemon process serves every repository the user has open. Arguments are
always an array and there is no shell, so the quoting bug class does not exist.

`GIT_OPTIONAL_LOCKS=0` goes to read-only commands so a background refresh never
takes `index.lock` out from under the user's own git. The table is matched on
*leading tokens* rather than the first one, because `worktree list` reads and
`worktree add` does not.

`ProcessRunning` enforces the per-invocation limit (`DEFAULT_GIT_TIMEOUT_MS`,
120 s) by killing the child. That is deliberately not `Effect.timeout`, which
would abandon a live `git` rather than reap it. `ProcessOutcome.timedOut` is
dropped: a killed git is a failed git and the caller's recovery is the same.

### The failure vocabulary

Two shapes, and the split is the one `docs/conventions.md` § Errors describes.

`GitFailure` and `GitNotFound` are `UserFacingError`s, and the `instanceof`
contract on them crosses the daemon/client decision — `@janela/session` catches
them and the app renders them. `GitFailure.subcommand` reaches a person, so it is
the command the user would recognise ("worktree add"), never the whole argv,
which would carry paths and branch names into a headline. Its stderr becomes
`reason`, shown in a disclosure triangle; an empty stderr becomes no reason
rather than an empty second sentence. `GitNotFound` is not reported
per-invocation: git is expected to be present and is not something we can
install.

`GitError` is everything else — never shown, always logged — and it is a
`Data.TaggedError` carrying a tagged `reason`, the same shape as `FrameError` in
`@janela/protocol`. Reason classes are `Data.TaggedClass`, and their tags are
what `gitErrorLabel` returns for a log field.

| Reason class | Tag | Means |
| --- | --- | --- |
| `GitUnrunnable` | `unrunnable` | the resolved `git` could not be executed at all |
| `WorktreeNotListed` | `worktreeNotListed` | `worktree add` succeeded and `worktree list` does not show it |
| `CloneUnavailable` | `cloneUnavailable` | the filesystem refused `COPYFILE_FICLONE_FORCE` |
| `EntryUnreadable` | `entryUnreadable` | one `.worktreeinclude` entry could not be read or written |

The reasons live here rather than beside their raisers so that
`worktree-service.ts` and `worktree-include.ts` share one union without
importing each other.

`unrunnable` exists because a spawn rejection's message embeds the executable's
absolute path, which is exactly the leak this package's rule forbids; the typed
reason carries the `cause` for the log and nothing for a headline.
`worktreeNotListed` used to travel as a `GitFailure` with a fabricated exit code
of 0 and the directory interpolated into its stderr — a path in a user-facing
sentence, for an invariant violation that is not a git error at all.
`cloneUnavailable` and `entryUnreadable` are separate tags because the
difference decides control flow, not just a message: see the fallback below.

Branch on a reason with `Match.tag`, `Effect.catchTag` or `Predicate.isTagged`,
never by reading `_tag`; branch on the two `UserFacingError`s with `instanceof`.

## worktree-service.ts

Note how small `WorktreeServing` is: list branches and worktrees, create a
worktree, check out a branch, remove a worktree, ask whether removal is safe.
Anything more elaborate belongs in the user's own git. The two branch operations
sit here rather than behind a `GitRunning` the brain holds, because a raw git
command string never leaves this package and because "which branch, and where"
is one question the client asks.

### Parsing `worktree list`

`--porcelain -z`, never plain `--porcelain`: a worktree path may contain a
newline, and a line-splitting parser invents worktrees when it does — pinned by
*a worktree path containing a newline survives parsing*. Records are separated by
two NULs, attributes within a record by one.

Attributes are either **valued** — `worktree <path>`, `HEAD <sha>`,
`branch <ref>`, `locked [reason]` — or **bare booleans**: `bare`, `detached`,
`prunable`. `locked` is the one that is both, and a lock with no reason is still
a lock, which is why the test for one is `lockReason !== undefined` and never its
emptiness.

Unknown attributes fall to `Match.orElse` and are ignored: the porcelain format
is documented as append-only, so a newer git adding a line must not break an
older reader.

`branch` is shortened from `refs/heads/…` here, once. That short name is what the
user typed and what `createWorktree` and `checkoutBranch` take.

git prints absolute, canonical paths, so nothing is resolved — but the value
still goes through `absolutePath()` from `@janela/core`, which is the one place
that decides what absolute means. A record naming no absolute path is not a
worktree and is dropped rather than asserted into one.

### Parsing `status --porcelain=v1 -z`

The subtlety `-z` introduces: a rename or copy entry is *two* NUL-terminated
tokens, `XY <new>` followed by the bare original path. Reading that second token
as an entry of its own takes its first two characters for a status code and
reports nonsense — which is why the fixture in *a rename's source path is not
read as a status entry* commits a file literally named `??notes.txt`. `!!` is an
ignored file, which only appears under `--ignored` and is not work.

### Creating

`--detach` is not optional for a branchless worktree: a bare
`worktree add <path>` invents a branch named after the directory, which is not
what "no branch" means. An existing branch is checked out rather than created,
because `add -b <existing>` exits non-zero and the contract says an existing
branch is checked out; a branch that does not exist yet is checked out nowhere,
so there is nothing for `--force` to override on that path.

`--force` is only ever what the caller asked for. git's safeguard exists because
two worktrees sharing a branch move each other's `HEAD`, so overriding it is a
decision the user makes in the dialog and the flag carries. `--force` also
silences "path is already assigned to a worktree", which is a second reason never
to add it defensively.

The created worktree is re-read from `worktree list` rather than constructed:
git's view is the only one that stays true. `realpath` first, because git
canonicalises what it lists and on macOS `/var/…` is `/private/var/…`.

### Removal safety

`hasRunningSessions` is always `false` here — git cannot know what is live.
`@janela/session` fills it in, and it is the only layer that can.

A prunable worktree runs no git at all: the directory is gone, so there is
nothing to lose and `status` in a missing directory only fails.

With an upstream, "unpushed" is exactly what the upstream lacks. Without one git
exits 128, and the honest answer becomes "commits no remote has" — plus, for a
detached HEAD, "commits no local branch has", since those survive the worktree's
removal. A repository with no remotes therefore reports its commits as unpushed,
which is true: nothing else holds them.

`removalObstacles` is what makes the confirmation dialog able to say exactly what
will be lost; "Are you sure?" is not a warning. `isTriviallySafe` is that list
being empty, so the two can never disagree, and `removalObstacleLabel` is the tag
for a log field. The list's order is the order the dialog reads them in.

`removeWorktree` never sends the second `--force` git demands for a locked
worktree — unlocking is the user's call, and git's refusal is the answer. git
leaves the directory behind in some cases (a submodule, an unmerged file it
declined to delete), and `rm` with `force` is unconditional because it is already
a no-op on a path that is gone.

## worktree-include.ts

`.worktreeinclude` is the repo-declared list of *ignored* files to carry into a
new worktree: `.env`, `node_modules`, build caches. Two decisions are
load-bearing, and both are about not writing code we would get wrong.

**git matches the patterns.** The honest implementation of "which ignored files
match these patterns" is `git ls-files -o -i --exclude-from=<file>`, not a
gitignore matcher we wrote; ours would disagree with git's the first time someone
used a negation — pinned by *honours a negation, because git owns the matching*.
`-i` is why the exclude option is mandatory: `ls-files -i` is defined only
together with an exclude source and refuses without one. `-z` because a filename
may contain a newline, `--directory` so a wholly-ignored directory collapses to
one entry, and an absolute `--exclude-from` so nothing depends on the child's
cwd. The trailing slash git prints is kept: that exact string lands in
`WorktreeBinding.includedPaths` and is what the removal dialog shows.

**`clonefile` moves the bytes.** On APFS a clone is metadata-only, which is what
makes copying a 500 MB `node_modules` cost milliseconds. `COPYFILE_FICLONE_FORCE`
rather than `FICLONE`, so a filesystem that cannot clone *says so* instead of
quietly copying bytes; that refusal is the only reason `usedFallbackCopy` can be
honest, and a silent fallback is how the budget stops being met without anyone
noticing. `EXDEV`, `ENOTSUP`, `EOPNOTSUPP`, `EINVAL` and `ENOSYS` are the errnos
that mean "this filesystem cannot clone" as opposed to "this file could not be
copied" — `EXDEV` cross-volume, `EINVAL` what a special file answers, both
measured on macOS. Seeing one becomes `CloneUnavailable`, which flips the whole
copy to byte copies, so a 40 000-file `node_modules` on a clone-incapable volume
pays one failed syscall rather than 40 000. Every other errno becomes
`EntryUnreadable`: that entry is skipped and the copy continues.

`.git` is never copied, at any depth, whatever the patterns matched. A nested
repository copied wholesale is a second checkout the user did not ask for.

### The boundary is decoded, not trusted

`copy` is a public seam and the paths reaching it are persisted in
`WorktreeBinding.includedPaths`, so they are untrusted on the way back in. A
`Schema` check decides once what a repository-relative include path is —
non-empty after trailing slashes, not absolute, and no segment that is empty,
`..` or `.git` — and a rejected entry is counted as skipped, never relocated.
git's own output always satisfies it; a caller handing over `../..` does not.

### What is an absence and what is a failure

Every filesystem call is an `Effect` failing with `GitError`, and the whole copy
is one program run once at the API edge. Each site chose deliberately:

| Site | Outcome | Why |
| --- | --- | --- |
| `.worktreeinclude` missing (`ENOENT`, `ENOTDIR`) | empty result, silent | the common case; handing git a nonexistent `--exclude-from` is a fatal exit 128 rather than an empty answer |
| `.worktreeinclude` present but unreadable | empty result, errno logged | a session must still be created, but an `.env` that silently did not arrive is not an absence anybody can explain |
| an entry that vanished between measuring and copying | not copied, counted in `skipped` | the report is the accounting; a race on the user's own files is not an error |
| an unreadable file or directory inside a tree | skipped, errno logged | its siblings still arrive, and the entry still counts as copied |
| a symlink that could not be recreated | skipped, errno logged | it used to be swallowed with no log at all |
| the whole include over the size cap | nothing copied, `oversized` on the report | a partial under-cap subset would be a selection policy the user never expressed |

A symlink is **recreated, not followed** — including one pointing outside the
repository, which is the user's arrangement and not ours to flatten into a copy
of whatever it references. It therefore contributes no bytes to the measurement.

A directory that arrived minus three unreadable files still has to be named by
the removal dialog, so it counts as copied.

### Bounds

AGENTS.md non-negotiable 9 applies. Both the measure pass and the copy pass grow
only a stack of *directory* paths, bounded by tree depth times per-level
directory fan-out — never one entry per file. A `node_modules` with 40 000 files
costs two numbers and a few hundred strings.

`DEFAULT_INCLUDE_CAP_BYTES` is 2 GiB. Past it nothing is copied unless the user
opts in: a worktree is meant to be cheap and silently duplicating half a disk is
not. Everything is measured *before* a byte moves, because the cap is a
precondition of the copy rather than something to notice halfway through it.
`onOversized` is called once and never awaited — session creation must not block
on a person, and by the time it runs the session already exists and works without
its includes. With no client attached, or nothing wired, the outcome is
identical: the copy stays skipped, and the skip is on the report and in the log.

### Logging

Counts, sizes and errnos only. Never a path — `docs/conventions.md` § Logging:
a path list is a description of the user's project. The default logger discards,
because a library that logs during import must not decide the format for a
process that has not asked for one.

## Tests

Real repositories in temporary directories, never a mock — `docs/testing.md`
§ "We do not fake git". The fixture is hermetic (`GIT_CONFIG_GLOBAL=/dev/null`,
`GIT_CONFIG_SYSTEM=/dev/null`, `GIT_TERMINAL_PROMPT=0`, `commit.gpgsign=false`, a
minimal `PATH`) so it passes on a machine with signing and unusual global config.

`git-runner.test.ts` is the one place with a stand-in `git`: a shell script that
echoes its lock setting and then one argument per line. Real git cannot answer
"what environment did you get, and was my argv split?", which is the only thing
those tests ask. Everything about worktrees is asked of real repositories.

`.worktreeinclude` is tested by creating a real worktree and looking at what
landed in it, including what did **not**: an ignored-but-unlisted directory, an
untracked-but-unlisted file, and `.git` itself.

Three filesystem facts the tests depend on:

- `usedFallbackCopy` is unprovable without a filesystem that cannot clone, so the
  cross-device test attaches a small HFS+ ram disk (`hdiutil attach -nomount
  ram://`, then `diskutil erasevolume`). No sudo needed. Detaching can race the
  filesystem still flushing, so it is retried with `-force`; that retry is what
  keeps a failed assertion from leaving a volume mounted on the machine.
- Attaching a volume queues behind whatever else is doing I/O, which under a full
  `bun run check` is a 71 MB sidecar copy. The two tests that attach one get
  45 s, matching `@janela/pty`'s slow tests.
- The clone-cost test `fsync`s its 128 MB source before measuring, or APFS's
  delayed allocation lands those bytes inside the measurement window and the
  copy is blamed for them.

The recording logger is built in the test file rather than taken from
`@janela/test-support`: `recordingLogSink` there is an unimplemented seam
belonging to another issue, which is also why this module takes its logger as a
parameter.
