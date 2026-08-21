/**
 * Type-safe, opaque identifiers.
 *
 * A branded string gives what a phantom type gave before: a `TerminalID` can never
 * be passed where a `SessionID` is expected. That
 * matters more than it looks — the model is three levels deep, every level's id
 * is a UUID underneath, and `sessionFor(id)` with the wrong `id` would otherwise
 * typecheck and return undefined forever.
 *
 * The brand is erased at runtime: these *are* strings, so they encode to JSON as
 * themselves and cross the socket for free.
 */

declare const brand: unique symbol;

export type Identifier<Subject extends string> = string & { readonly [brand]: Subject };

export type ProjectID = Identifier<"Project">;
export type SessionID = Identifier<"Session">;
export type TerminalID = Identifier<"Terminal">;
export type LaunchProfileID = Identifier<"LaunchProfile">;
export type AutomationID = Identifier<"Automation">;

export function newProjectID(): ProjectID {
  throw new Error(`not implemented: newProjectID`);
}
export function newSessionID(): SessionID {
  throw new Error(`not implemented: newSessionID`);
}
export function newTerminalID(): TerminalID {
  throw new Error(`not implemented: newTerminalID`);
}
export function newLaunchProfileID(): LaunchProfileID {
  throw new Error(`not implemented: newLaunchProfileID`);
}
export function newAutomationID(): AutomationID {
  throw new Error(`not implemented: newAutomationID`);
}

/**
 * Re-brands a string read from the database or off the socket.
 *
 * Deliberately explicit and deliberately ugly: every call site is a place where
 * an untrusted string becomes a typed id, and those are worth being able to grep
 * for. Validates that it is a UUID.
 */
export function identifier<Subject extends string>(raw: string): Identifier<Subject> {
  void raw;
  throw new Error(`not implemented: identifier`);
}

/**
 * An absolute filesystem path.
 *
 * Branded for the same reason the ids are. A session's `directory` is its centre
 * of gravity and every part of the system assumes it is absolute; a bare `string`
 * would quietly lose that.
 *
 * Note what this is *not*: a `URL`. Paths cross the socket, get compared for
 * equality, and are handed to `execve`. A URL round-trip through percent-encoding
 * is a bug waiting for the first directory with a space in it.
 */
export type AbsolutePath = string & { readonly [brand]: "AbsolutePath" };

/** Throws when `raw` is not absolute. */
export function absolutePath(raw: string): AbsolutePath {
  void raw;
  throw new Error(`not implemented: absolutePath`);
}

/**
 * A timestamp, as an ISO 8601 string in UTC.
 *
 * Not a `Date`. Every value in this package crosses a socket as JSON, and a
 * `Date` requires a revival pass on the far side that one forgotten call site
 * turns into a string masquerading as a Date. A string is what the wire carries
 * anyway, so it is what the domain holds. See docs/decisions/0016-daemon-protocol.md.
 */
export type Instant = string & { readonly [brand]: "Instant" };

export function now(): Instant {
  throw new Error(`not implemented: now`);
}
export function instant(raw: string | Date): Instant {
  void raw;
  throw new Error(`not implemented: instant`);
}
export function toDate(value: Instant): Date {
  void value;
  throw new Error(`not implemented: toDate`);
}
