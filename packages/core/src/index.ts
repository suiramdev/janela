/**
 * `@janela/core` — layer 1. The domain model.
 *
 * Value types, identifiers, and pure functions over them. No I/O, no frameworks,
 * nothing platform-specific — if something here needs an `await`, it is in the
 * wrong package.
 *
 * Since docs/decisions/0015-daemon-owned-sessions.md this carries a second
 * meaning: `@janela/core` is the vocabulary **both processes share**, so these
 * types cross a socket and must stay cheap to encode and free of anything
 * process-specific. That is why timestamps are ISO strings and paths are strings
 * rather than `Date` and `URL`.
 *
 * Four nouns — project, session, terminal, launch profile — and that is the entire
 * concept budget. docs/product.md § 1 explains why adding a fifth is expensive.
 */

export * from "./accent.ts";
export * from "./identifiers.ts";
export * from "./launch-profile.ts";
export * from "./project.ts";
export * from "./session-layout.ts";
export * from "./session.ts";
export * from "./terminal.ts";
