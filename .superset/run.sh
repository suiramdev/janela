#!/usr/bin/env bash
#
# Superset run command: build and launch this workspace's app.
#
# This is the slow path on purpose — a Tauri bundle drives cargo and takes minutes,
# which is why it is a run command and not part of setup. The day-to-day loop is
# `bun run check`, which finishes in seconds.

set -euo pipefail
cd "$(dirname "$0")/.."

# Two clients sharing one daemon is by design, but a janelad built from a different
# checkout serving this app is not: the app would render behaviour from code that
# is not in this workspace. Say so rather than killing it — stopping the daemon
# closes the user's terminals and is their call (`bun run daemon:restart`).
resident="$(pgrep -lf janelad | grep -Fv -- "$PWD" || true)"
if [[ -n "$resident" ]]; then
    printf '\033[33mwarning:\033[0m a janelad from another checkout is resident:\n%s\n' "$resident"
    echo "It will serve this app. Run 'bun run daemon:restart' to hand over to this build"
    echo "(that closes the terminals it holds)."
fi

# `bun run dev` starts a daemon if nothing is listening — a dev build registers no
# LaunchAgent, so nothing else will — then `tauri dev`: the Rust shell, Vite, and
# the window. It stays in the foreground, reloads the frontend on change, and stops
# the daemon it started when you stop it.
exec bun run dev
