import type { Project, Session, TerminalDescriptor } from "@janela/core";
import { UserFacingError } from "@janela/support";

export type Noun = "project" | "session" | "terminal";

export class NotFound extends UserFacingError {
  override readonly summary: string;

  constructor(noun: Noun, reference: string) {
    super(`no ${noun} matches`, {
      recoverySuggestion: "`janela list` shows every project, session and terminal.",
    });

    this.summary = `No ${noun} matches ${JSON.stringify(reference)}.`;
  }
}

export class Ambiguous extends UserFacingError {
  override readonly summary: string;

  constructor(noun: Noun, reference: string, candidates: readonly string[]) {
    super(`several ${noun}s match`, {
      reason: `It could be ${candidates.join(", ")}.`,
      recoverySuggestion: `Give more of the ${noun}'s id.`,
    });

    this.summary = `More than one ${noun} matches ${JSON.stringify(reference)}.`;
  }
}

export interface LocatedTerminal {
  readonly session: Session;
  readonly terminal: TerminalDescriptor;
}

function pick<Item>(
  noun: Noun,
  reference: string,
  items: readonly Item[],
  idOf: (item: Item) => string,
  nameOf: ((item: Item) => string) | undefined,
): Item {
  const exact = items.find((item) => idOf(item) === reference);

  if (exact !== undefined) return exact;

  const named = nameOf === undefined ? [] : items.filter((item) => nameOf(item) === reference);
  const candidates =
    named.length > 0 ? named : items.filter((item) => idOf(item).startsWith(reference));

  const [only, ...others] = candidates;

  if (only === undefined || reference.length === 0) throw new NotFound(noun, reference);

  if (others.length > 0) throw new Ambiguous(noun, reference, candidates.map(idOf));

  return only;
}

export function findProject(projects: readonly Project[], reference: string): Project {
  return pick(
    "project",
    reference,
    projects,
    (project) => project.id,
    (project) => project.name,
  );
}

export function findSession(sessions: readonly Session[], reference: string): Session {
  return pick(
    "session",
    reference,
    sessions,
    (session) => session.id,
    (session) => session.name,
  );
}

export function findTerminal(sessions: readonly Session[], reference: string): LocatedTerminal {
  const located = sessions.flatMap((session) =>
    session.terminals.map((terminal) => ({ session, terminal })),
  );

  return pick("terminal", reference, located, (entry) => entry.terminal.id, undefined);
}
