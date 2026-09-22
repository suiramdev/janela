# Releasing

How a version of Janela leaves this repository, what the `Release` workflow
refuses, and how an installed app finds the next version.

The short form: **the files say the version, `main` says what ships, the workflow
drafts, the maintainer publishes, and publishing mints the tag.**

---

## The procedure

1. **Stamp the version**, on a branch off `dev`:

   ```sh
   bun run version 0.2.0
   ```

   That rewrites the four version sites (§ Version sites) and nothing else. Commit it
   as `chore(release): v0.2.0` and open a pull request into `dev`. Bumping the version
   in the same pull request as the last change of the release is fine; bumping it in
   a pull request of its own is easier to read back.

2. **Land it on `main`** with a pull request from `dev` titled `Release v0.2.0`. Merge
   it as a merge commit, so `main` carries the same SHAs `dev` does. `main` moves for
   nothing else ([`AGENTS.md`](../AGENTS.md) § Branches).

3. **Run the workflow** on `main`:

   ```sh
   gh workflow run release.yml --ref main            # Developer ID secrets present
   gh workflow run release.yml --ref main -f unsigned=true   # no Developer ID yet
   gh run watch
   ```

   Or **Actions → Release → Run workflow** with `main` selected.

4. **Read the draft, then publish it.** The workflow leaves a *draft* release named
   `v0.2.0` with the assets attached and generated notes. Read it:

   ```sh
   gh release view v0.2.0
   ```

   Edit the notes if the generated ones need it, then publish:

   ```sh
   gh release edit v0.2.0 --draft=false
   ```

   GitHub creates the `v0.2.0` tag at `main`'s commit at that moment. Installed apps
   are offered the release on their next check.

A draft you discard costs nothing: no tag was made, the version number is still
free, and running the workflow again on a fixed `main` drafts it afresh.

---

## What the workflow refuses, and why

The `verify` job runs first, on the cheapest runner minutes it can, so a build that
would be thrown away is never paid for.

|Refusal|Reason|
|---|---|
|Any ref but `main`|`main` is the released state. A release cut from `dev` would ship code that no `Release v…` pull request described.|
|The version sites disagree|`bun run version` exits 1 when `tauri.conf.json`, `Cargo.toml`, `Cargo.lock` and `JANELAD_VERSION` do not all say the same thing. Half a bump is the classic way to ship an app that reports one version and a daemon that reports another.|
|`v<version>` already tagged, or a release of that name exists|A version means one commit, forever (`v*` tags are immutable). Bump first.|
|`TAURI_SIGNING_PRIVATE_KEY` missing|The updater archive is signed with it whatever Apple says, and an installed app rejects an unsigned archive. There is no unsigned mode for this key.|
|Developer ID secrets present **and** `unsigned=true`|Waiving signing you have is never what was meant.|
|No Developer ID secrets **and** no `unsigned=true`|An ad-hoc build must be asked for by name: macOS refuses to open it by double-click, and the release notes say so.|

The version is read from the files, never from a workflow input. What ships is what
`main` says, and there is no way to type a number that does not match the binary.

---

## The assets

|Asset|What it is for|
|---|---|
|`Janela_<version>_aarch64.dmg`|What a person downloads. Signed; notarized and stapled when a Developer ID is configured.|
|`Janela.app.tar.gz`|What an installed app downloads to update itself. Tauri's updater replaces the running bundle with its contents.|
|`Janela.app.tar.gz.sig`|The minisign signature of the archive, made with the private half of the updater key. The app verifies it against the public key compiled into `tauri.conf.json` before it installs anything.|
|`latest.json`|The updater manifest: the version, the publish date, and for `darwin-aarch64` the archive URL and its signature. Written by `apps/desktop/scripts/updater-manifest.ts` from the `.sig` file.|
|`SHA256SUMS.txt`|Checksums of the four files above, for anyone verifying a download by hand.|

The updater endpoint is `https://github.com/suiramdev/janela/releases/latest/download/latest.json`.
GitHub resolves `latest` to the newest **published, non-pre-release** release, which
is why:

- releases are **not** marked pre-release even at 0.x — a pre-release is one no
  installed app is ever offered;
- a **draft** is invisible to the endpoint until it is published, so the manifest
  can be uploaded before the release exists.

---

## Secrets

Set with `gh secret set <NAME> -R suiramdev/janela`.

|Secret|Needed|Value|
|---|---|---|
|`TAURI_SIGNING_PRIVATE_KEY`|Always|The private half of the updater keypair (the whole file, not a path).|
|`APPLE_CERTIFICATE`|Developer ID|The Developer ID Application certificate as a base64 `.p12`.|
|`APPLE_CERTIFICATE_PASSWORD`|Developer ID|The `.p12` password.|
|`APPLE_SIGNING_IDENTITY`|Developer ID|The exact certificate name, `Developer ID Application: Name (TEAMID)`. Tauri checks it is contained in the certificate.|
|`APPLE_ID`|Developer ID|The Apple ID that owns the team.|
|`APPLE_PASSWORD`|Developer ID|An app-specific password for that Apple ID, not the account password.|
|`APPLE_TEAM_ID`|Developer ID|The ten-character team id.|

Adding the six `APPLE_*` secrets is the whole switch from ad-hoc to Developer ID: the
next run signs with the identity, notarizes the app inside `tauri build`, notarizes
and staples the disk image, and `verify-bundle` proves all of it
([`packages/desktop.md`](packages/desktop.md) § `scripts/`). No code changes, no
workflow input.

### The updater key

The keypair was generated with `tauri signer generate -w ~/.tauri/janela.key --ci`,
without a password. The public key is in `tauri.conf.json` under
`plugins.updater.pubkey`; the private key is the repository secret and the
maintainer's `~/.tauri/janela.key`.

**Back the private key up somewhere that is not this machine and not GitHub.** An
installed app trusts exactly one public key. If the private key is lost, no release
made afterwards can be signed for the apps already installed, and every user has to
download a disk image by hand once. Rotating the key is that same cost, chosen on
purpose.

---

## Version sites

`bun run version` reads and writes four places, all of which must agree:

|File|Why it has a version|
|---|---|
|`apps/desktop/src-tauri/tauri.conf.json`|What the bundle's `Info.plist` and the updater's comparison use.|
|`apps/desktop/src-tauri/Cargo.toml`|The crate's version; Tauri reads it when `tauri.conf.json`'s is absent, so the two must not drift.|
|`apps/desktop/src-tauri/Cargo.lock`|Cargo rewrites the `janela` entry on the next build if it disagrees with `Cargo.toml`, which would dirty the tree of whoever builds next.|
|`apps/daemon/src/main.ts`|`JANELAD_VERSION`, a literal by decision ([`packages/janelad.md`](packages/janelad.md)): the compiled sidecar cannot read a manifest beside it, so the number is stamped in.|

Every `package.json` in the workspace says `0.0.0` and stays there: they are private,
never published, and no user sees them.

---

## How an installed app updates

- **When it checks.** 30 s after launch, then every 24 h, quietly: a failure in a
  quiet check is logged and never shown. **Janela → Check for Updates…** (also in the
  command palette) runs an announced check, which reports *up to date* and failures
  too.
- **What it shows.** A banner at the top of the window, overlaid like the connection
  banner and yielding to it — a daemon that is reconnecting is the more urgent fact.
  *Janela 0.2.0 is available* → **Update** downloads, verifies and swaps the bundle,
  with a percentage while it downloads → *Restart Janela to finish* → **Restart Now**
  relaunches. **Later** dismisses at any settled point; the next check offers it
  again.
- **What it does not touch.** Installing replaces `Janela.app` and nothing else.
  `janelad` keeps running the user's terminals through the download, the install and
  the relaunch (§ Non-negotiables 7). The relaunched app connects to the daemon it
  finds; if the protocol version moved between the two builds, the connection banner
  says so and offers the restart with its cost — that path existed before the updater
  and is unchanged.
- **Development builds never check.** A `tauri dev` binary is not inside a bundle the
  updater could replace, so `Check for Updates…` reports *Could not check for
  updates* and the scheduled checks are not installed.
