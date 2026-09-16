import {
  ArrowRight01Icon,
  ArrowUp01Icon,
  File02Icon,
  Folder01Icon,
  Home01Icon,
} from "@hugeicons/core-free-icons";
import { RequestFailed } from "@janela/client";
import type { AbsolutePath } from "@janela/core";
import {
  Button,
  ButtonGroup,
  DialogFooter,
  DialogTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Input,
  Spinner,
  cn,
  hugeicon,
  sizeMap,
} from "@janela/design";
import type { DirectoryEntry, DirectoryListing } from "@janela/protocol";
import { Match } from "effect";
import type { ChangeEvent, KeyboardEvent, ReactElement } from "react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import {
  type DirectoryColumns,
  type DirectoryStep,
  childPath,
  chosenDirectory,
  columnDirectories,
  focusColumn,
  goTo,
  goUp,
  lastComponent,
  openColumns,
  openEntry,
  selectionIn,
  stepSelection,
  typedDirectory,
} from "../model/directory-columns.ts";

export interface DirectoryBrowserProps {
  readonly title: string;
  readonly load: (directory: AbsolutePath | undefined) => Promise<DirectoryListing>;
  readonly onChoose: (directory: AbsolutePath) => void;
  readonly onCancel: () => void;
}

export type ColumnState =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly listing: DirectoryListing }
  | { readonly kind: "failed"; readonly summary: string; readonly reason: string | undefined };

interface PathDraft {
  readonly of: AbsolutePath;
  readonly text: string;
}

const LOADING: ColumnState = { kind: "loading" };

const EMPTY_LISTINGS: ReadonlyMap<AbsolutePath, ColumnState> = new Map();

const NO_DIRECTORIES: readonly AbsolutePath[] = [];

const FOLDER_ICON = hugeicon(Folder01Icon);

const FILE_ICON = hugeicon(File02Icon);

const CHEVRON_ICON = hugeicon(ArrowRight01Icon);

const UP_ICON = hugeicon(ArrowUp01Icon);

const HOME_ICON = hugeicon(Home01Icon);

const COLUMN_WIDTH_CLASS = "w-60";

const ROW_CLASS = cn(
  "mx-1 flex shrink-0 select-none items-center rounded-md",
  sizeMap.compact.control,
  sizeMap.compact.gap,
  sizeMap.compact.itemPx,
  sizeMap.compact.text,
);

const OPENING_FAILED = "Couldn't open that folder.";

const ENTRY_LIMIT_NOTICE = "Only the first 1,000 items are shown.";

function failure(cause: unknown): ColumnState {
  return cause instanceof RequestFailed
    ? { kind: "failed", summary: cause.failure.summary, reason: cause.failure.reason }
    : { kind: "failed", summary: OPENING_FAILED, reason: undefined };
}

function loaded(listing: DirectoryListing): ColumnState {
  return { kind: "loaded", listing };
}

function withState(
  listings: ReadonlyMap<AbsolutePath, ColumnState>,
  directory: AbsolutePath,
  state: ColumnState,
): ReadonlyMap<AbsolutePath, ColumnState> {
  return new Map(listings).set(directory, state);
}

export function DirectoryBrowser(props: DirectoryBrowserProps): ReactElement {
  const { title, load, onChoose, onCancel } = props;

  const [columns, setColumns] = useState<DirectoryColumns | undefined>(undefined);
  const [listings, setListings] = useState(EMPTY_LISTINGS);
  const [opening, setOpening] = useState(LOADING);
  const [draft, setDraft] = useState<PathDraft | undefined>(undefined);

  const requested = useRef(new Set<AbsolutePath>());
  const columnElements = useRef<(HTMLDivElement | null)[]>([]);

  const directories = useMemo(
    () => (columns === undefined ? NO_DIRECTORIES : columnDirectories(columns)),
    [columns],
  );

  const chosen = columns === undefined ? undefined : chosenDirectory(columns);
  const rootListing = columns === undefined ? undefined : listings.get(columns.root);
  const home = rootListing?.kind === "loaded" ? rootListing.listing.home : undefined;
  const parent = rootListing?.kind === "loaded" ? rootListing.listing.parent : undefined;
  const deepest = chosen === undefined ? undefined : listings.get(chosen);
  const canChoose = chosen !== undefined && deepest?.kind === "loaded";

  useEffect(() => {
    if (columns !== undefined) return undefined;

    let cancelled = false;

    load(undefined).then(
      (listing) => {
        if (cancelled) return undefined;

        requested.current.add(listing.directory);
        setListings((previous) => withState(previous, listing.directory, loaded(listing)));
        setColumns(openColumns(listing.directory));

        return undefined;
      },
      (cause: unknown) => {
        if (!cancelled) setOpening(failure(cause));
      },
    );

    return () => {
      cancelled = true;
    };
  }, [columns, load]);

  useEffect(() => {
    let cancelled = false;

    for (const directory of directories) {
      if (requested.current.has(directory)) continue;

      requested.current.add(directory);

      load(directory).then(
        (listing) => {
          if (!cancelled)
            setListings((previous) => withState(previous, directory, loaded(listing)));

          return undefined;
        },
        (cause: unknown) => {
          if (!cancelled) setListings((previous) => withState(previous, directory, failure(cause)));
        },
      );
    }

    return () => {
      cancelled = true;
    };
  }, [directories, load]);

  useEffect(() => {
    if (columns === undefined) return;

    const focused = columnElements.current[columns.focused];
    const beside = columnElements.current[columns.focused + 1];

    focused?.focus({ preventScroll: true });
    focused?.scrollIntoView({ inline: "nearest", block: "nearest" });
    beside?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [columns]);

  const open = useCallback((column: number, name: string) => {
    setColumns((current) => (current === undefined ? current : openEntry(current, column, name)));
  }, []);

  const choose = useCallback(
    (directory: AbsolutePath) => {
      onChoose(directory);
    },
    [onChoose],
  );

  const chooseCurrent = useCallback(() => {
    if (canChoose && chosen !== undefined) onChoose(chosen);
  }, [canChoose, chosen, onChoose]);

  const step = useCallback(
    (direction: DirectoryStep): boolean => {
      if (columns === undefined) return false;

      const focused = directories[columns.focused];
      const state = focused === undefined ? undefined : listings.get(focused);

      if (state?.kind !== "loaded") return false;

      setColumns(stepSelection(columns, state.listing, direction));

      return true;
    },
    [columns, directories, listings],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (columns === undefined) return;

      const handled = Match.value(event.key).pipe(
        Match.when("ArrowDown", () => step(1)),
        Match.when("ArrowUp", () => step(-1)),
        Match.when("ArrowRight", () => {
          if (columns.focused < columns.path.length) {
            setColumns(focusColumn(columns, columns.focused + 1));

            return true;
          }

          return step(1);
        }),
        Match.when("ArrowLeft", () => {
          setColumns(focusColumn(columns, columns.focused - 1));

          return true;
        }),
        Match.when("Enter", () => {
          chooseCurrent();

          return true;
        }),
        Match.orElse(() => false),
      );

      if (handled) event.preventDefault();
    },
    [columns, step, chooseCurrent],
  );

  const goToParent = useCallback(() => {
    if (columns !== undefined && parent !== undefined) setColumns(goUp(columns, parent));
  }, [columns, parent]);

  const goHome = useCallback(() => {
    if (home !== undefined) setColumns(goTo(home));
  }, [home]);

  const handleDraft = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      if (chosen !== undefined) setDraft({ of: chosen, text: event.target.value });
    },
    [chosen],
  );

  const commitDraft = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Enter") return;

      event.preventDefault();

      const typed = typedDirectory(draft?.text ?? chosen ?? "");

      if (typed === undefined) return;

      setDraft(undefined);
      setColumns(goTo(typed));
    },
    [chosen, draft],
  );

  const registerColumn = useCallback((index: number, element: HTMLDivElement | null) => {
    columnElements.current[index] = element;
  }, []);

  const atHome = home !== undefined && columns?.root === home && columns.path.length === 0;

  return (
    <>
      <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <DialogTitle className="truncate">{title}</DialogTitle>
        <ButtonGroup>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Enclosing Folder"
            title="Enclosing Folder"
            disabled={parent === undefined}
            onClick={goToParent}
          >
            <UP_ICON size={12} />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Home"
            title="Home"
            disabled={home === undefined || atHome}
            onClick={goHome}
          >
            <HOME_ICON size={12} />
          </Button>
        </ButtonGroup>
      </header>

      <div className="flex min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
        {columns === undefined ? (
          <ColumnBody state={opening} />
        ) : (
          directories.map((directory, index) => (
            <Column
              key={directory}
              directory={directory}
              index={index}
              state={listings.get(directory) ?? LOADING}
              selected={selectionIn(columns, index)}
              focused={index === columns.focused}
              onOpen={open}
              onChoose={choose}
              onKeyDown={handleKeyDown}
              register={registerColumn}
            />
          ))
        )}
      </div>

      <DialogFooter className="mt-0 items-center gap-2 border-t px-4 py-3">
        <Input
          type="text"
          aria-label="Folder path"
          className="min-w-0 flex-1 font-mono"
          value={draft !== undefined && draft.of === chosen ? draft.text : (chosen ?? "")}
          onChange={handleDraft}
          onKeyDown={commitDraft}
          disabled={chosen === undefined}
          autoComplete="off"
          spellCheck={false}
        />
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" disabled={!canChoose} onClick={chooseCurrent}>
          Choose
        </Button>
      </DialogFooter>
    </>
  );
}

function Column(props: {
  readonly directory: AbsolutePath;
  readonly index: number;
  readonly state: ColumnState;
  readonly selected: string | undefined;
  readonly focused: boolean;
  readonly onOpen: (column: number, name: string) => void;
  readonly onChoose: (directory: AbsolutePath) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly register: (index: number, element: HTMLDivElement | null) => void;
}): ReactElement {
  const { directory, index, state, selected, focused, onOpen, onChoose, onKeyDown, register } =
    props;
  const listID = useId();

  const ref = useCallback(
    (element: HTMLDivElement | null) => {
      register(index, element);
    },
    [index, register],
  );

  const selectedIndex =
    state.kind === "loaded" && selected !== undefined
      ? state.listing.entries.findIndex((entry) => entry.name === selected)
      : -1;

  return (
    <div
      ref={ref}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a Finder column: one listbox per folder, rows carry icons and a chevron, and the selection is a folder that opens the next column; <select> cannot
      role="listbox"
      tabIndex={focused ? 0 : -1}
      aria-label={lastComponent(directory)}
      aria-activedescendant={selectedIndex === -1 ? undefined : `${listID}-${selectedIndex}`}
      data-autofocus={focused ? "" : undefined}
      onKeyDown={onKeyDown}
      className={cn(
        "flex shrink-0 flex-col overflow-y-auto border-r py-1 outline-none",
        "focus-visible:ring-1 focus-visible:ring-ring/40 focus-visible:ring-inset",
        "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-100",
        COLUMN_WIDTH_CLASS,
      )}
    >
      {state.kind === "loaded" ? (
        <Entries
          directory={directory}
          index={index}
          listID={listID}
          listing={state.listing}
          selected={selected}
          focused={focused}
          onOpen={onOpen}
          onChoose={onChoose}
        />
      ) : (
        <ColumnBody state={state} />
      )}
    </div>
  );
}

function Entries(props: {
  readonly directory: AbsolutePath;
  readonly index: number;
  readonly listID: string;
  readonly listing: DirectoryListing;
  readonly selected: string | undefined;
  readonly focused: boolean;
  readonly onOpen: (column: number, name: string) => void;
  readonly onChoose: (directory: AbsolutePath) => void;
}): ReactElement {
  const { directory, index, listID, listing, selected, focused, onOpen, onChoose } = props;

  if (listing.entries.length === 0) {
    return <ColumnNotice>Empty folder</ColumnNotice>;
  }

  return (
    <>
      {listing.entries.map((entry, position) => (
        <Row
          key={entry.name}
          id={`${listID}-${position}`}
          entry={entry}
          column={index}
          selected={entry.name === selected}
          lit={focused}
          onOpen={onOpen}
          onChoose={entry.kind === "directory" ? onChoose : undefined}
          path={childPath(directory, entry.name)}
        />
      ))}
      {listing.truncated ? <ColumnNotice>{ENTRY_LIMIT_NOTICE}</ColumnNotice> : null}
    </>
  );
}

function Row(props: {
  readonly id: string;
  readonly entry: DirectoryEntry;
  readonly column: number;
  readonly path: AbsolutePath;
  readonly selected: boolean;
  readonly lit: boolean;
  readonly onOpen: (column: number, name: string) => void;
  readonly onChoose: ((directory: AbsolutePath) => void) | undefined;
}): ReactElement {
  const { id, entry, column, path, selected, lit, onOpen, onChoose } = props;
  const isFolder = entry.kind === "directory";
  const element = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (selected) element.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const handleClick = useCallback(() => {
    if (isFolder) onOpen(column, entry.name);
  }, [isFolder, onOpen, column, entry.name]);

  const handleDoubleClick = useCallback(() => {
    onChoose?.(path);
  }, [onChoose, path]);

  const Icon = isFolder ? FOLDER_ICON : FILE_ICON;

  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- the keyboard is handled by the listbox, through aria-activedescendant
    <div
      ref={element}
      id={id}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- an option of the column's listbox above; <option> only lives in <select>
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      aria-disabled={isFolder ? undefined : true}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      className={cn(
        ROW_CLASS,
        "transition-[background-color] duration-100 ease-out",
        isFolder ? "cursor-default hover:not-aria-selected:bg-hover" : "text-muted-foreground/50",
        selected && (lit ? "bg-primary text-primary-foreground" : "bg-selected text-foreground"),
      )}
    >
      <Icon
        size={sizeMap.compact.icon}
        strokeWidth={1.5}
        className={cn("shrink-0", !selected && isFolder && "text-muted-foreground")}
      />
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      {isFolder ? (
        <CHEVRON_ICON
          size={12}
          strokeWidth={1.5}
          className={cn("shrink-0", selected && lit ? "opacity-80" : "opacity-40")}
        />
      ) : null}
    </div>
  );
}

function ColumnBody(props: { readonly state: ColumnState }): ReactElement {
  const { state } = props;

  return Match.value(state).pipe(
    Match.when({ kind: "loading" }, () => (
      <div className="flex flex-1 items-center justify-center">
        <Spinner className="text-muted-foreground" />
      </div>
    )),
    Match.when({ kind: "loaded" }, () => <ColumnNotice>Empty folder</ColumnNotice>),
    Match.when({ kind: "failed" }, (failed) => (
      <Empty className="flex-1 border-0 p-4">
        <EmptyHeader>
          <EmptyTitle className="text-[12px]">{failed.summary}</EmptyTitle>
          {failed.reason === undefined ? null : (
            <EmptyDescription className="text-[12px]">{failed.reason}</EmptyDescription>
          )}
        </EmptyHeader>
      </Empty>
    )),
    Match.exhaustive,
  );
}

function ColumnNotice(props: { readonly children: string }): ReactElement {
  return (
    <p className="text-muted-foreground/70 px-3 py-2 text-center text-[12px]">{props.children}</p>
  );
}
