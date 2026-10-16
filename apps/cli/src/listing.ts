import type { Project, Session, TerminalID, TerminalState } from "@janela/core";
import type { SessionRemovalPreview } from "@janela/protocol";
import { Match } from "effect";

export interface Mirrored {
  readonly projects: readonly Project[];
  readonly sessions: readonly Session[];
  readonly terminalStates: Readonly<Record<TerminalID, TerminalState>>;
}

const NO_PROJECT = "-";

export function terminalStateLabel(state: TerminalState | undefined): string {
  if (state === undefined) return "idle";

  return Match.value(state).pipe(
    Match.discriminatorsExhaustive("kind")({
      idle: () => "idle",
      running: () => "running",
      needsAttention: () => "needsAttention",
      exited: ({ code }) => `exited ${code}`,
      failed: () => "failed",
    }),
  );
}

export function projectLine(project: Project): string {
  return ["project", project.id, project.name, project.directory].join("\t");
}

export function sessionLines(
  session: Session,
  terminalStates: Mirrored["terminalStates"],
): readonly string[] {
  return [
    ["session", session.id, session.name, session.directory, session.projectID ?? NO_PROJECT].join(
      "\t",
    ),
    ...session.terminals.map((terminal) =>
      [
        "terminal",
        terminal.id,
        session.id,
        terminalStateLabel(terminalStates[terminal.id]),
        terminal.title,
      ].join("\t"),
    ),
  ];
}

export function listingLines(mirrored: Mirrored): readonly string[] {
  const inProject = mirrored.projects.flatMap((project) => [
    projectLine(project),
    ...mirrored.sessions
      .filter((session) => session.projectID === project.id)
      .flatMap((session) => sessionLines(session, mirrored.terminalStates)),
  ]);

  const standalone = mirrored.sessions
    .filter((session) => session.projectID === undefined)
    .flatMap((session) => sessionLines(session, mirrored.terminalStates));

  return [...inProject, ...standalone];
}

export function listingJSON(mirrored: Mirrored): string {
  return JSON.stringify(
    {
      projects: mirrored.projects,
      sessions: mirrored.sessions,
      terminalStates: mirrored.terminalStates,
    },
    undefined,
    2,
  );
}

function listed(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";

  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`;
}

function safetyLosses(plan: SessionRemovalPreview): readonly string[] {
  const { safety } = plan;
  const losses: string[] = [];

  if (safety.hasUncommittedChanges) losses.push("uncommitted changes");

  if (safety.hasUntrackedFiles) losses.push("untracked files");

  if (safety.hasUnpushedCommits) losses.push("unpushed commits");

  if (safety.isLocked) losses.push("a locked worktree");

  return losses;
}

export function removalLines(
  session: Session,
  plan: SessionRemovalPreview,
  deletesDirectory: boolean,
): readonly string[] {
  const costs: string[] = [];

  if (plan.liveTerminalCount > 0) {
    costs.push(
      plan.liveTerminalCount === 1
        ? "1 running terminal ends."
        : `${plan.liveTerminalCount} running terminals end.`,
    );
  }

  if (plan.runsTeardownAutomation) costs.push("The session teardown command runs first.");

  if (deletesDirectory) {
    costs.push(`${session.directory} is deleted.`);

    if (plan.includedPaths.length > 0) {
      costs.push(`${plan.includedPaths.length} copied-in file(s) go with it.`);
    }

    const losses = safetyLosses(plan);

    if (losses.length > 0) costs.push(`It still has ${listed(losses)}.`);
  } else if (plan.canDeleteDirectory) {
    costs.push(`${session.directory} is kept.`);
  }

  return [
    `Remove ${session.name} (${session.id})?`,
    ...(costs.length === 0 ? ["The session is removed. Nothing on disk changes."] : costs),
  ].map((line, index) => (index === 0 ? line : `  ${line}`));
}
