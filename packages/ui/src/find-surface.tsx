import {
  Badge,
  CommandMenu,
  CommandMenuEmpty,
  CommandMenuFooter,
  CommandMenuInput,
  CommandMenuItem,
  CommandMenuList,
  CommandMenuShell,
  type CommandMenuItemData,
} from "@janela/design";
import type { ReactElement } from "react";
import { useCallback, useMemo, useState } from "react";

/**
 * A type-to-find list: one field, one listbox, Enter picks.
 *
 * Both of the app's find surfaces are this — the command palette and the session
 * jump list — because they are the same interaction with a different haystack.
 * The interaction itself is the registry's `CommandMenu`; what lives here is the
 * three decisions this application makes about it.
 *
 * ## What this adds to the menu
 *
 * - **The ranking is ours, and the menu does not re-filter it.** `rank` is a
 *   fuzzy subsequence match with per-surface tie-breaks (recency in the jump
 *   list, table order in the palette); the menu's own filter is a word-substring
 *   test that would drop `jan pt` → `fix/pty` on the way to the list. So the
 *   query is controlled here, the rows are re-ranked on every keystroke, and the
 *   menu's filter accepts everything it is handed.
 * - **A session row carries its state.** `status` becomes a badge at the row's
 *   trailing edge, where a command's keycaps go — it is the one thing a row
 *   shows that the menu has no slot for, and "running" next to a session name is
 *   why the palette can replace looking at the sidebar.
 * - **Escape closes the sheet, Enter names what it will do.** Both come from
 *   `CommandMenuShell`: the menu asks its shell to close, and the shell is the
 *   dialog `SheetHost` already had.
 */

/** A row, plus the one field the menu's own data has no place for. */
export interface FindRow extends CommandMenuItemData {
  /** A state word — "running", "needs attention" — drawn as a badge. */
  readonly status?: string;
}

/**
 * The menu filters nothing: `rank` already decided what matches, in what order.
 * Hoisted so the identity holds still — it feeds the root's memo.
 */
const ACCEPT_EVERY_ROW = (): boolean => true;

export interface FindSurfaceProps {
  /** Accessible name of the field, e.g. "Commands". */
  readonly label: string;
  readonly placeholder: string;
  /** The matches for a query, best first. Memoise it: it feeds a dependency list. */
  readonly rank: (query: string) => readonly FindRow[];
  readonly onPick: (value: string) => void;
  readonly onCancel: () => void;
  readonly emptyText: string;
}

export function FindSurface(props: FindSurfaceProps): ReactElement {
  const { label, placeholder, rank, onPick, onCancel, emptyText } = props;

  const [query, setQuery] = useState("");
  const rows = useMemo(() => rank(query), [rank, query]);

  // The statuses, by row, rather than read off the item the menu hands back:
  // `renderItem` is typed in the menu's own row data, and a cast would be this
  // file promising the compiler something it cannot see.
  const statuses = useMemo(() => {
    const table = new Map<string, string>();
    for (const row of rows) if (row.status !== undefined) table.set(row.value, row.status);
    return table;
  }, [rows]);

  const select = useCallback(
    (item: CommandMenuItemData) => {
      onPick(item.value);
    },
    [onPick],
  );

  const renderRow = useCallback(
    (item: CommandMenuItemData) => {
      const status = statuses.get(item.value);
      if (status === undefined) return <CommandMenuItem value={item.value} />;
      return (
        <CommandMenuItem value={item.value}>
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="truncate">{item.label}</span>
            <span className="text-muted-foreground/60 min-w-0 truncate">{item.description}</span>
          </span>
          <Badge variant="secondary" className="ml-auto shrink-0">
            {status}
          </Badge>
        </CommandMenuItem>
      );
    },
    [statuses],
  );

  return (
    <CommandMenuShell close={onCancel}>
      <CommandMenu
        items={rows}
        filter={ACCEPT_EVERY_ROW}
        query={query}
        onQueryChange={setQuery}
        onSelect={select}
      >
        {/* The sheet exists to be typed into; anything else is a click the user
            should not have had to make. `data-autofocus` is read by `SheetHost`. */}
        <CommandMenuInput placeholder={placeholder} aria-label={label} data-autofocus="" />
        <CommandMenuList renderItem={renderRow}>
          <CommandMenuEmpty>{emptyText}</CommandMenuEmpty>
        </CommandMenuList>
        <CommandMenuFooter />
      </CommandMenu>
    </CommandMenuShell>
  );
}
