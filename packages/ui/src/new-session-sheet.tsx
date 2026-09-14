import { RequestFailed, type DaemonConnection } from "@janela/client";
import {
  supportsWorktrees,
  type AbsolutePath,
  type Project,
  type ProjectID,
  type Session,
} from "@janela/core";
import {
  Button,
  DialogFooter,
  Empty,
  EmptyDescription,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  Input,
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
 * New Session: where the session runs, and — in a repository — on which branch.
 *
 * One sheet for every way a session begins (AGENTS.md § Non-negotiables 1). The
 * first field is the project, and "No project" is a choice on it rather than a
 * different command, because a standalone session is a first-class case
 * (`docs/product.md`). The rest of the form follows that choice:
 *
 * - **No project**: a folder. The session is "a terminal in this directory".
 * - **A plain-folder project**: nothing more to ask; the session runs in the
 *   project's directory.
 * - **A repository**: a branch, and one of three starts, one `createSession`:
 *   - **Check out** the branch in the project's own directory (`inProject`, with
 *     the branch named). The common case for someone who does not use worktrees.
 *   - **Use the worktree** that already has the branch (`adoptWorktree`). Janela
 *     did not necessarily create it; a worktree is a worktree.
 *   - **Create a worktree** for the branch (`newWorktree`). The branch exists, so
 *     the daemon checks it out there rather than creating it.
 *
 *   Which of the three a branch permits is git's rule, not ours: a branch can be
 *   checked out in one place at a time. `startChoices` says which are refused and
 *   why, in words, rather than letting git refuse after the click.
 *
 *   The branch list is the daemon's (`projectBranches`), read once per project
 *   chosen. A client that listed branches itself would be a second git.
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
 * Asks the daemon once per repository the sheet is pointed at; nothing is asked
 * for `undefined`, which is what "No project" and a plain folder pass. A reply
 * for a sheet that has since closed is dropped, which is what the `cancelled`
 * flag is for. The answer is kept with the project it answers for, so a sheet
 * re-pointed at another project reads as loading rather than showing the
 * previous project's branches for a frame.
 */
export function useBranchOverview(
  connection: Pick<DaemonConnection, "request">,
  projectID: ProjectID | undefined,
): BranchOverviewState {
  const [answer, setAnswer] = useState<
    { readonly projectID: ProjectID; readonly state: BranchOverviewState } | undefined
  >(undefined);

  useEffect(() => {
    if (projectID === undefined) return undefined;
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

  return answer !== undefined && answer.projectID === projectID ? answer.state : LOADING;
}

const LOADING: BranchOverviewState = { kind: "loading" };

/** The intent for a folder typed or chosen, or `undefined` while there is none. */
export function standaloneIntent(directory: string): SessionCreationIntent | undefined {
  const trimmed = directory.trim();
  // The daemon decides whether the directory exists; this only refuses what is
  // not a path at all, the same rule `absolutePath` applies.
  return trimmed.startsWith("/")
    ? { kind: "standalone", directory: trimmed as AbsolutePath }
    : undefined;
}

// MARK: - The sheet

/** The select's value for "No project": no `ProjectID` is empty. */
const NO_PROJECT = "";

export interface NewSessionSheetProps {
  readonly projects: readonly Project[];
  /**
   * The project the sheet is on; `undefined` is "No project". Controlled, because
   * the branch overview is loaded for it by whoever holds the connection.
   */
  readonly projectID: ProjectID | undefined;
  readonly onProjectChange: (projectID: ProjectID | undefined) => void;
  /** Branch state for `projectID` when it is a repository; not read otherwise. */
  readonly overview: BranchOverviewState;
  /** The mirror's sessions: a worktree that is already a session is not offered twice. */
  readonly sessions: readonly Session[];
  /** The native folder dialog; `undefined` when the user cancelled. */
  readonly onPickDirectory: () => Promise<AbsolutePath | undefined>;
  readonly onCreate: (intent: SessionCreationIntent) => void;
  readonly onCancel: () => void;
}

export function NewSessionSheet(props: NewSessionSheetProps): ReactElement {
  const { projects, projectID, onProjectChange, overview, sessions, onPickDirectory } = props;
  const { onCreate, onCancel } = props;
  const project = projects.find((candidate) => candidate.id === projectID);

  const [directory, setDirectory] = useState("");
  // Held across project changes: switching to a repository and back should not
  // lose the folder that was typed.
  const [branchChoice, setBranchChoice] = useState<BranchChoice>(NO_CHOICE);

  const projectFieldID = useId();
  const handleProject = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const value = event.target.value;
      onProjectChange(value === NO_PROJECT ? undefined : (value as ProjectID));
    },
    [onProjectChange],
  );

  const intent = useMemo((): SessionCreationIntent | undefined => {
    if (project === undefined) return standaloneIntent(directory);
    if (!supportsWorktrees(project)) return { kind: "inProject", projectID: project.id };
    if (overview.kind !== "loaded") return undefined;
    const resolved = resolveBranchChoice(project, overview.overview, sessions, branchChoice);
    return resolved.start === undefined
      ? undefined
      : newSessionIntent(project.id, resolved.branch, resolved.start, overview.overview, sessions);
  }, [project, directory, overview, sessions, branchChoice]);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (intent !== undefined) onCreate(intent);
    },
    [intent, onCreate],
  );

  return (
    <form onSubmit={handleSubmit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={projectFieldID}>Project</FieldLabel>
          <NativeSelect
            id={projectFieldID}
            className="w-full"
            value={project?.id ?? NO_PROJECT}
            onChange={handleProject}
          >
            <NativeSelectOption value={NO_PROJECT}>No project</NativeSelectOption>
            {projects.map((candidate) => (
              <NativeSelectOption key={candidate.id} value={candidate.id}>
                {candidate.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>

        {project === undefined ? (
          <FolderField value={directory} onChange={setDirectory} onPick={onPickDirectory} />
        ) : supportsWorktrees(project) ? (
          <BranchFields
            project={project}
            overview={overview}
            sessions={sessions}
            choice={branchChoice}
            onChoice={setBranchChoice}
          />
        ) : (
          <FieldDescription>
            Runs in <span className="font-mono">{project.directory}</span>.
          </FieldDescription>
        )}

        <DialogFooter>
          <Button variant="outline" type="button" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={intent === undefined}>
            Create Session
          </Button>
        </DialogFooter>
      </FieldGroup>
    </form>
  );
}

/** A standalone session's directory: typed, or chosen in the native dialog. */
function FolderField(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onPick: () => Promise<AbsolutePath | undefined>;
}): ReactElement {
  const { value, onChange, onPick } = props;
  const id = useId();
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onChange(event.target.value);
    },
    [onChange],
  );
  const pick = useCallback(() => {
    void onPick().then((picked) => {
      if (picked !== undefined) onChange(picked);
      return undefined;
    });
  }, [onPick, onChange]);

  return (
    <Field>
      <FieldLabel htmlFor={id}>Folder</FieldLabel>
      <div className="flex gap-2">
        <Input
          id={id}
          type="text"
          className="font-mono"
          value={value}
          onChange={handleChange}
          placeholder="/path/to/folder"
          autoComplete="off"
          spellCheck={false}
          data-autofocus
        />
        <Button variant="outline" type="button" onClick={pick}>
          Choose…
        </Button>
      </div>
      <FieldDescription>The session's working directory.</FieldDescription>
    </Field>
  );
}

// MARK: - A repository's branch and start

/**
 * What the user has said so far about the branch fields. Kept as *choices*
 * rather than resolved values, so a project switch or an overview that arrives
 * later re-derives the preselection instead of correcting stale state.
 */
interface BranchChoice {
  readonly branch: string | undefined;
  readonly start: SessionStart | undefined;
}

const NO_CHOICE: BranchChoice = { branch: undefined, start: undefined };

/**
 * The branch and start the form shows: the chosen ones where the overview still
 * permits them, else the preselection. Changing the branch re-selects the first
 * start it permits, until the user picks one that the new branch also permits.
 */
function resolveBranchChoice(
  project: Project,
  overview: BranchOverview,
  sessions: readonly Session[],
  choice: BranchChoice,
): {
  readonly branch: string;
  readonly choices: readonly StartChoice[];
  readonly start: SessionStart | undefined;
} {
  const branch =
    choice.branch !== undefined && overview.branches.includes(choice.branch)
      ? choice.branch
      : (preselectedBranch(project, overview) ?? "");
  const choices = startChoices(branch, overview, sessions);
  const permitted = choices.find(
    (candidate) => candidate.start === choice.start && candidate.refusal === undefined,
  );
  return { branch, choices, start: permitted?.start ?? defaultStart(choices) };
}

function BranchFields(props: {
  readonly project: Project;
  readonly overview: BranchOverviewState;
  readonly sessions: readonly Session[];
  readonly choice: BranchChoice;
  readonly onChoice: (choice: BranchChoice) => void;
}): ReactElement {
  const { project, overview, sessions, choice, onChoice } = props;

  if (overview.kind === "loading") {
    return (
      <Empty className="py-6">
        <Spinner />
        <EmptyDescription>Reading branches…</EmptyDescription>
      </Empty>
    );
  }
  if (overview.kind === "failed") {
    return <FieldDescription>{overview.summary}</FieldDescription>;
  }
  if (overview.overview.branches.length === 0) {
    return <FieldDescription>This repository has no branches yet.</FieldDescription>;
  }

  return (
    <BranchForm
      project={project}
      overview={overview.overview}
      sessions={sessions}
      choice={choice}
      onChoice={onChoice}
    />
  );
}

function BranchForm(props: {
  readonly project: Project;
  readonly overview: BranchOverview;
  readonly sessions: readonly Session[];
  readonly choice: BranchChoice;
  readonly onChoice: (choice: BranchChoice) => void;
}): ReactElement {
  const { project, overview, sessions, choice, onChoice } = props;
  const { branch, choices, start } = useMemo(
    () => resolveBranchChoice(project, overview, sessions, choice),
    [project, overview, sessions, choice],
  );

  const branchFieldID = useId();
  const handleBranch = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      onChoice({ branch: event.target.value, start: choice.start });
    },
    [onChoice, choice.start],
  );
  const handleStart = useCallback(
    (value: unknown) => {
      onChoice({ branch: choice.branch, start: value as SessionStart });
    },
    [onChoice, choice.branch],
  );

  return (
    <>
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
          {choices.map((entry) => (
            <StartOption key={entry.start} choice={entry} />
          ))}
        </RadioGroup>
      </Field>
    </>
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
