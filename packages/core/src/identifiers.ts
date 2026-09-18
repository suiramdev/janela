export type Identifier<Subject extends string> = string & { readonly [brand]: Subject };

export type ProjectID = Identifier<"Project">;
export type SessionID = Identifier<"Session">;
export type TerminalID = Identifier<"Terminal">;

export type AbsolutePath = string & { readonly [brand]: "AbsolutePath" };

export type Instant = string & { readonly [brand]: "Instant" };

declare const brand: unique symbol;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fresh<Subject extends string>(): Identifier<Subject> {
  // SAFETY: `crypto.randomUUID` is specified to return a canonical lowercase 8-4-4-4-12 UUID, which is the only invariant the brand carries; the brand itself is nominal and erased at runtime.
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

export function identifier<Subject extends string>(raw: string): Identifier<Subject> {
  if (!UUID.test(raw)) throw new Error(`not a UUID: ${raw}`);

  // SAFETY: the UUID pattern matched `raw` on the line above; the brand is nominal-only and adds no representation the string does not already have.
  return raw as Identifier<Subject>;
}

export function absolutePath(raw: string): AbsolutePath {
  if (!raw.startsWith("/")) throw new Error(`not an absolute path: ${raw}`);

  // SAFETY: `raw` was shown to start with `/` on the line above, which is the whole of absoluteness on the platforms Janela targets; nothing is normalised, so the value is unchanged.
  return raw as AbsolutePath;
}

export function now(): Instant {
  return instant(new Date());
}

export function instant(raw: string | Date): Instant {
  const date = raw instanceof Date ? raw : new Date(raw);

  if (Number.isNaN(date.getTime())) throw new Error(`not an instant: ${String(raw)}`);

  // SAFETY: `raw` round-tripped through a `Date` whose time is not NaN, and `toISOString` is specified to emit `YYYY-MM-DDTHH:MM:SS.mmmZ` — the canonical form the brand stands for.
  return date.toISOString() as Instant;
}

export function toDate(value: Instant): Date {
  return new Date(value);
}
