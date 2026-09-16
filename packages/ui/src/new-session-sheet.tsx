import { FolderOpenIcon, GitBranchIcon, GitCommitIcon } from "@hugeicons/core-free-icons";
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
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  DialogFooter,
  Empty,
  EmptyDescription,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  hugeicon,
  Input,
  NativeSelect,
  NativeSelectOption,
  RadioGroup,
  RadioGroupItem,
  Spinner,
  type ComboboxItemData,
  type IconComponent,
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
 * - **A repository**: a branch, and where to work on it.
 *
 * ## Two comboboxes, not five commands
 *
 * The branch and the worktree are each a field that *filters a list and accepts
 * a name the list does not have* — `@janela/design`'s `Combobox`. That one
 * control is what collapses the five creation cases into one form:
 *
 * - A branch picked from the list is an existing branch; a branch **typed** is
 *   created with the worktree that carries it. There is no second sheet for a
 *   new branch, because a new branch was never a different kind of thing.
 * - A worktree picked from the list is `adoptWorktree` — Janela did not
 *   necessarily create it; a worktree is a worktree. A worktree **named** is
 *   `newWorktree`. So "use the existing one" and "make another" are one
 *   question with one answer, rather than a radio the branch could refuse.
 *
 * What is left for the radio is the one genuine fork: the project's own
 * directory, or a directory of its own. `startChoices` says when the first is
 * impossible and why, in words, rather than letting git refuse after the click:
 * a branch another worktree holds cannot be checked out again.
 *
 * A *second worktree* of a held branch is the exception git allows under
 * `--force`, so the worktree field takes a new name for one and says what it
 * costs; `shareBranch` carries that decision to the daemon. Nothing else asks
 * for `--force`.
 *
 * The branch and worktree lists are both the daemon's (`projectBranches`), read
 * once per project chosen. A client that listed either itself would be a second
 * git.
 */

export type SessionStart = "checkout" | "worktree";

export interface StartChoice {
  readonly start: SessionStart;
  readonly title: string;
  /** Where the session's directory would be, as the user will recognise it. */
  readonly detail: string;
  /** Present when this start is not possible for the branch, and says why. */
  readonly refusal?: string;
}

/** A worktree of the project as the field offers it. */
export interface WorktreeChoice {
  readonly directory: AbsolutePath;
  /** The directory's last component: what the field shows and filters on. */
  readonly name: string;
  /** The session already open on it. Adopting one twice is not possible. */
  readonly openAs?: string;
}

/** A directory's last component, which is what a worktree is called. */
function lastComponent(directory: string): string {
  return directory.slice(directory.lastIndexOf("/") + 1);
}

/**
 * The linked worktrees holding `branch`, in git's order.
 *
 * Plural because `shareBranch` means a branch can be in several places at once.
 * The project's own checkout is not among them: working there is the other
 * start, not a worktree to adopt.
 */
export function worktreesFor(
  branch: string,
  overview: BranchOverview,
  sessions: readonly Session[],
): readonly WorktreeChoice[] {
  return overview.worktrees
    .filter((worktree) => worktree.branch === branch && !worktree.isMain)
    .map((worktree) => {
      const open = sessions.find((session) => session.directory === worktree.directory);
      return {
        directory: worktree.directory,
        name: lastComponent(worktree.directory),
        ...(open === undefined ? {} : { openAs: open.name }),
      };
    });
}

/** Whether the project's own checkout is on `branch`. */
function isInProject(branch: string, overview: BranchOverview): boolean {
  return overview.worktrees.some((worktree) => worktree.isMain && worktree.branch === branch);
}

/** The two starts in the order they are offered, with a refusal if any. */
export function startChoices(
  branch: string,
  overview: BranchOverview,
  sessions: readonly Session[],
): readonly StartChoice[] {
  const exists = overview.branches.includes(branch);
  const inProject = isInProject(branch, overview);
  const held = worktreesFor(branch, overview, sessions)[0];

  return [
    {
      start: "checkout",
      title: "Check out in the project directory",
      detail: inProject ? "Already checked out there." : "Switches the project to this branch.",
      ...(!exists
        ? // `git checkout` is never `-b` (`WorktreeServing.checkoutBranch`), and
          // making it so here would answer a different question than the field
          // was asked: a new branch arrives with a worktree of its own.
          { refusal: "This branch does not exist yet." }
        : inProject
          ? {}
          : held === undefined
            ? {}
            : { refusal: `Checked out in the worktree at ${held.directory}.` }),
    },
    {
      start: "worktree",
      // Never refused: the field below takes a name for a new worktree, and a
      // branch git will not check out twice is exactly what `--force` is for.
      // The user is told what sharing costs instead of being told they cannot.
      title: "Use a worktree",
      detail:
        held === undefined
          ? "A directory of its own, beside the project's other worktrees."
          : "The worktree this branch already has, or a new one you name.",
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
 *
 * Also what a new branch starts from, for the same reason: it is the branch the
 * user would have named.
 */
export function preselectedBranch(project: Project, overview: BranchOverview): string | undefined {
  const preferred = project.git?.defaultBranch;
  if (preferred !== undefined && overview.branches.includes(preferred)) return preferred;
  const main = overview.worktrees.find((worktree) => worktree.isMain)?.branch;
  if (main !== undefined && overview.branches.includes(main)) return main;
  return overview.branches[0];
}

/**
 * The worktree field's value on open: the first worktree with this branch that
 * is not already a session, else the branch's own name as a new one.
 *
 * Adopting comes first because it is the cheaper answer — the directory exists,
 * and a second worktree of one branch is a thing to choose deliberately.
 */
export function preselectedWorktree(
  branch: string,
  overview: BranchOverview,
  sessions: readonly Session[],
): string {
  const free = worktreesFor(branch, overview, sessions).find(
    (worktree) => worktree.openAs === undefined,
  );
  return free?.directory ?? branch;
}

/** Everything the branch half of the form has resolved to. */
export interface SessionDraft {
  readonly branch: string;
  readonly start: SessionStart;
  /**
   * An existing worktree's directory, which is adopted, or a name for a new
   * one, which is created. Read only for the `worktree` start.
   */
  readonly worktree: string;
  /** Where a branch that does not exist yet begins. Read only then. */
  readonly startPoint: string;
}

/** The wire intent for a draft, or `undefined` when it is not ready to be sent. */
export function newSessionIntent(
  projectID: ProjectID,
  draft: SessionDraft,
  overview: BranchOverview,
  sessions: readonly Session[],
): SessionCreationIntent | undefined {
  const branch = draft.branch.trim();
  if (branch === "") return undefined;

  const choice = startChoices(branch, overview, sessions).find(
    (entry) => entry.start === draft.start,
  );
  if (choice === undefined || choice.refusal !== undefined) return undefined;

  if (draft.start === "checkout") return { kind: "inProject", projectID, branch };

  // A value that names a worktree git already lists is that worktree; anything
  // else is a name for one that does not exist yet. The field offers both, so
  // this is the only place the two are told apart.
  const listed = worktreesFor(branch, overview, sessions);
  const adopted = listed.find(
    (worktree) => worktree.directory === draft.worktree && worktree.openAs === undefined,
  );
  if (adopted !== undefined) {
    return { kind: "adoptWorktree", projectID, directory: adopted.directory };
  }
  // A path that is not an adoptable worktree — one already open as a session,
  // or one this branch no longer has — is not a *name* for a new worktree
  // either. Sending it would create `.worktrees/Users-x-code-…`.
  if (draft.worktree.trim().startsWith("/")) return undefined;

  // Required rather than defaulted here: the field arrives holding a name, and
  // a worktree the user has cleared has no directory to land in either.
  const name = draft.worktree.trim();
  if (name === "") return undefined;

  const startPoint = draft.startPoint.trim();
  const isNewBranch = !overview.branches.includes(branch);
  const isHeld =
    isInProject(branch, overview) || overview.worktrees.some((w) => w.branch === branch);

  return {
    kind: "newWorktree",
    projectID,
    branch,
    name,
    // Only for a branch being created: git checks an existing one out where it
    // already points, and a start point would be a second opinion.
    ...(isNewBranch && startPoint !== "" ? { startPoint } : {}),
    // git's one-place-per-branch rule, overridden because the field said it
    // would be.
    ...(isHeld ? { shareBranch: true } : {}),
  };
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
      : newSessionIntent(
          project.id,
          {
            branch: resolved.branch,
            start: resolved.start,
            worktree: resolved.worktree,
            startPoint: resolved.startPoint,
          },
          overview.overview,
          sessions,
        );
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

// MARK: - A repository's branch, start and worktree

/**
 * What the user has said so far about the branch fields. Kept as *choices*
 * rather than resolved values, so a project switch or an overview that arrives
 * later re-derives the preselection instead of correcting stale state.
 *
 * `undefined` therefore means "still following the branch", which is what makes
 * the worktree field track a branch the user changes until they answer it
 * themselves.
 */
interface BranchChoice {
  readonly branch?: string;
  readonly start?: SessionStart;
  readonly worktree?: string;
  readonly startPoint?: string;
}

const NO_CHOICE: BranchChoice = {};

/**
 * The branch, start and worktree the form shows: the chosen ones where the
 * overview still permits them, else the preselection. Changing the branch
 * re-selects the first start it permits, until the user picks one that the new
 * branch also permits.
 */
function resolveBranchChoice(
  project: Project,
  overview: BranchOverview,
  sessions: readonly Session[],
  choice: BranchChoice,
): {
  readonly branch: string;
  /** Typed rather than picked: the only start that can make one is a worktree. */
  readonly isNewBranch: boolean;
  readonly choices: readonly StartChoice[];
  readonly start: SessionStart | undefined;
  readonly worktrees: readonly WorktreeChoice[];
  readonly worktree: string;
  readonly startPoint: string;
} {
  const preselected = preselectedBranch(project, overview) ?? "";
  // Kept as chosen, including a name no branch has: that is how a new branch is
  // asked for, and validating it here would be a second opinion on what git
  // allows a branch to be called (AGENTS.md § Non-negotiables 3).
  const branch = choice.branch ?? preselected;
  const choices = startChoices(branch, overview, sessions);
  const permitted = choices.find(
    (candidate) => candidate.start === choice.start && candidate.refusal === undefined,
  );
  const worktrees = worktreesFor(branch, overview, sessions);
  // An adopted worktree is remembered by *path*, and a path is only an answer
  // while git still lists it against this branch and no session holds it. A
  // branch change therefore drops it; a name the user typed survives one.
  const chosen = choice.worktree;
  const isStalePath =
    chosen !== undefined &&
    chosen.startsWith("/") &&
    !worktrees.some((worktree) => worktree.directory === chosen && worktree.openAs === undefined);

  return {
    branch,
    isNewBranch: branch !== "" && !overview.branches.includes(branch),
    choices,
    start: permitted?.start ?? defaultStart(choices),
    worktrees,
    worktree:
      chosen === undefined || isStalePath
        ? preselectedWorktree(branch, overview, sessions)
        : chosen,
    startPoint: choice.startPoint ?? preselected,
  };
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
  const { branch, isNewBranch, choices, start, worktrees, worktree, startPoint } = useMemo(
    () => resolveBranchChoice(project, overview, sessions, choice),
    [project, overview, sessions, choice],
  );

  const handleBranch = useCallback(
    (value: string) => {
      onChoice({ ...choice, branch: value });
    },
    [onChoice, choice],
  );
  const handleStart = useCallback(
    (value: unknown) => {
      onChoice({ ...choice, start: value as SessionStart });
    },
    [onChoice, choice],
  );
  const handleWorktree = useCallback(
    (value: string) => {
      onChoice({ ...choice, worktree: value });
    },
    [onChoice, choice],
  );
  const handleStartPoint = useCallback(
    (value: string) => {
      onChoice({ ...choice, startPoint: value });
    },
    [onChoice, choice],
  );

  return (
    <>
      <RefField
        label="Branch"
        branches={overview.branches}
        value={branch}
        icon={BRANCH_ICON}
        placeholder="feature/x"
        emptyLabel="No branch matches."
        description={
          overview.branches.length === 0
            ? "This repository has no branches yet. The name you type will be the first."
            : isNewBranch
              ? "A new branch, created with the worktree."
              : // Said even while a branch is chosen: typing a name is the only
                // way to a new branch, and a capability nothing mentions is one
                // nobody finds.
                "Pick a branch, or type a name to create one."
        }
        isInitialFocus
        onChange={handleBranch}
      />

      {isNewBranch ? (
        <RefField
          label="Start point"
          branches={overview.branches}
          value={startPoint}
          icon={COMMIT_ICON}
          placeholder="main"
          emptyLabel="No branch matches. A tag or a commit is a start point too."
          description="Where the new branch begins: a branch from the list, or a tag or commit you type."
          onChange={handleStartPoint}
        />
      ) : undefined}

      <Field>
        <FieldLabel>Start</FieldLabel>
        {branch === "" ? (
          <FieldDescription>Name a branch first.</FieldDescription>
        ) : (
          <RadioGroup value={start ?? ""} onValueChange={handleStart} aria-label="Start">
            {choices.map((entry) => (
              <StartOption key={entry.start} choice={entry} />
            ))}
          </RadioGroup>
        )}
      </Field>

      {start === "worktree" ? (
        <WorktreeField
          worktrees={worktrees}
          value={worktree}
          branch={branch}
          isNewBranch={isNewBranch}
          isHeld={isInProject(branch, overview) || worktrees.length > 0}
          heldInProject={isInProject(branch, overview)}
          onChange={handleWorktree}
        />
      ) : undefined}
    </>
  );
}

const BRANCH_ICON = hugeicon(GitBranchIcon);
const COMMIT_ICON = hugeicon(GitCommitIcon);
const WORKTREE_ICON = hugeicon(FolderOpenIcon);

/**
 * The registry's combobox field is a hairline ring on nothing; every other
 * field in this window is base-mira's — `rounded-md`, a solid `--input` border
 * and a faint fill. Beside the project select, the two read as different kinds
 * of control, so the comboboxes take the skin the form already has. One
 * constant, so the two of them cannot drift from each other either.
 *
 * The transition is narrowed with it: the registry's `transition-all` on a
 * field where only colour changes would animate a layout change too.
 */
const FIELD_CLASS =
  "w-full rounded-md bg-input/20 dark:bg-input/30 ring-[color:var(--input)] font-mono transition-[color,background-color,box-shadow]";

/**
 * A ref by name: one of the project's branches, picked, or a name that is not
 * one of them, typed.
 *
 * One field rather than a select and a text box beside it, because "which
 * branch" is one question — and the same question the start point asks, which
 * is why one component answers both. The create row is the combobox's own: it
 * appears the moment the query matches no branch exactly, and picking it is
 * what makes the typed name the field's value.
 */
function RefField(props: {
  readonly label: string;
  readonly branches: readonly string[];
  readonly value: string;
  readonly icon: IconComponent;
  readonly placeholder: string;
  /** What this field will do with what it holds. Never silence. */
  readonly description: string;
  readonly emptyLabel: string;
  /** The field the sheet opens focused, as `TextField isInitialFocus` is. */
  readonly isInitialFocus?: boolean;
  readonly onChange: (value: string) => void;
}): ReactElement {
  const { label, branches, value, icon, placeholder, description, emptyLabel } = props;
  const { isInitialFocus = false, onChange } = props;
  const id = useId();

  // A controlled value is only displayed while it is one of the items, so a
  // name the user typed joins the list it was not in.
  const items = useMemo(
    () => (value === "" || branches.includes(value) ? branches : [...branches, value]),
    [branches, value],
  );
  const create = useCallback((query: string) => query, []);
  const handleChange = useCallback(
    (next: string | string[]) => {
      onChange(typeof next === "string" ? next : (next[0] ?? ""));
    },
    [onChange],
  );
  const renderRow = useCallback((item: ComboboxItemData) => {
    const name = typeof item === "string" ? item : item.value;
    return (
      <ComboboxItem value={name} className="font-mono">
        {name}
      </ComboboxItem>
    );
  }, []);

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Combobox items={items} value={value} onValueChange={handleChange} onCreate={create}>
        <ComboboxInput
          id={id}
          icon={icon}
          className={FIELD_CLASS}
          placeholder={placeholder}
          {...(isInitialFocus ? { "data-autofocus": "" } : {})}
        />
        <ComboboxContent>
          <ComboboxEmpty>{emptyLabel}</ComboboxEmpty>
          <ComboboxList>{renderRow}</ComboboxList>
        </ComboboxContent>
      </Combobox>
      <FieldDescription>{description}</FieldDescription>
    </Field>
  );
}

/**
 * The worktree: one of the project's that already has this branch, or a name
 * for one that does not exist yet.
 *
 * The same field answers both, which is why there is no "use the existing
 * worktree" choice above it: a worktree that exists is a row in the list, and
 * a second one is a name typed into it.
 */
function WorktreeField(props: {
  readonly worktrees: readonly WorktreeChoice[];
  readonly value: string;
  readonly branch: string;
  readonly isNewBranch: boolean;
  /** The branch is checked out somewhere, so a new worktree would share it. */
  readonly isHeld: boolean;
  readonly heldInProject: boolean;
  readonly onChange: (value: string) => void;
}): ReactElement {
  const { worktrees, value, branch, isNewBranch, isHeld, heldInProject, onChange } = props;
  const id = useId();

  const adopted = worktrees.find((worktree) => worktree.directory === value);
  const items = useMemo(() => {
    const listed = worktrees.map((worktree) => ({
      value: worktree.directory as string,
      label: worktree.name,
    }));
    // The typed name is an item too, for the same reason the branch's is: the
    // field shows a controlled value only while the list contains it.
    return worktrees.some((worktree) => worktree.directory === value) || value === ""
      ? listed
      : [...listed, { value, label: value }];
  }, [worktrees, value]);

  const create = useCallback((query: string) => ({ value: query, label: query }), []);
  const handleChange = useCallback(
    (next: string | string[]) => {
      onChange(typeof next === "string" ? next : (next[0] ?? ""));
    },
    [onChange],
  );
  const renderRow = useCallback(
    (item: ComboboxItemData) => {
      const rowValue = typeof item === "string" ? item : item.value;
      const listed = worktrees.find((worktree) => worktree.directory === rowValue);
      return (
        <ComboboxItem
          value={rowValue}
          className="font-mono"
          disabled={listed?.openAs !== undefined}
        >
          {listed === undefined ? rowValue : listed.name}
          {listed?.openAs === undefined ? undefined : (
            <span className="text-muted-foreground ml-2 font-sans">open as “{listed.openAs}”</span>
          )}
        </ComboboxItem>
      );
    },
    [worktrees],
  );

  return (
    <Field>
      <FieldLabel htmlFor={id}>Worktree</FieldLabel>
      <Combobox items={items} value={value} onValueChange={handleChange} onCreate={create}>
        <ComboboxInput id={id} icon={WORKTREE_ICON} className={FIELD_CLASS} placeholder={branch} />
        <ComboboxContent>
          <ComboboxEmpty>No worktree has this branch yet.</ComboboxEmpty>
          <ComboboxList>{renderRow}</ComboboxList>
        </ComboboxContent>
      </Combobox>
      <FieldDescription>
        {adopted !== undefined
          ? `Uses the worktree at ${adopted.directory}.`
          : isHeld
            ? // The cost is stated where the decision is made: git keeps a
              // branch in one place, and this is the field that overrides it.
              `A new worktree, sharing the branch with ${
                heldInProject
                  ? "the project directory"
                  : (worktrees[0]?.directory ?? "another worktree")
              } — a commit in one moves the other.`
            : isNewBranch
              ? "A new worktree, where the branch is created. Names the session too."
              : "A new worktree. Names the session and the directory it lands in."}
      </FieldDescription>
    </Field>
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
