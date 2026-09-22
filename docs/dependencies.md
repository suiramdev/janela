# Dependencies

Janela's third-party surface is small but spread across four ecosystems: npm
packages installed by Bun, two Rust crate graphs, the actions its workflows run,
and the toolchain versions CI pins. Keeping those current by hand means someone
remembers to look. Nobody remembers to look.

[Renovate](https://docs.renovatebot.com) does the looking. The whole policy is
[`.github/renovate.json5`](../.github/renovate.json5); this page is why it says
what it says.

---

## How it runs

The **Mend-hosted GitHub App**, on a public repository, for free. There is no
workflow, no scheduled job and no token in this repository — if a dependency bot
needed a personal access token with write scope to work, it would be the widest
credential we own.

It opens pull requests against **`dev`**, like everyone else, and the four
required checks gate them like everyone else. Nothing about Renovate has a
privileged path to `main`.

Once a week, early Monday, Europe/Paris. A bot that interrupts on its own
schedule gets muted, and a muted bot updates nothing. Two things ignore the
schedule: a vulnerability with a fix available, which opens immediately, and
lockfile maintenance, which runs on the first of the month.

## What it watches

| Manager | Files | Notes |
| --- | --- | --- |
| `bun` | 21 `package.json` + `bun.lock` | Bun is the package manager, so Renovate runs `bun install` to refresh the lockfile. `workspace:*` deps are skipped — they are not third-party. |
| `cargo` | `apps/desktop/src-tauri`, `packages/pty/native` | `spikes/**` is ignored: a spike is a throwaway proof of a technique, not something we ship. |
| `github-actions` | both workflows | SHA pins and their version comments, plus the `macos-15` runner image. |
| `nodenv` | `.node-version` | Node exists here for Prisma's CLI. |
| custom regex | `BUN_VERSION`, `NODE_VERSION` in both workflows | See below. |

**The custom managers are the point of the file.** `ci.yml` carries a comment
telling you to keep `BUN_VERSION` level with `packageManager`, and `NODE_VERSION`
level with `.node-version`. A comment is not a mechanism. Two regex managers
extract those `env:` values as ordinary dependencies named `bun` and `node`, and a
package rule groups each name into one pull request — so the three places Node's
version is written move in a single diff, or not at all.

## What may merge itself

Three classes, and the required checks gate every one of them. Automerge here is
GitHub's own auto-merge: the pull request sits until `Lint, typecheck & test`,
`Build the PTY library`, `Compile the daemon sidecar` and `Bundle and verify the
app` are green, then squashes itself in.

- **Action digest refreshes.** Re-pinning an action to the current SHA of a tag it
  already uses.
- **Lockfile maintenance.** Transitive drift, corrected monthly, in one commit.
- **devDependencies below a major.** Tooling that cannot reach a user's machine —
  which excludes Tailwind and Vite, whose output ships even though their packages
  do not.

Everything else waits for a human. A major waits fourteen days as well, because
the first day of a major release is when its regressions are found by other
people.

Nothing that ships inside the app merges without review — `effect`, React, the
Tauri crates, xterm.js, Prisma, Tailwind, Vite and the runner image all land as
pull requests somebody reads.

## The groups, and why

A group exists when two versions are one decision. There are no groups for
tidiness.

- **oxc toolchain** — `oxlint`, `oxslop`, `oxfmt`. `oxslop` declares a peer of an
  exact `oxlint` and its rules are built against that release of the plugin API,
  which is still alpha and has broken across minors. The root `package.json`
  explains the exact pin; splitting these into two pull requests is how the linter
  drifts out from under the plugin anyway.
- **Tauri** — `@tauri-apps/*` and the `tauri*` crates. One release train with two
  package managers.
- **React**, **Vite**, **Tailwind CSS**, **Prisma**, **xterm.js**, **Steiger**,
  **Hugeicons**, **objc2** — each ships as a set whose parts assume each other.
  xterm.js matters most: `@janela/terminal` and `@janela/terminal-ui` are the only
  packages allowed to name the emulator, and they must name the same version.
- **bun**, **node** — the toolchain, described above.
- **GitHub runners** — `macos-15`. Moving it is a decision about where signing and
  notarization happen, so it is monthly and never automerged, but it has to
  surface: runner images get retired, and finding out from a failed release is the
  expensive way.

## What it will never touch

- **`engines`.** `>=1.4.0` and `>=22.12.0` are floors: the oldest machine that can
  build Janela. Raising a floor is a decision about who can contribute, not a
  dependency update, so the `engines` block is disabled outright.
- **`spikes/**`.** Nothing there is built, tested or shipped.
- **`workspace:*`.** Internal packages have no version to update.
- **Janela's own version.** That is `bun run version`, and
  [`releasing.md`](releasing.md) owns it.

## Living with it

**The Dependency Dashboard** is an issue Renovate keeps up to date: everything it
has found, everything it is waiting on, and a checkbox to force a run. It is the
one place to look when you wonder why something has not been updated.

**When a Renovate pull request fails CI, read the failure before the diff.** The
three that recur:

- `bun install --frozen-lockfile` fails — the lockfile in the branch is stale.
  Renovate refreshes it on the next run; a rebase checkbox on the pull request is
  faster.
- `oxlint` fails on new rules a minor introduced. That is the linter doing its job;
  fix the code or pin the rule, in the same pull request.
- Anything `effect` touches. It is on a release-candidate line and sits at every
  seam we parse — schemas, tagged errors, the frame decoders. Its bumps are read,
  never merged on green alone.

**To pause it**, tick *Pause Updates* on the dashboard, or set `"enabled": false`
in the config. To stop it entirely, uninstall the app from the repository — the
config file is inert without it.

## First-time setup

Install the app at [github.com/apps/renovate](https://github.com/apps/renovate)
and grant it `suiramdev/janela`. Because `.github/renovate.json5` is already
committed, it skips onboarding: the first run opens the Dependency Dashboard and
starts opening pull requests, six at a time.

The labels it applies — `dependencies`, `security`, `prerelease` — exist in the
repository already.

## Why not Dependabot

Dependabot does not understand `bun.lock`. It would leave the twenty-one
manifests and the lockfile that CI installs from entirely unmanaged, which is
most of the dependency surface. It also has no way to express any of the groups
above, or to reach a version written in a workflow's `env:` block.
