import { RequestFailed, type DaemonConnection } from "@janela/client";
import type { Project, ProjectID, Session } from "@janela/core";
import {
  Button,
  DialogFooter,
  Empty,
  EmptyDescription,
  EmptyHeader,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  NativeSelect,
  NativeSelectOption,
  RadioGroup,
  RadioGroupItem,
  Spinner,
} from "@janela/design";
import {
  parseBranchOverview,
  type BranchOverview,
  type SessionCreationIntent,
} from "@janela/protocol";
import type { ChangeEvent, FormEvent, ReactElement } from "react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";

/**
 * The project's `+`: a session on a branch, and where that branch is worked on.
 *
 * Three starts, one `createSession`:
 *
 * - **Check out** the branch in the project's own directory (`inProject`, with
 *   the branch named). The common case for someone who does not use worktrees.
 * - **Use the worktree** that already has the branch (`adoptWorktree`). Janela did
 *   not necessarily create it; a worktree is a worktree.
 * - **Create a worktree** for the branch (`newWorktree`). The branch exists, so the
 *   daemon checks it out there rather than creating it.
 *
 * Which of the three a branch permits is git's rule, not ours: a branch can be
 * checked out in one place at a time. `startChoices` says which are refused and
 * why, in words, rather than letting git refuse after the click.
 *
 * The branch list is the daemon's (`projectBranches`), read once when the sheet
 * opens. A client that listed branches itself would be a second git.
 */

export type SessionStart = "checkout" | "existingWorktree" | "newWorktree";

export interface StartChoice {
  readonly start: SessionStart;
  readonly title: string;
  /** Where the session's directory would be, as the user will recognise it. */
  readonly detail: string;
  /** Present when this start is not possible for the branch, and says why. */
  readonly refusal?: string;
}

/** The three starts in the order they are offered, with each one's refusal if any. */
export function startChoices(
  branch: string,
  overview: BranchOverview,
  sessions: readonly Session[],
): readonly StartChoice[] {
  const holder = overview.worktrees.find((worktree) => worktree.branch === branch);
  const heldInProject = holder !== undefined && holder.isMain;
  const linked = holder !== undefined && !holder.isMain ? holder : undefined;
  const openAs =
    linked === undefined
      ? undefined
      : sessions.find((session) => session.directory === linked.directory);

  return [
    {
      start: "checkout",
      title: "Check out in the project directory",
      detail: heldInProject ? "Already checked out there." : "Switches the project to this branch.",
      ...(linked === undefined
        ? {}
        : { refusal: `Checked out in the worktree at ${linked.directory}.` }),
    },
    {
      start: "existingWorktree",
      title: "Use the existing worktree",
      detail: linked === undefined ? "No worktree has this branch." : linked.directory,
      ...(linked === undefined
        ? { refusal: "No worktree has this branch." }
        : openAs === undefined
          ? {}
          : { refusal: `Already open as the session "${openAs.name}".` }),
    },
    {
      start: "newWorktree",
      title: "Create a new worktree",
      detail: "A directory of its own, beside the project's other worktrees.",
      ...(holder === undefined
        ? {}
        : {
            refusal: heldInProject
              ? "Already checked out in the project directory."
              : "Already has a worktree.",
          }),
    },
  ];
}

/** The first start the branch permits — what the dialog selects on open. */
export function defaultStart(choices: readonly StartChoice[]): SessionStart | undefined {
  return choices.find((choice) => choice.refusal === undefined)?.start;
}

/**
 * The branch the dialog opens on: the project's default when it is a local
 * branch, else whatever the project directory has checked out, else the first.
 */
export function preselectedBranch(project: Project, overview: BranchOverview): string | undefined {
  const preferred = project.git?.defaultBranch;
  if (preferred !== undefined && overview.branches.includes(preferred)) return preferred;
  const main = overview.worktrees.find((worktree) => worktree.isMain)?.branch;
  if (main !== undefined && overview.branches.includes(main)) return main;
  return overview.branches[0];
}

/** The wire intent for a choice, or `undefined` when the choice is refused. */
export function newSessionIntent(
  projectID: ProjectID,
  branch: string,
  start: SessionStart,
  overview: BranchOverview,
  sessions: readonly Session[],
): SessionCreationIntent | undefined {
  const choice = startChoices(branch, overview, sessions).find((entry) => entry.start === start);
  if (choice === undefined || choice.refusal !== undefined) return undefined;

  switch (start) {
    case "checkout":
      return { kind: "inProject", projectID, branch };
    case "existingWorktree": {
      const holder = overview.worktrees.find(
        (worktree) => worktree.branch === branch && !worktree.isMain,
      );
      return holder === undefined
        ? undefined
        : { kind: "adoptWorktree", projectID, directory: holder.directory };
    }
    case "newWorktree":
      return { kind: "newWorktree", projectID, branch };
  }
}

// MARK: - Loading the overview

export type BranchOverviewState =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly overview: BranchOverview }
  | { readonly kind: "failed"; readonly summary: string };

/**
 * Asks the daemon once per open. A reply for a sheet that has since closed is
 * dropped, which is what the `cancelled` flag is for. The answer is kept with the
 * project it answers for, so a sheet re-pointed at another project reads as
 * loading rather than showing the previous project's branches for a frame.
 */
export function useBranchOverview(
  connection: Pick<DaemonConnection, "request">,
  projectID: ProjectID,
): BranchOverviewState {
  const [answer, setAnswer] = useState<
    { readonly projectID: ProjectID; readonly state: BranchOverviewState } | undefined
  >(undefined);

  useEffect(() => {
    let cancelled = false;
    connection.request({ type: "projectBranches", projectID }).then(
      (text) => {
        if (cancelled || text === undefined) return undefined;
        setAnswer({ projectID, state: { kind: "loaded", overview: parseBranchOverview(text) } });
        return undefined;
      },
      (error: unknown) => {
        if (cancelled) return;
        const summary =
          error instanceof RequestFailed ? error.failure.summary : "Could not read the branches.";
        setAnswer({ projectID, state: { kind: "failed", summary } });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [connection, projectID]);

  return answer?.projectID === projectID ? answer.state : LOADING;
}

const LOADING: BranchOverviewState = { kind: "loading" };

// MARK: - The sheet

export interface NewSessionSheetProps {
  readonly project: Project;
  readonly overview: BranchOverviewState;
  /** The mirror's sessions: a worktree that is already a session is not offered twice. */
  readonly sessions: readonly Session[];
  readonly onCreate: (intent: SessionCreationIntent) => void;
  readonly onCancel: () => void;
}

export function NewSessionSheet(props: NewSessionSheetProps): ReactElement {
  const { project, overview, sessions, onCreate, onCancel } = props;

  if (overview.kind === "loading") {
    return (
      <Empty className="py-8">
        <Spinner />
        <EmptyDescription>Reading branches…</EmptyDescription>
      </Empty>
    );
  }
  if (overview.kind === "failed") {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyDescription>{overview.summary}</EmptyDescription>
        </EmptyHeader>
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </Empty>
    );
  }
  if (overview.overview.branches.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyDescription>This repository has no branches yet.</EmptyDescription>
        </EmptyHeader>
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </Empty>
    );
  }

  return (
    <NewSessionForm
      project={project}
      overview={overview.overview}
      sessions={sessions}
      onCreate={onCreate}
      onCancel={onCancel}
    />
  );
}

function NewSessionForm(props: {
  readonly project: Project;
  readonly overview: BranchOverview;
  readonly sessions: readonly Session[];
  readonly onCreate: (intent: SessionCreationIntent) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const { project, overview, sessions, onCreate, onCancel } = props;

  const [chosenBranch, setChosenBranch] = useState<string | undefined>(undefined);
  const branch =
    chosenBranch !== undefined && overview.branches.includes(chosenBranch)
      ? chosenBranch
      : (preselectedBranch(project, overview) ?? "");

  // Derived, not stored-and-corrected: changing the branch re-selects the first
  // start it permits, until the user picks one that the new branch also permits.
  const [chosenStart, setChosenStart] = useState<SessionStart | undefined>(undefined);
  const { choices, start } = useMemo(() => {
    const offered = startChoices(branch, overview, sessions);
    const permitted = offered.find(
      (choice) => choice.start === chosenStart && choice.refusal === undefined,
    );
    return { choices: offered, start: permitted?.start ?? defaultStart(offered) };
  }, [branch, overview, sessions, chosenStart]);

  const branchFieldID = useId();
  const canCreate =
    start !== undefined &&
    newSessionIntent(project.id, branch, start, overview, sessions) !== undefined;

  const handleBranch = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    setChosenBranch(event.target.value);
  }, []);

  const handleStart = useCallback((value: unknown) => {
    setChosenStart(value as SessionStart);
  }, []);

  const projectID = project.id;
  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (start === undefined) return;
      const intent = newSessionIntent(projectID, branch, start, overview, sessions);
      if (intent !== undefined) onCreate(intent);
    },
    [projectID, branch, start, overview, sessions, onCreate],
  );

  return (
    <form onSubmit={handleSubmit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={branchFieldID}>Branch</FieldLabel>
          <NativeSelect
            id={branchFieldID}
            className="w-full font-mono"
            value={branch}
            onChange={handleBranch}
            data-autofocus
          >
            {overview.branches.map((candidate) => (
              <NativeSelectOption key={candidate} value={candidate}>
                {candidate}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>

        <Field>
          <FieldLabel>Start</FieldLabel>
          <RadioGroup value={start ?? ""} onValueChange={handleStart} aria-label="Start">
            {choices.map((choice) => (
              <StartOption key={choice.start} choice={choice} />
            ))}
          </RadioGroup>
        </Field>

        <DialogFooter>
          <Button variant="outline" type="button" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canCreate}>
            Create Session
          </Button>
        </DialogFooter>
      </FieldGroup>
    </form>
  );
}

function StartOption(props: { readonly choice: StartChoice }): ReactElement {
  const { choice } = props;
  const id = useId();
  const isRefused = choice.refusal !== undefined;
  return (
    <Field orientation="horizontal" data-disabled={isRefused ? "" : undefined}>
      <RadioGroupItem value={choice.start} id={id} disabled={isRefused} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <FieldLabel htmlFor={id} className={isRefused ? "opacity-50" : undefined}>
          {choice.title}
        </FieldLabel>
        <FieldDescription>{choice.refusal ?? choice.detail}</FieldDescription>
      </div>
    </Field>
  );
}
