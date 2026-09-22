import { absolutePath, type AbsolutePath } from "@janela/core";
import type { DirectoryListing } from "@janela/protocol";

export interface DirectoryColumns {
  readonly root: AbsolutePath;
  readonly path: readonly string[];
  readonly focused: number;
}

export type DirectoryStep = -1 | 1;

const ROOT = "/";

const SEPARATOR = "/";

const TRAILING_SLASHES = /\/+$/;

export function typedDirectory(text: string): AbsolutePath | undefined {
  const trimmed = text.trim();

  if (!trimmed.startsWith(ROOT)) return undefined;

  const stripped = trimmed.replace(TRAILING_SLASHES, "");

  return absolutePath(stripped === "" ? ROOT : stripped);
}

export function childPath(directory: AbsolutePath, name: string): AbsolutePath {
  return absolutePath(directory === ROOT ? `${ROOT}${name}` : `${directory}${SEPARATOR}${name}`);
}

export function lastComponent(directory: AbsolutePath): string {
  return directory === ROOT ? ROOT : directory.slice(directory.lastIndexOf(SEPARATOR) + 1);
}

export function openColumns(root: AbsolutePath): DirectoryColumns {
  return { root, path: [], focused: 0 };
}

export function columnDirectories(columns: DirectoryColumns): readonly AbsolutePath[] {
  const directories: AbsolutePath[] = [columns.root];

  for (const name of columns.path) {
    const parent = directories.at(-1);

    if (parent !== undefined) directories.push(childPath(parent, name));
  }

  return directories;
}

export function chosenDirectory(columns: DirectoryColumns): AbsolutePath {
  return columnDirectories(columns).at(-1) ?? columns.root;
}

export function selectionIn(columns: DirectoryColumns, column: number): string | undefined {
  return columns.path[column];
}

export function openEntry(
  columns: DirectoryColumns,
  column: number,
  name: string,
): DirectoryColumns {
  if (column < 0 || column > columns.path.length) return columns;

  return { root: columns.root, path: [...columns.path.slice(0, column), name], focused: column };
}

export function stepSelection(
  columns: DirectoryColumns,
  listing: DirectoryListing,
  step: DirectoryStep,
): DirectoryColumns {
  const folders = listing.entries.filter((entry) => entry.kind === "directory");

  if (folders.length === 0) return columns;

  const current = selectionIn(columns, columns.focused);
  const index = current === undefined ? -1 : folders.findIndex((entry) => entry.name === current);
  const next =
    index === -1
      ? step === 1
        ? 0
        : folders.length - 1
      : Math.min(Math.max(index + step, 0), folders.length - 1);

  const chosen = folders[next];

  if (chosen === undefined || chosen.name === current) return columns;

  return openEntry(columns, columns.focused, chosen.name);
}

export function focusColumn(columns: DirectoryColumns, column: number): DirectoryColumns {
  const clamped = Math.min(Math.max(column, 0), columns.path.length);

  return clamped === columns.focused ? columns : { ...columns, focused: clamped };
}

export function goTo(directory: AbsolutePath): DirectoryColumns {
  return openColumns(directory);
}

export function goUp(columns: DirectoryColumns, parent: AbsolutePath): DirectoryColumns {
  return {
    root: parent,
    path: [lastComponent(columns.root), ...columns.path],
    focused: columns.focused + 1,
  };
}
