/**
 * `@janela/janelad` — layer 7, daemon side. The composition root.
 *
 * The package's entry point, so a sibling can name the graph rather than the
 * process: `apps/daemon/src/main.ts` is argv, signals and a log sink, and
 * everything with behaviour is exported from here.
 */

export * from "./environment.ts";
export * from "./lifecycle.ts";
export * from "./log-file.ts";
export * from "./socket.ts";
