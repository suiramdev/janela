#!/usr/bin/env bash
#
# Superset run command: launch this workspace's app in isolation.
#
# The workspace runs against its own daemon, under a private HOME in
# /tmp/janela-iso/<id> (the id is derived from this checkout's path), and is
# reached in a browser at the port the banner prints. It never probes, reuses,
# kickstarts or stops the user's own janelad, so any number of workspaces can run
# side by side without touching the user's sessions, terminals or database.
#
# The isolated path is the web client: a janelad, the gateway that serves
# apps/web/dist and relays /ws onto the daemon's socket, and a watching web build.
# It compiles no Rust. Changes to the Tauri shell itself are verified by a human
# from the root checkout with `bun run desktop`.
#
# It stays in the foreground and stops everything it started when you stop it.
# `.superset/teardown.sh` removes the isolated HOME when the workspace is deleted.

set -euo pipefail
cd "$(dirname "$0")/.."

exec bun run web:isolated
