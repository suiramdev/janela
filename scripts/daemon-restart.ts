#!/usr/bin/env bun
const found = Bun.spawnSync(["pkill", "-x", "janelad"]);

if (found.exitCode === 0) {
  console.log("Stopped janelad.");
  console.log("Note: this closed any terminals it was holding.");
} else {
  console.log("No janelad running.");
}

console.log("launchd will start the current build on the next connection.");
