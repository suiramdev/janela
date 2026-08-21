#!/usr/bin/env bash
#
# Superset workspace setup. Runs once per new workspace, in the workspace
# directory. Keep it fast: install dependencies and generate what the typechecker
# needs, never build the app bundle (that is `.superset/run.sh`).

set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\033[1m==>\033[0m %s\n' "$1"; }

# ---- Gitignored local files -------------------------------------------------
#
# A worktree only inherits tracked files. Signing credentials and any local .env
# are gitignored, so copy them from the root checkout when the developer has them.

root="${SUPERSET_ROOT_PATH:-}"
if [[ -n "$root" && "$root" != "$PWD" ]]; then
    for file in .env .env.local notarization-credentials.json; do
        if [[ -f "$root/$file" && ! -e "$file" ]]; then
            cp "$root/$file" "$file"
            say "Copied $file from the root checkout"
        fi
    done
fi

# ---- Dependencies ------------------------------------------------------------
#
# `bun install` is fast and Bun's global cache is shared across worktrees, so this
# costs little per workspace. `bun run generate` produces the database client,
# which the typechecker needs before anything will compile.

say "Installing dependencies"
bun install

say "Generating the database client"
bun run generate

# The PTY's native half. Cargo's target directory is per-worktree, so the first
# build in a new workspace is a cold one; it is small and takes a few seconds.
say "Building the PTY library"
bun run build:native
