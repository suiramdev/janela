import { supportsWorktrees, type Project, type ProjectID } from "@janela/core";
import type { ChangeEvent, FormEvent, ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import * as style from "./styles.ts";

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

  const branchRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    // The sheet exists to be typed into: the project is usually already right.
    branchRef.current?.focus();
  }, []);

  const draft = newBranchDraft(projectID, branch, startPoint);

  const handleProject = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      setChosenID(event.target.value as ProjectID);
      setEditedStartPoint(undefined);
    },
    [setChosenID, setEditedStartPoint],
  );

  const handleBranch = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setBranch(event.target.value);
    },
    [setBranch],
  );

  const handleStartPoint = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setEditedStartPoint(event.target.value);
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
      <div style={style.PICKER}>
        <p style={style.HINT}>Add a git repository as a project first.</p>
        <button type="button" style={style.BUTTON} onClick={onCancel}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <form style={style.PICKER} onSubmit={handleSubmit}>
      <label style={style.FIELD}>
        <span style={style.FIELD_LABEL}>Project</span>
        <select style={style.INPUT} value={projectID ?? ""} onChange={handleProject}>
          {eligible.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </label>

      <label style={style.FIELD}>
        <span style={style.FIELD_LABEL}>Branch name</span>
        <input
          ref={branchRef}
          type="text"
          style={style.INPUT}
          value={branch}
          onChange={handleBranch}
          placeholder="feature/x"
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      <label style={style.FIELD}>
        <span style={style.FIELD_LABEL}>Start point</span>
        <input
          type="text"
          style={style.INPUT}
          value={startPoint}
          onChange={handleStartPoint}
          placeholder="main"
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      <div style={style.ROW}>
        <button type="submit" style={style.BUTTON} disabled={draft === undefined}>
          Create Session
        </button>
        <button type="button" style={style.BUTTON} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
