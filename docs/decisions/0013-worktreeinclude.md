# 0013. `.worktreeinclude`: git matches the patterns, `clonefile` moves the bytes

- **Status:** Accepted
- **Date:** 2026-08-19

## Context

A fresh git worktree contains exactly the tracked files. That is correct, and it is
also why a new worktree is unusable for about two minutes: no `.env`, no
`node_modules`, no `.venv`, no build cache. The files a project needs to *run* are
precisely the files git is configured to ignore.

Every user of worktrees has a script for this. Making the app do it is the single
highest-value thing "worktree-aware" can mean beyond `git worktree add`.

The design question is three-part.

**Which files?** The list is project-specific and belongs to the repository, not to
one developer's app database — a teammate cloning the repo should get the same
behaviour. That means a committed file. It also means the format should be one
people already know.

**How are patterns matched?** Writing a gitignore-syntax matcher is a
deceptively large job: negation, directory-only patterns, `**`, anchoring,
precedence. Getting it subtly wrong copies the wrong 400 MB, or silently misses the
one `.env` that mattered.

**How are the bytes moved?** `node_modules` is routinely 300–800 MB across tens of
thousands of files. A naive recursive copy is tens of seconds and doubles disk
usage, which is a bad trade for a feature whose selling point is speed.

## Decision

A `.worktreeinclude` file at the repository root, **gitignore syntax**, listing
paths to carry from the project's main checkout into a newly created worktree.

```gitignore
# .worktreeinclude
.env
.env.local
node_modules/
.venv/
target/debug/
```

**Matching is delegated to git.** We never implement a pattern matcher:

```sh
git -C <source> ls-files -o -i --exclude-from=.worktreeinclude -z --directory
```

`-o -i` lists untracked files matching the given patterns — which is exactly the
set we want, because anything tracked is already in the new worktree. `--directory`
collapses a wholly-untracked directory to a single entry, so `node_modules/`
arrives as one path rather than 40,000. `-z` because paths may contain newlines,
per [ADR 0007](0007-git-integration.md).

Verified against git 2.49: with `.env` and `node_modules/` in the file, the command
returns exactly `.env` and `node_modules/`, and omits an untracked `junk.log` and an
ignored-but-unlisted `.venv/`.

**Copying uses `clonefile(2)`** — APFS copy-on-write. A cloned `node_modules` costs
metadata rather than bytes, takes milliseconds, and consumes no additional disk
until one side diverges. Fallback to `FileManager.copyItem` when `clonefile` fails
(different volume, non-APFS, cross-device), which is rare and correct.

Bounds and safety, all of them non-negotiable:

- **Never follow symlinks out of the repository.** A symlink is copied as a
  symlink, never dereferenced.
- **Total size is measured first and capped at 2 GB by default.** Past the cap, the
  user is asked once, with the actual number and the offending path, and the
  session is created either way — an oversized include never blocks getting a
  terminal.
- **Never copy `.git`.** Explicitly excluded regardless of patterns; copying it
  produces a repository that looks fine and corrupts confusingly.
- **Failures are per-path and non-fatal.** A file that cannot be read is logged by
  *path shape*, skipped, and reported in the session's first automation terminal.
  The worktree still exists.
- **What was copied is recorded** on `WorktreeBinding.includedPaths`, so deletion
  can say "this also removes a 400 MB `node_modules` and an `.env` that exists
  nowhere else" rather than "are you sure?".

Ordering is fixed and documented, because automation scripts depend on it: the
copy happens **after** `git worktree add` and **before** any
`.worktreeCreated` automation command ([ADR 0014](0014-project-automation.md)).
A missing `.worktreeinclude` is not an error; it is the common case.

## Consequences

**Good.** Correct by construction. Negation, `**`, anchoring and precedence all
behave exactly as they do in `.gitignore`, because they *are* `.gitignore` — the
user's existing mental model transfers with no documentation.

**Good.** Fast and cheap on APFS. Cloning a large `node_modules` is effectively
free, which is what makes "new branch in seconds" true rather than aspirational.

**Good.** It is a committed file, so it is reviewed, shared, and versioned like any
other project convention. A teammate who installs Janela inherits the setup.

**Bad.** A second file with gitignore semantics but inverted meaning. "Include" in
a format whose verb is "exclude" is a genuine confusion, and the `-i` flag reads
backwards for the same reason. Mitigated by the name and by shipping a commented
template; not fully solvable.

**Bad.** Cross-volume worktrees lose the `clonefile` advantage and fall back to a
real copy. Rare, and the size cap keeps the worst case bounded.

**Bad.** Copied secrets now exist in one more place on disk. This is the user's
explicit instruction, but it makes deletion matter more — which is why
`includedPaths` exists and why the removal dialog names the files.

**Bad.** A copy is a snapshot. Change `.env` in the main checkout and the worktrees
do not see it. Documented, not solved: syncing would mean watching files and
resolving conflicts, which is a different feature.

## Alternatives considered

**Symlink instead of copy.** Tempting for `node_modules`: instant, zero space, and
edits propagate. Rejected as the default because it is a shared mutable dependency
across branches — an `npm install` on one branch silently mutates every other
worktree, which is the exact failure worktrees exist to prevent. It is a plausible
per-pattern opt-in later.

**Write our own gitignore matcher.** Rejected on the same grounds as
[ADR 0007](0007-git-integration.md): the semantics are subtler than they look, and
a divergence shows up in someone else's repository rather than in our tests.

**Reuse `.gitignore` itself, copy everything ignored.** No new file to learn, and
the patterns are already written. Rejected: `.gitignore` covers build output,
coverage reports, editor state and OS junk. Copying it wholesale is both enormous
and wrong.

**Store the list in Janela's database, per project.** Consistent with automation
commands ([ADR 0014](0014-project-automation.md)) and avoids the inverted-semantics
confusion. Rejected because the list is a property of the repository that the team
should share, and — decisively — because copying files is not code execution, so it
carries none of the trust problem that keeps automation commands out of the repo.
That asymmetry is deliberate: **declaring data may live in the repo; declaring
commands may not.**

**Shell out to `rsync`.** Would work and handles the walk. Rejected: an external
binary with a large surface, worse error reporting, and no `clonefile`.

## Revisit when

- Users ask for symlink semantics per pattern — additive, and the syntax already
  has room (`node_modules/ @link`).
- The 2 GB default is hit often enough to be annoying rather than protective.
- git changes `ls-files` behaviour for `-o -i --exclude-from`, which is
  the one external dependency this design has.
