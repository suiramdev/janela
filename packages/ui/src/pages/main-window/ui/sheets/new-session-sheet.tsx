import { FolderOpenIcon, GitBranchIcon, GitCommitIcon } from "@hugeicons/core-free-icons";
import { RequestFailed, type DaemonConnection } from "@janela/client";
import {
  absolutePath,
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
import { Match } from "effect";
import type { ChangeEvent, ComponentProps, FormEvent, ReactElement } from "react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";

export type SessionStart = "checkout" | "worktree";

export interface StartChoice {
  readonly start: SessionStart;
  readonly title: string;
  readonly detail: string;
  readonly refusal?: string;
}

export interface WorktreeChoice {
  readonly directory: AbsolutePath;
  readonly name: string;
  readonly openAs?: string;
}

export interface ResolvedBranchChoice {
  readonly branch: string;
  readonly isNewBranch: boolean;
  readonly choices: readonly StartChoice[];
  readonly start: SessionStart | undefined;
  readonly worktrees: readonly WorktreeChoice[];
  readonly worktree: string;
  readonly startPoint: string;
}

type StartChangeHandler = NonNullable<ComponentProps<typeof RadioGroup>["onValueChange"]>;

export interface SessionDraft {
  readonly branch: string;
  readonly start: SessionStart;
  readonly worktree: string;
  readonly startPoint: string;
}

export type BranchOverviewState =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly overview: BranchOverview }
  | { readonly kind: "failed"; readonly summary: string };

export interface NewSessionSheetProps {
  readonly projects: readonly Project[];
  readonly projectID: ProjectID | undefined;
  readonly onProjectChange: (projectID: ProjectID | undefined) => void;
  readonly overview: BranchOverviewState;
  readonly sessions: readonly Session[];
  readonly onPickDirectory: () => Promise<AbsolutePath | undefined>;
  readonly onCreate: (intent: SessionCreationIntent) => void;
  readonly onCancel: () => void;
}

interface BranchChoice {
  readonly branch?: string;
  readonly start?: SessionStart;
  readonly worktree?: string;
  readonly startPoint?: string;
}

const LOADING: BranchOverviewState = { kind: "loading" };

const NO_PROJECT = "";

const NO_CHOICE: BranchChoice = {};

const BRANCH_ICON = hugeicon(GitBranchIcon);

const COMMIT_ICON = hugeicon(GitCommitIcon);

const WORKTREE_ICON = hugeicon(FolderOpenIcon);

const FIELD_CLASS =
  "w-full rounded-md bg-input/20 dark:bg-input/30 ring-[color:var(--input)] font-mono transition-[color,background-color,box-shadow]";

function itemValue(item: ComboboxItemData): string {
  return Match.value(item).pipe(
    Match.when(Match.string, (text) => text),
    Match.orElse((data) => data.value),
  );
}

function lastComponent(directory: string): string {
  return directory.slice(directory.lastIndexOf("/") + 1);
}

export function worktreesFor(
  branch: string,
  overview: BranchOverview,
  sessions: readonly Session[],
): readonly WorktreeChoice[] {
  return overview.worktrees
    .filter((worktree) => worktree.branch === branch && !worktree.isMain)
    .map((worktree) => {
      const open = sessions.find((session) => session.directory === worktree.directory);

      const choice: WorktreeChoice = {
        directory: worktree.directory,
        name: lastComponent(worktree.directory),
      };

      return open === undefined ? choice : { ...choice, openAs: open.name };
    });
}

function isInProject(branch: string, overview: BranchOverview): boolean {
  return overview.worktrees.some((worktree) => worktree.isMain && worktree.branch === branch);
}

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
        ? { refusal: "This branch does not exist yet." }
        : inProject
          ? {}
          : held === undefined
            ? {}
            : { refusal: `Checked out in the worktree at ${held.directory}.` }),
    },
    {
      start: "worktree",
      title: "Use a worktree",
      detail:
        held === undefined
          ? "A directory of its own, beside the project's other worktrees."
          : "The worktree this branch already has, or a new one you name.",
    },
  ];
}

export function defaultStart(choices: readonly StartChoice[]): SessionStart | undefined {
  return choices.find((choice) => choice.refusal === undefined)?.start;
}

export function preselectedBranch(project: Project, overview: BranchOverview): string | undefined {
  const preferred = project.git?.defaultBranch;

  if (preferred !== undefined && overview.branches.includes(preferred)) return preferred;

  const main = overview.worktrees.find((worktree) => worktree.isMain)?.branch;

  if (main !== undefined && overview.branches.includes(main)) return main;

  return overview.branches[0];
}

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

  const listed = worktreesFor(branch, overview, sessions);

  const adopted = listed.find(
    (worktree) => worktree.directory === draft.worktree && worktree.openAs === undefined,
  );

  if (adopted !== undefined) {
    return { kind: "adoptWorktree", projectID, directory: adopted.directory };
  }

  if (draft.worktree.trim().startsWith("/")) return undefined;

  const name = draft.worktree.trim();

  if (name === "") return undefined;

  const startPoint = draft.startPoint.trim();
  const isNewBranch = !overview.branches.includes(branch);

  const isHeld =
    isInProject(branch, overview) || overview.worktrees.some((w) => w.branch === branch);

  type NewWorktree = Extract<SessionCreationIntent, { readonly kind: "newWorktree" }>;

  const worktree: NewWorktree = { kind: "newWorktree", projectID, branch, name };

  const started = isNewBranch && startPoint !== "" ? { ...worktree, startPoint } : worktree;

  return isHeld ? { ...started, shareBranch: true } : started;
}

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
      (cause: unknown) => {
        if (cancelled) return;

        const summary =
          cause instanceof RequestFailed ? cause.failure.summary : "Could not read the branches.";

        setAnswer({ projectID, state: { kind: "failed", summary } });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [connection, projectID]);

  return answer !== undefined && answer.projectID === projectID ? answer.state : LOADING;
}

export function standaloneIntent(directory: string): SessionCreationIntent | undefined {
  const trimmed = directory.trim();

  return trimmed.startsWith("/")
    ? { kind: "standalone", directory: absolutePath(trimmed) }
    : undefined;
}

export function NewSessionSheet(props: NewSessionSheetProps): ReactElement {
  const { projects, projectID, onProjectChange, overview, sessions, onPickDirectory } = props;
  const { onCreate, onCancel } = props;
  const project = projects.find((candidate) => candidate.id === projectID);

  const [directory, setDirectory] = useState("");
  const [branchChoice, setBranchChoice] = useState<BranchChoice>(NO_CHOICE);

  const projectFieldID = useId();

  const handleProject = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const chosen = projects.find((candidate) => candidate.id === event.target.value);

      onProjectChange(chosen?.id);
    },
    [onProjectChange, projects],
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

function resolveBranchChoice(
  project: Project,
  overview: BranchOverview,
  sessions: readonly Session[],
  choice: BranchChoice,
): ResolvedBranchChoice {
  const preselected = preselectedBranch(project, overview) ?? "";
  const branch = choice.branch ?? preselected;
  const choices = startChoices(branch, overview, sessions);

  const permitted = choices.find(
    (candidate) => candidate.start === choice.start && candidate.refusal === undefined,
  );

  const worktrees = worktreesFor(branch, overview, sessions);
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

  const handleStart = useCallback<StartChangeHandler>(
    (value) => {
      const picked = choices.find((candidate) => candidate.start === value);

      if (picked !== undefined) onChoice({ ...choice, start: picked.start });
    },
    [choices, onChoice, choice],
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
              : "Pick a branch, or type a name to create one."
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

function RefField(props: {
  readonly label: string;
  readonly branches: readonly string[];
  readonly value: string;
  readonly icon: IconComponent;
  readonly placeholder: string;
  readonly description: string;
  readonly emptyLabel: string;
  readonly isInitialFocus?: boolean;
  readonly onChange: (value: string) => void;
}): ReactElement {
  const { label, branches, value, icon, placeholder, description, emptyLabel } = props;
  const { isInitialFocus = false, onChange } = props;
  const id = useId();

  const items = useMemo(
    () => (value === "" || branches.includes(value) ? branches : [...branches, value]),
    [branches, value],
  );

  const create = useCallback((query: string) => query, []);

  const handleChange = useCallback(
    (next: string | string[]) => {
      onChange(Array.isArray(next) ? (next[0] ?? "") : next);
    },
    [onChange],
  );

  const renderRow = useCallback((item: ComboboxItemData) => {
    const name = itemValue(item);

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

function WorktreeField(props: {
  readonly worktrees: readonly WorktreeChoice[];
  readonly value: string;
  readonly branch: string;
  readonly isNewBranch: boolean;
  readonly isHeld: boolean;
  readonly heldInProject: boolean;
  readonly onChange: (value: string) => void;
}): ReactElement {
  const { worktrees, value, branch, isNewBranch, isHeld, heldInProject, onChange } = props;
  const id = useId();

  const adopted = worktrees.find((worktree) => worktree.directory === value);

  const items = useMemo(() => {
    const listed = worktrees.map((worktree) => ({
      value: String(worktree.directory),
      label: worktree.name,
    }));

    return worktrees.some((worktree) => worktree.directory === value) || value === ""
      ? listed
      : [...listed, { value, label: value }];
  }, [worktrees, value]);

  const create = useCallback((query: string) => ({ value: query, label: query }), []);

  const handleChange = useCallback(
    (next: string | string[]) => {
      onChange(Array.isArray(next) ? (next[0] ?? "") : next);
    },
    [onChange],
  );

  const renderRow = useCallback(
    (item: ComboboxItemData) => {
      const rowValue = itemValue(item);
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
            ? `A new worktree, sharing the branch with ${
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
