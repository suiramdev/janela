#!/usr/bin/env bash
#
# Superset workspace teardown. Runs when the workspace is deleted.
#
# Build output (node_modules/, dist/, target/, .turbo/) lives inside the worktree
# and goes away with it, so there is nothing to clean there. The one thing this
# workspace can leave behind outside itself is a resident `janelad` started from
# *this* worktree's binary: after the directory is gone it serves code that no
# longer exists, which is the footgun documented in docs/development.md.
#
# Only a daemon whose command line points into this workspace is stopped. A janelad
# from the root checkout or another workspace is the user's, and stays.

set -euo pipefail

workspace="${SUPERSET_WORKSPACE_PATH:-$(cd "$(dirname "$0")/.." && pwd)}"

matches="$(pgrep -lf janelad | grep -F -- "$workspace" || true)"
if [[ -z "$matches" ]]; then
    echo "No janelad running from $workspace."
    exit 0
fi

while read -r pid _; do
    [[ -n "$pid" ]] || continue
    echo "Stopping janelad ($pid) launched from this workspace."
    echo "This closes the terminals it was holding — their working directories are"
    echo "inside the workspace being deleted."
    kill "$pid" 2>/dev/null || true
done <<<"$matches"
