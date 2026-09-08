import type { ChangeEvent, KeyboardEvent, ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import * as style from "./styles.ts";

/**
 * A type-to-find list: one input, one listbox, Enter picks.
 *
 * Both of the app's find surfaces are this — the session jump list and the command
 * palette — because they are the same interaction with a different haystack, and
 * two hand-written versions would drift on the details that matter here: where the
 * arrow keys wrap, which modifiers are ignored, whether the highlighted row is
 * scrolled into view.
 *
 * The ranking is the caller's: this component knows how to be a list, not what is
 * in it.
 */

export interface QuickListItem {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  /** Right-aligned, dimmed: a chord, a status, a count. */
  readonly trailing?: string;
}

/**
 * Where the arrow keys go, wrapping at both ends.
 *
 * Wrapping because this is a menu, and a menu where Down stops dead at the bottom
 * makes the user aim. Generalised from the launch-profile picker's `movedSelection`
 * so the two lists cannot disagree about the edges.
 */
export function movedIndex(count: number, current: number, delta: -1 | 1): number {
  if (count === 0) return 0;
  return (current + delta + count) % count;
}

export interface QuickListProps<Item extends QuickListItem> {
  /** Accessible name of the list, e.g. "Sessions". */
  readonly label: string;
  readonly placeholder: string;
  /** The matches for a query, best first. Memoise it: it feeds a dependency list. */
  readonly rank: (query: string) => readonly Item[];
  readonly onPick: (id: string) => void;
  readonly onCancel: () => void;
  readonly emptyText: string;
}

export function QuickList<Item extends QuickListItem>(props: QuickListProps<Item>): ReactElement {
  const { label, placeholder, rank, onPick, onCancel, emptyText } = props;

  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const items = useMemo(() => rank(query), [rank, query]);

  // Clamped rather than corrected by an effect: the list shrinks as the user
  // types, and a highlight past its end would be a frame of nothing selected.
  const index = items.length === 0 ? 0 : Math.min(highlighted, items.length - 1);
  const current = items[index];

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // The sheet exists to be typed into; anything else is a click the user should
    // not have had to make.
    inputRef.current?.focus();
  }, []);

  const highlightedID = current?.id;
  useEffect(() => {
    if (highlightedID === undefined) return;
    listRef.current?.querySelector(`[id="${CSS.escape(highlightedID)}"]`)?.scrollIntoView({
      block: "nearest",
    });
  }, [highlightedID]);

  const handleQuery = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setQuery(event.target.value);
    setHighlighted(0);
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      // Only the four keys a list owes its user. Nothing with `Ctrl`: this sheet
      // sits over a terminal, and `Ctrl-n` belongs to whatever is running in it.
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlighted(movedIndex(items.length, index, 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlighted(movedIndex(items.length, index, -1));
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (current !== undefined) onPick(current.id);
      } else if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    },
    [current, index, items.length, onCancel, onPick],
  );

  const listID = `${label.replace(/\s+/g, "-").toLowerCase()}-list`;

  return (
    <div style={style.PICKER}>
      <input
        onKeyDown={handleKeyDown}
        ref={inputRef}
        type="text"
        style={style.INPUT}
        value={query}
        onChange={handleQuery}
        placeholder={placeholder}
        aria-label={label}
        aria-controls={listID}
        aria-activedescendant={current?.id}
        autoComplete="off"
        spellCheck={false}
      />
      {items.length === 0 ? (
        <p style={style.HINT}>{emptyText}</p>
      ) : (
        // The ARIA listbox pattern rather than a `<select>`: rows carry a subtitle
        // and a chord, which a native select cannot render, and the input above
        // keeps the keyboard focus so typing never leaves the field.
        <div
          ref={listRef}
          id={listID}
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- see the comment above
          role="listbox"
          aria-label={label}
          style={style.LIST}
        >
          {items.map((item) => (
            <Row
              key={item.id}
              item={item}
              isHighlighted={item.id === current?.id}
              onPick={onPick}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Row(props: {
  readonly item: QuickListItem;
  readonly isHighlighted: boolean;
  readonly onPick: (id: string) => void;
}): ReactElement {
  const { item, isHighlighted, onPick } = props;
  const pick = useCallback(() => {
    onPick(item.id);
  }, [onPick, item.id]);

  return (
    <button
      type="button"
      id={item.id}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a row of the listbox above
      role="option"
      aria-selected={isHighlighted}
      onClick={pick}
      style={isHighlighted ? style.LIST_ROW_SELECTED : style.LIST_ROW}
    >
      <span>{item.title}</span>
      {item.subtitle === undefined ? null : <span style={style.HINT}>{item.subtitle}</span>}
      {item.trailing === undefined ? null : (
        <span style={style.TRAILING_HINT}>{item.trailing}</span>
      )}
    </button>
  );
}
