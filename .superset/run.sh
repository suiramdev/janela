#!/usr/bin/env bash
#
# Superset run command: build this workspace's .app bundle and launch it.
#
# This is the slow path on purpose — `make app-build` drives xcodebuild and takes
# minutes, which is why it is a run command and not part of setup. The day-to-day
# loop is `make build` / `make test` in Packages/JanelaKit.

set -euo pipefail
cd "$(dirname "$0")/.."

APP="DerivedData/Build/Products/Debug/Janela.app"

make app-build

# Two clients sharing one daemon is by design, but a janelad built from a
# different checkout serving this app is not: the app would render behaviour from
# code that is not in this workspace. Say so rather than killing it — stopping the
# daemon closes the user's terminals and is their call (`make daemon-restart`).
resident="$(pgrep -lf janelad | grep -Fv -- "$PWD" || true)"
if [[ -n "$resident" ]]; then
    printf '\033[33mwarning:\033[0m a janelad from another checkout is resident:\n%s\n' "$resident"
    echo "It will serve this app. Run 'make daemon-restart' to hand over to this build"
    echo "(that closes the terminals it holds)."
fi

# -n: a second instance of the same bundle id, so one workspace's app does not
# just activate another's.
open -n "$APP"
