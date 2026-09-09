#!/usr/bin/env bun
/**
 * Show whether `janelad` is running, and who is connected.
 *
 * Two clients sharing one daemon is by design. A daemon built from a *different*
 * checkout serving your app is not, and it is the thing to check first when the app
 * is behaving like code you have not written.
 */
// Two spellings, because there are two ways to start one: the compiled sidecar,
// whose command line contains `janelad`, and the source entry point behind
// `bun run dev` and `bun run --cwd apps/daemon dev`, which never mentions the word.
const processes = Bun.spawnSync(["pgrep", "-lf", String.raw`janelad|main\.ts --foreground`]);
const listing = new TextDecoder().decode(processes.stdout).trim();
console.log(listing === "" ? "janelad: not running" : listing);

const sockets = Bun.spawnSync(["sh", "-c", "lsof -U 2>/dev/null | grep janelad || true"]);
const connections = new TextDecoder().decode(sockets.stdout).trim();
console.log(connections === "" ? "no clients connected" : connections);
