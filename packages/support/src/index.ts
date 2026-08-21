/**
 * `@janela/support` — layer 0. Zero domain knowledge.
 *
 * Anything here must be usable from any other package, in either process — and that
 * is a stronger constraint than it used to be, because one of the two processes is
 * now a WebView. So this module must not touch a filesystem, a socket, or a child
 * process. The subprocess runner that used to sit alongside these lives behind
 * `@janela/support/process` instead, and the layering gate treats that subpath as
 * daemon-only.
 *
 * See docs/decisions/0023-macos-first-portable.md for why the split exists, and
 * scripts/layers.ts for what enforces it.
 */

export * from "./bounded.ts";
export * from "./errors.ts";
export * from "./log.ts";
export * from "./signpost.ts";
