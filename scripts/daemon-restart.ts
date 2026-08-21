#!/usr/bin/env bun
/**
 * Stop `janelad` so the next connection starts the current build.
 *
 * The footgun of the two-process design is an old daemon staying resident while you
 * iterate on a new one: the app then talks to code you edited ten minutes ago, or
 * refuses the handshake outright. See docs/development.md § The daemon.
 *
 * This prints the cost rather than hiding it. Stopping the daemon closes the
 * terminals it was holding — the same cost a user pays after an app update, which is
 * worth feeling.
 */
const found = Bun.spawnSync(["pkill", "-x", "janelad"]);
if (found.exitCode === 0) {
  console.log("Stopped janelad.");
  console.log("Note: this closed any terminals it was holding.");
} else {
  console.log("No janelad running.");
}
console.log("launchd will start the current build on the next connection.");
