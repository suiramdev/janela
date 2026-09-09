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

/**
 * A UUID, as `crypto.randomUUID` writes it: lowercase, hyphenated, no braces.
 * Case-insensitive on the way in, because a row written by hand or by another
 * tool is still a perfectly good id.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One implementation for all five: the brand is the only thing that differs. */
function fresh<Subject extends string>(): Identifier<Subject> {
  return crypto.randomUUID() as Identifier<Subject>;
}

export function newProjectID(): ProjectID {
  return fresh<"Project">();
}
export function newSessionID(): SessionID {
  return fresh<"Session">();
}
export function newTerminalID(): TerminalID {
  return fresh<"Terminal">();
}
export function newLaunchProfileID(): LaunchProfileID {
  return fresh<"LaunchProfile">();
}
export function newAutomationID(): AutomationID {
  return fresh<"Automation">();
}

/**
 * Re-brands a string read from the database or off the socket.
 *
 * Deliberately explicit and deliberately ugly: every call site is a place where
 * an untrusted string becomes a typed id, and those are worth being able to grep
 * for. Validates that it is a UUID.
 */
export function identifier<Subject extends string>(raw: string): Identifier<Subject> {
  if (!UUID.test(raw)) throw new Error(`not a UUID: ${raw}`);
  return raw as Identifier<Subject>;
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

/**
 * Throws when `raw` is not absolute.
 *
 * A leading `/` is the whole rule, and no `node:path`: this module is shared with
 * the client bundle, where that import does not belong, and Janela is macOS-first.
 * Nothing is normalised — a path that came from git or from `execve` is already the
 * path the user's tools see, and rewriting it would break the equality comparisons
 * the sidebar depends on.
 */
export function absolutePath(raw: string): AbsolutePath {
  if (!raw.startsWith("/")) throw new Error(`not an absolute path: ${raw}`);
  return raw as AbsolutePath;
}

/**
 * A timestamp, as an ISO 8601 string in UTC.
 *
 * Not a `Date`. Every value in this package crosses a socket as JSON, and a
 * `Date` requires a revival pass on the far side that one forgotten call site
 * turns into a string masquerading as a Date. A string is what the wire carries
 * anyway, so it is what the domain holds.
 */
export type Instant = string & { readonly [brand]: "Instant" };

export function now(): Instant {
  return instant(new Date());
}

/**
 * Canonicalises to `YYYY-MM-DDTHH:MM:SS.mmmZ`, which is what makes two Instants
 * describing the same moment compare equal as strings — a database round-trip
 * through `DATETIME` and an offset-bearing string from a forge must not produce
 * two different values for one timestamp.
 */
export function instant(raw: string | Date): Instant {
  const date = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(date.getTime())) throw new Error(`not an instant: ${String(raw)}`);
  return date.toISOString() as Instant;
}

export function toDate(value: Instant): Date {
  return new Date(value);
}
