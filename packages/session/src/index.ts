/**
 * `@janela/session` — layer 5, daemon side. The brain.
 *
 * Composes git, the terminal layer, the database and the forge into the project and
 * session lifecycle, plus project automation. Runs inside the daemon, and
 * deliberately does **not** import `@janela/protocol`: it announces change through
 * `StateObserving`, an interface it owns, so it stays usable — and testable — with
 * no socket at all.
 *
 * Nothing here may import a view layer. The daemon detects attention, the client
 * decides what it means, and the app delivers it.
 */

export * from "./automation-runner.ts";
export * from "./errors.ts";
export * from "./launch-profile-service.ts";
export * from "./project-service.ts";
export * from "./session-service.ts";
export * from "./shell-environment.ts";
export * from "./state-observing.ts";
export * from "./terminal-launch.ts";
