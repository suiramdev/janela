#!/usr/bin/env bun
const processes = Bun.spawnSync(["pgrep", "-lf", String.raw`janelad|main\.ts --foreground`]);

const listing = new TextDecoder().decode(processes.stdout).trim();

console.log(listing === "" ? "janelad: not running" : listing);

const sockets = Bun.spawnSync(["sh", "-c", "lsof -U 2>/dev/null | grep janelad || true"]);

const connections = new TextDecoder().decode(sockets.stdout).trim();

console.log(connections === "" ? "no clients connected" : connections);
