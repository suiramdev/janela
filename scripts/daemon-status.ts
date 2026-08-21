#!/usr/bin/env bun
/**
 * Show whether `janelad` is running, and who is connected.
 *
 * Two clients sharing one daemon is by design. A daemon built from a *different*
 * checkout serving your app is not, and it is the thing to check first when the app
 * is behaving like code you have not written.
 */
const processes = Bun.spawnSync(["pgrep", "-lf", "janelad"]);
const listing = new TextDecoder().decode(processes.stdout).trim();
console.log(listing === "" ? "janelad: not running" : listing);

const sockets = Bun.spawnSync(["sh", "-c", "lsof -U 2>/dev/null | grep janelad || true"]);
const connections = new TextDecoder().decode(sockets.stdout).trim();
console.log(connections === "" ? "no clients connected" : connections);
