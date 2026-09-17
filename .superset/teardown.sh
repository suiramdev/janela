#!/usr/bin/env bash
#
# Superset workspace teardown. Runs when the workspace is deleted.
#
# Build output (node_modules/, dist/, target/, .turbo/) lives inside the worktree
# and goes away with it, so there is nothing to clean there. What this workspace
# can leave behind outside itself:
#
#   - a resident daemon or gateway started from *this* worktree: after the
#     directory is gone it serves code that no longer exists, which is the footgun
#     documented in docs/development.md;
#   - the isolated HOME `bun run web:isolated` created under /tmp/janela-iso/<id>,
#     whose path the script records in .janela/isolated-home.
#
# Only a process whose command line points into this workspace is stopped. A
# janelad from the root checkout or another workspace is the user's, and stays.
#
# Three spellings, because there are three ways to start one: the compiled sidecar
# (`janelad` in its command line), the daemon's source entry point (`main.ts
# --foreground`), and the gateway's (`gateway/src/main.ts`). The source entry
# points are spelled as absolute paths precisely so the checkout they came from
# is visible here.

set -euo pipefail

workspace="${SUPERSET_WORKSPACE_PATH:-$(cd "$(dirname "$0")/.." && pwd)}"

matches="$(pgrep -lf 'janelad|main\.ts --foreground|gateway/src/main\.ts' | grep -F -- "$workspace" || true)"
if [[ -z "$matches" ]]; then
    echo "No janelad or gateway running from $workspace."
else
    while read -r pid _; do
        [[ -n "$pid" ]] || continue
        echo "Stopping janelad ($pid) launched from this workspace."
        echo "This closes the terminals it was holding — their working directories are"
        echo "inside the workspace being deleted."
        kill "$pid" 2>/dev/null || true
    done <<<"$matches"

    # Let each one finish: the daemon still writes its log while it shuts down, and
    # the isolated HOME below must not be removed from under it.
    while read -r pid _; do
        [[ -n "$pid" ]] || continue
        for _ in $(seq 1 50); do
            kill -0 "$pid" 2>/dev/null || break
            sleep 0.1
        done
    done <<<"$matches"
fi

pointer="$workspace/.janela/isolated-home"
if [[ -f "$pointer" ]]; then
    home="$(<"$pointer")"
    if [[ "$home" =~ ^/tmp/janela-iso/[0-9a-f]{8}$ ]]; then
        rm -rf "$home"
        echo "Removed isolated state $home."
    else
        echo "Not removing '$home': it is not an isolated HOME this workspace would have created."
    fi
fi
