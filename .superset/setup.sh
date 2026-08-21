#!/usr/bin/env bash
#
# Superset workspace setup. Runs once per new workspace, in the workspace
# directory. Keep it fast: resolve dependencies and generate the project, never
# build the .app (that is `.superset/run.sh`).

set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\033[1m==>\033[0m %s\n' "$1"; }

# ---- Gitignored local files -------------------------------------------------
#
# A worktree only inherits tracked files. Secrets.xcconfig carries DEVELOPMENT_TEAM
# for signing (see project.yml) and is gitignored, so copy it from the root
# checkout when the developer has one.

root="${SUPERSET_ROOT_PATH:-}"
if [[ -n "$root" && "$root" != "$PWD" && -f "$root/Secrets.xcconfig" && ! -e Secrets.xcconfig ]]; then
    cp "$root/Secrets.xcconfig" Secrets.xcconfig
    say "Copied Secrets.xcconfig from the root checkout"
fi

# ---- Tooling, dependencies, project -----------------------------------------
#
# `make bootstrap` verifies Xcode, installs XcodeGen if missing, runs
# `swift package resolve` and generates Janela.xcodeproj. It is safe to re-run,
# and SwiftPM's shared cache in ~/.swiftpm makes resolution cheap per worktree.

make bootstrap
