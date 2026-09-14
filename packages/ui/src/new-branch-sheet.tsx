import { supportsWorktrees, type Project, type ProjectID } from "@janela/core";
import {
  Button,
  DialogFooter,
  Empty,
  EmptyDescription,
  EmptyHeader,
  Field,
  FieldGroup,
  FieldLabel,
  NativeSelect,
  NativeSelectOption,
} from "@janela/design";
import type { ChangeEvent, FormEvent, ReactElement } from "react";
import { useCallback, useId, useMemo, useState } from "react";

import { TextField } from "./controls.tsx";

/**
 * ⌘⇧B: a new branch to work on.
 *
 * One of the five creation cases, not a feature of its own — this sheet collects a
 * project, a branch name and a start point, and hands them to the same
 * `createSession` every other case goes through (AGENTS.md § Non-negotiables 1).
 *
 * The branch name is checked for being non-empty and nothing else. git decides what
 * a branch may be called, and a second opinion here would eventually disagree with
 * it (AGENTS.md § Non-negotiables 3).
 */

export interface NewBranchIntent {
  readonly projectID: ProjectID;
  readonly branch: string;
  readonly startPoint?: string;
}

/**
 * What the start point field starts as: the project's default branch.
 *
 * Almost every new branch comes off the default one, and typing `main` again is a
 * question the app already knows the answer to.
 */
export function preselectedStartPoint(project: Project | undefined): string {
  return project?.git?.defaultBranch ?? "";
}

/**
 * The intent a draft describes, or `undefined` when it is not ready to be sent.
 *
 * A blank start point is *omitted* rather than sent empty: absent means "the
 * project's default", which is what the daemon does with it, and `""` would be a
 * revision git cannot resolve.
 */
export function newBranchDraft(
  projectID: ProjectID | undefined,
  branch: string,
  startPoint: string,
): NewBranchIntent | undefined {
  const trimmedBranch = branch.trim();
  if (projectID === undefined || trimmedBranch.length === 0) return undefined;
  const trimmedStart = startPoint.trim();
  return {
    projectID,
    branch: trimmedBranch,
    ...(trimmedStart.length === 0 ? {} : { startPoint: trimmedStart }),
  };
}

export interface NewBranchSheetProps {
  readonly projects: readonly Project[];
  /** The session's project, when there is one. Ignored if it has no git. */
  readonly initialProjectID?: ProjectID;
  readonly onCreate: (intent: NewBranchIntent) => void;
  readonly onCancel: () => void;
}

export function NewBranchSheet(props: NewBranchSheetProps): ReactElement {
  const { projects, initialProjectID, onCreate, onCancel } = props;

  // Only repositories: a plain-folder project has no worktrees to create, and
  // offering it would produce a refusal the user could have been spared.
  const eligible = useMemo(() => projects.filter(supportsWorktrees), [projects]);

  const [chosenID, setChosenID] = useState<ProjectID | undefined>(undefined);
  const preferred = eligible.some((project) => project.id === initialProjectID)
    ? initialProjectID
    : eligible[0]?.id;
  const projectID = eligible.some((project) => project.id === chosenID) ? chosenID : preferred;
  const project = eligible.find((candidate) => candidate.id === projectID);

  const [branch, setBranch] = useState("");
  // Derived, not stored-and-corrected: switching project re-preselects the start
  // point until the user has said otherwise, and then never overrides them.
  const [editedStartPoint, setEditedStartPoint] = useState<string | undefined>(undefined);
  const startPoint = editedStartPoint ?? preselectedStartPoint(project);

  const projectFieldID = useId();

  const draft = newBranchDraft(projectID, branch, startPoint);

  const handleProject = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      setChosenID(event.target.value as ProjectID);
      setEditedStartPoint(undefined);
    },
    [setChosenID, setEditedStartPoint],
  );

  const handleBranch = useCallback(
    (value: string) => {
      setBranch(value);
    },
    [setBranch],
  );

  const handleStartPoint = useCallback(
    (value: string) => {
      setEditedStartPoint(value);
    },
    [setEditedStartPoint],
  );

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (draft !== undefined) onCreate(draft);
    },
    [draft, onCreate],
  );

  if (eligible.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyDescription>Add a git repository as a project first.</EmptyDescription>
        </EmptyHeader>
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </Empty>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={projectFieldID}>Project</FieldLabel>
          <NativeSelect
            id={projectFieldID}
            className="w-full"
            value={projectID ?? ""}
            onChange={handleProject}
          >
            {eligible.map((candidate) => (
              <NativeSelectOption key={candidate.id} value={candidate.id}>
                {candidate.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>

        {/* The sheet exists to be typed into: the project is usually already
            right, so `SheetHost` opens focus here rather than on the select. */}
        <TextField
          label="Branch name"
          value={branch}
          onChange={handleBranch}
          placeholder="feature/x"
          isInitialFocus
        />

        <TextField
          label="Start point"
          value={startPoint}
          onChange={handleStartPoint}
          placeholder="main"
          isMonospaced
        />

        <DialogFooter>
          <Button variant="outline" type="button" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={draft === undefined}>
            Create Session
          </Button>
        </DialogFooter>
      </FieldGroup>
    </form>
  );
}
