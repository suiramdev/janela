import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Badge,
  cn,
  Empty,
  EmptyDescription,
  EmptyHeader,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
  Kbd,
  ScrollArea,
} from "@janela/design";
import type { ChangeEvent, KeyboardEvent, ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
 *
 * ## Why not the registry's `Command`
 *
 * It is built on `cmdk`, which brings a second primitive library and its own
 * ranking, and whose list answers `Ctrl-n`/`Ctrl-p`. This one composes the same
 * registry pieces a `Command` is drawn with — `InputGroup`, `Item`, `Kbd` — around
 * the keyboard handling below, which refuses every `Ctrl` chord on purpose.
 */

export interface QuickListItem {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  /** Right-aligned: the key chord that runs this row, drawn as keycaps. */
  readonly chord?: string;
  /** Right-aligned: a state word — "running", "needs attention" — drawn as a badge. */
  readonly status?: string;
}

/**
 * Where the arrow keys go, wrapping at both ends.
 *
 * Wrapping because this is a menu, and a menu where Down stops dead at the bottom
 * makes the user aim. Generalised from the former launch-profile picker's `movedSelection`,
 * so every list here wraps the same way.
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

  const listRef = useRef<HTMLDivElement | null>(null);

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
    <div className="flex flex-col gap-2">
      <InputGroup>
        <InputGroupAddon>
          <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
        </InputGroupAddon>
        <InputGroupInput
          onKeyDown={handleKeyDown}
          type="text"
          value={query}
          onChange={handleQuery}
          placeholder={placeholder}
          aria-label={label}
          aria-controls={listID}
          aria-activedescendant={current?.id}
          autoComplete="off"
          spellCheck={false}
          // The sheet exists to be typed into; anything else is a click the user
          // should not have had to make. Read by `SheetHost`.
          data-autofocus=""
        />
      </InputGroup>
      {items.length === 0 ? (
        <Empty className="p-4">
          <EmptyHeader>
            <EmptyDescription>{emptyText}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        // The ARIA listbox pattern rather than a `<select>`: rows carry a subtitle
        // and a chord, which a native select cannot render, and the input above
        // keeps the keyboard focus so typing never leaves the field.
        <ScrollArea className="max-h-[50vh] overflow-hidden">
          <div
            ref={listRef}
            id={listID}
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- see the comment above
            role="listbox"
            aria-label={label}
            className="flex flex-col"
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
        </ScrollArea>
      )}
    </div>
  );
}

/** Hoisted: Base UI clones the element it is handed, so one is enough for every row. */
// oxlint-disable-next-line jsx-a11y/control-has-associated-label -- named by `aria-labelledby` where it is rendered
const ROW_BUTTON = <button type="button" />;

function Row(props: {
  readonly item: QuickListItem;
  readonly isHighlighted: boolean;
  readonly onPick: (id: string) => void;
}): ReactElement {
  const { item, isHighlighted, onPick } = props;
  const pick = useCallback(() => {
    onPick(item.id);
  }, [onPick, item.id]);

  const titleID = `${item.id}-title`;
  return (
    <Item
      render={ROW_BUTTON}
      id={item.id}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a row of the listbox above
      role="option"
      aria-selected={isHighlighted}
      aria-labelledby={titleID}
      onClick={pick}
      size="xs"
      // Highlight follows the keyboard, not the pointer: a hover state on a list
      // the arrow keys drive is two highlights, and the wrong one is the visible one.
      className={cn("text-left", isHighlighted && "bg-accent text-accent-foreground")}
    >
      <ItemContent>
        <ItemTitle id={titleID}>{item.title}</ItemTitle>
        {item.subtitle === undefined ? null : <ItemDescription>{item.subtitle}</ItemDescription>}
      </ItemContent>
      {item.status === undefined ? null : <Badge variant="secondary">{item.status}</Badge>}
      {item.chord === undefined ? null : <Kbd>{item.chord}</Kbd>}
    </Item>
  );
}
