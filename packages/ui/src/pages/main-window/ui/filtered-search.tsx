import {
  Cancel01Icon,
  FilterHorizontalIcon,
  Search01Icon,
  TextIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn, DitherAvatar, Elevated } from "@janela/design";
import type {
  ChangeEvent,
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
  ReactNode,
} from "react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  cancelPendingFilter,
  chooseSearchSuggestion,
  editSearchToken,
  EMPTY_SEARCH,
  eraseSearchBackward,
  removeSearchToken,
  SEARCH_OPERATOR_SYMBOL,
  SEARCH_OPERATOR_TITLE,
  searchFieldTitle,
  searchSuggestions,
  searchValueTitle,
  toggleSearchOperator,
  togglePendingOperator,
  typeSearchDraft,
  type SearchField,
  type SearchFilterToken,
  type SearchState,
  type SearchSuggestion,
  type SearchToken,
} from "../model/filtered-search.ts";

const POPUP_WIDTH = 288;

const POPUP_INSET = 8;

const SEGMENT_CLASS = "flex items-center bg-active px-1.5 text-foreground";

const SEGMENT_BUTTON_CLASS = cn(
  SEGMENT_CLASS,
  "outline-none transition-[background-color] duration-100 ease-out hover:bg-selected focus-visible:bg-selected",
);

const keepFocus = (event: ReactMouseEvent): void => {
  event.preventDefault();
};

export function FilteredSearch(props: {
  readonly state: SearchState;
  readonly fields: readonly SearchField[];
  readonly label: string;
  readonly placeholder: string;
  readonly onChange: (state: SearchState) => void;
}): ReactElement {
  const { state, fields, onChange } = props;
  const listID = useId();
  const anchor = useRef<HTMLDivElement | null>(null);
  const track = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const popup = useRef<HTMLDivElement | null>(null);
  const [isOpen, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  const suggestions = useMemo(() => searchSuggestions(state, fields), [state, fields]);
  const isShowing = isOpen && suggestions.length > 0;
  const active = Math.min(highlight, suggestions.length - 1);
  const contentSignature = `${state.tokens.length}\n${state.pending?.replacing ?? ""}\n${state.draft}`;

  useLayoutEffect(() => {
    const row = track.current;

    if (row === null || contentSignature === "") return;

    const editing = row.querySelector<HTMLElement>("[data-editing]");

    if (editing === null) {
      row.scrollLeft = row.scrollWidth;
    } else {
      editing.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }
  }, [contentSignature]);

  useEffect(() => {
    const row = track.current;

    if (row === null) return;

    const scrollSideways = (event: WheelEvent): void => {
      if (row.scrollWidth <= row.clientWidth || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) {
        return;
      }

      event.preventDefault();
      row.scrollLeft += event.deltaY;
    };

    row.addEventListener("wheel", scrollSideways, { passive: false });

    return () => {
      row.removeEventListener("wheel", scrollSideways);
    };
  }, []);

  useLayoutEffect(() => {
    const container = anchor.current;
    const list = popup.current;
    const target = track.current?.querySelector<HTMLElement>("[data-editing]") ?? input.current;

    if (container === null || list === null || target === null) return;

    const room = Math.max(container.clientWidth - POPUP_WIDTH, 0);
    const left =
      target.getBoundingClientRect().left - container.getBoundingClientRect().left - POPUP_INSET;

    list.style.left = `${Math.min(Math.max(left, 0), room)}px`;
  });

  const update = useCallback(
    (next: SearchState) => {
      setHighlight(0);
      onChange(next);
    },
    [onChange],
  );

  const focusInput = useCallback(() => {
    input.current?.focus();
    setOpen(true);
  }, []);

  const choose = useCallback(
    (suggestion: SearchSuggestion) => {
      update(chooseSearchSuggestion(state, fields, suggestion));
      setOpen(true);
    },
    [update, state, fields],
  );

  const type = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      update(typeSearchDraft(state, fields, event.target.value));
      setOpen(true);
    },
    [update, state, fields],
  );

  const open = useCallback(() => {
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    setOpen(false);

    if (state.pending !== undefined) update(cancelPendingFilter(state));
  }, [update, state]);

  const step = useCallback(
    (by: number) => {
      if (!isOpen) {
        setOpen(true);

        return;
      }

      const count = suggestions.length;

      if (count > 0) setHighlight((active + by + count) % count);
    },
    [isOpen, suggestions.length, active],
  );

  const press = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      const field = event.currentTarget;

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        step(event.key === "ArrowDown" ? 1 : -1);

        return;
      }

      if (event.key === "Enter") {
        const chosen = isShowing ? suggestions[active] : undefined;

        if (chosen === undefined) return;

        event.preventDefault();
        choose(chosen);

        return;
      }

      if (event.key === "Escape") {
        if (state.pending !== undefined) {
          event.preventDefault();
          update(cancelPendingFilter(state));
        } else if (isShowing) {
          event.preventDefault();
          setOpen(false);
        }

        return;
      }

      if (
        event.key === "Backspace" &&
        field.selectionStart === 0 &&
        field.selectionEnd === 0 &&
        (state.pending !== undefined || state.tokens.length > 0)
      ) {
        event.preventDefault();
        update(eraseSearchBackward(state));
      }
    },
    [step, isShowing, suggestions, active, choose, state, update],
  );

  const remove = useCallback(
    (index: number) => {
      update(removeSearchToken(state, index));
      focusInput();
    },
    [update, state, focusInput],
  );

  const edit = useCallback(
    (index: number) => {
      update(editSearchToken(state, index));
      focusInput();
    },
    [update, state, focusInput],
  );

  const toggle = useCallback(
    (index: number) => {
      update(toggleSearchOperator(state, fields, index));
    },
    [update, state, fields],
  );

  const togglePending = useCallback(() => {
    update(togglePendingOperator(state));
    input.current?.focus();
  }, [update, state]);

  const clear = useCallback(() => {
    update(EMPTY_SEARCH);
    focusInput();
  }, [update, focusInput]);

  const { pending } = state;
  const hasContent = state.tokens.length > 0 || state.draft !== "" || pending !== undefined;
  const isEmpty = state.tokens.length === 0 && pending === undefined;

  return (
    <div ref={anchor} className="relative min-w-0 flex-1">
      <div
        data-slot="filtered-search"
        className={cn(
          "flex h-9 w-full min-w-0 items-center gap-1 rounded-md border border-input bg-input/20 pr-1 pl-2.5 transition-colors",
          "focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30",
        )}
      >
        <HugeiconsIcon
          icon={Search01Icon}
          strokeWidth={2}
          className="text-muted-foreground mr-1 size-3.5 shrink-0"
        />
        <div
          ref={track}
          className="flex h-full min-w-0 flex-1 [scrollbar-width:none] flex-nowrap items-center gap-1 overflow-x-auto overflow-y-hidden px-0.5 [&::-webkit-scrollbar]:hidden"
        >
          {state.tokens.map((token, index) => (
            <TokenChip
              key={
                token.kind === "text"
                  ? `text:${index}:${token.text}`
                  : `filter:${token.field}:${token.operator}:${token.value}`
              }
              token={token}
              index={index}
              fields={fields}
              isEditing={pending?.replacing === index}
              onEdit={edit}
              onRemove={remove}
              onToggle={toggle}
            />
          ))}
          {pending === undefined || pending.replacing !== undefined ? undefined : (
            <span className="inline-flex h-6 shrink-0 items-stretch gap-px overflow-hidden rounded-md text-xs">
              <span className={SEGMENT_CLASS}>{searchFieldTitle(fields, pending.field)}</span>
              <button
                type="button"
                className={SEGMENT_BUTTON_CLASS}
                title={`Change to “${SEARCH_OPERATOR_TITLE[pending.operator === "is" ? "isNot" : "is"]}”`}
                onMouseDown={keepFocus}
                onClick={togglePending}
              >
                {SEARCH_OPERATOR_SYMBOL[pending.operator]}
              </button>
            </span>
          )}
          <input
            ref={input}
            role="combobox"
            aria-label={props.label}
            aria-expanded={isShowing}
            aria-controls={listID}
            aria-autocomplete="list"
            aria-activedescendant={isShowing ? `${listID}-${active}` : undefined}
            enterKeyHint="search"
            autoComplete="off"
            spellCheck={false}
            value={state.draft}
            placeholder={isEmpty ? props.placeholder : undefined}
            onChange={type}
            onFocus={open}
            onClick={open}
            onBlur={close}
            onKeyDown={press}
            className="placeholder:text-muted-foreground h-7 min-w-32 flex-1 shrink-0 bg-transparent px-1 text-sm outline-none"
          />
        </div>
        {hasContent ? (
          <button
            type="button"
            aria-label="Clear search and filters"
            title="Clear search and filters"
            className="text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:ring-ring/30 flex size-7 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2"
            onMouseDown={keepFocus}
            onClick={clear}
          >
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-3.5" />
          </button>
        ) : undefined}
      </div>
      {isShowing ? (
        <Elevated
          ref={popup}
          offset={2}
          shadowLevel={3}
          className="absolute top-full z-50 mt-1 w-72 rounded-lg p-1"
        >
          <div
            id={listID}
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- suggestions of the search field above, which keeps focus and points here through aria-activedescendant; <select> cannot hold a field's matches
            role="listbox"
            aria-label={
              pending === undefined ? "Suggestions" : searchFieldTitle(fields, pending.field)
            }
            className="flex max-h-72 flex-col overflow-y-auto"
          >
            {suggestions.map((suggestion, index) => (
              <SuggestionRow
                key={suggestionKey(suggestion)}
                id={`${listID}-${index}`}
                index={index}
                suggestion={suggestion}
                isActive={index === active}
                showsField={pending === undefined}
                onHighlight={setHighlight}
                onChoose={choose}
              />
            ))}
          </div>
        </Elevated>
      ) : undefined}
    </div>
  );
}

function TokenChip(props: {
  readonly token: SearchToken;
  readonly index: number;
  readonly fields: readonly SearchField[];
  readonly isEditing: boolean;
  readonly onEdit: (index: number) => void;
  readonly onRemove: (index: number) => void;
  readonly onToggle: (index: number) => void;
}): ReactElement {
  const { token, index, fields, onEdit, onRemove, onToggle } = props;

  const edit = useCallback(() => {
    onEdit(index);
  }, [onEdit, index]);

  const remove = useCallback(() => {
    onRemove(index);
  }, [onRemove, index]);

  const toggle = useCallback(() => {
    onToggle(index);
  }, [onToggle, index]);

  return (
    <span
      data-editing={props.isEditing ? "" : undefined}
      className={cn(
        "inline-flex h-6 shrink-0 items-stretch gap-px overflow-hidden rounded-md text-xs",
        props.isEditing && "ring-2 ring-ring/40",
      )}
    >
      {token.kind === "text" ? (
        <ChipButton title="Edit this text" onClick={edit}>
          <span className="max-w-60 truncate">{token.text}</span>
        </ChipButton>
      ) : (
        <FilterSegments token={token} fields={fields} onEdit={edit} onToggle={toggle} />
      )}
      <button
        type="button"
        aria-label={`Remove ${chipLabel(token, fields)}`}
        title="Remove"
        className={cn(SEGMENT_BUTTON_CLASS, "text-muted-foreground hover:text-foreground px-1")}
        onMouseDown={keepFocus}
        onClick={remove}
      >
        <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-3" />
      </button>
    </span>
  );
}

function FilterSegments(props: {
  readonly token: SearchFilterToken;
  readonly fields: readonly SearchField[];
  readonly onEdit: () => void;
  readonly onToggle: () => void;
}): ReactElement {
  const { token, fields } = props;
  const title = searchValueTitle(fields, token);
  const isPerson = fields.find((field) => field.key === token.field)?.isPerson ?? false;
  const opposite = token.operator === "is" ? "isNot" : "is";

  return (
    <>
      <span className={cn(SEGMENT_CLASS, "text-muted-foreground")}>
        {searchFieldTitle(fields, token.field)}
      </span>
      <button
        type="button"
        className={SEGMENT_BUTTON_CLASS}
        aria-label={`${SEARCH_OPERATOR_TITLE[token.operator]}, change to ${SEARCH_OPERATOR_TITLE[opposite]}`}
        title={`Change to “${SEARCH_OPERATOR_TITLE[opposite]}”`}
        onMouseDown={keepFocus}
        onClick={props.onToggle}
      >
        {SEARCH_OPERATOR_SYMBOL[token.operator]}
      </button>
      <ChipButton title={`Change ${searchFieldTitle(fields, token.field)}`} onClick={props.onEdit}>
        {isPerson ? <PersonMark name={token.value} /> : undefined}
        <span className="max-w-60 truncate">{title}</span>
      </ChipButton>
    </>
  );
}

function ChipButton(props: {
  readonly title: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      title={props.title}
      className={cn(SEGMENT_BUTTON_CLASS, "min-w-0 gap-1.5")}
      onMouseDown={keepFocus}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function SuggestionRow(props: {
  readonly id: string;
  readonly index: number;
  readonly suggestion: SearchSuggestion;
  readonly isActive: boolean;
  readonly showsField: boolean;
  readonly onHighlight: (index: number) => void;
  readonly onChoose: (suggestion: SearchSuggestion) => void;
}): ReactElement {
  const { id, index, suggestion, isActive, onHighlight, onChoose } = props;
  const row = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (isActive) row.current?.scrollIntoView?.({ block: "nearest" });
  }, [isActive]);

  const highlight = useCallback(() => {
    onHighlight(index);
  }, [onHighlight, index]);

  const choose = useCallback(() => {
    onChoose(suggestion);
  }, [onChoose, suggestion]);

  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- the keyboard is handled by the search field, through aria-activedescendant
    <div
      ref={row}
      id={id}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- an option of the suggestions listbox above; <option> only lives in <select>
      role="option"
      tabIndex={-1}
      aria-selected={isActive}
      onMouseDown={keepFocus}
      onMouseMove={highlight}
      onClick={choose}
      className={cn(
        "flex h-8 shrink-0 cursor-default items-center gap-2 rounded-md px-2 text-sm",
        isActive && "bg-hover",
      )}
    >
      <SuggestionContent suggestion={suggestion} showsField={props.showsField} />
    </div>
  );
}

function SuggestionContent(props: {
  readonly suggestion: SearchSuggestion;
  readonly showsField: boolean;
}): ReactElement {
  const { suggestion } = props;

  if (suggestion.kind === "field") {
    return (
      <>
        <HugeiconsIcon
          icon={FilterHorizontalIcon}
          strokeWidth={2}
          className="text-muted-foreground size-3.5 shrink-0"
        />
        <span className="truncate">{suggestion.field.title}</span>
      </>
    );
  }

  if (suggestion.kind === "text") {
    return (
      <>
        <HugeiconsIcon
          icon={TextIcon}
          strokeWidth={2}
          className="text-muted-foreground size-3.5 shrink-0"
        />
        <span className="truncate">Search for this text</span>
      </>
    );
  }

  return (
    <>
      {suggestion.field.isPerson ? <PersonMark name={suggestion.value.value} /> : undefined}
      {props.showsField ? (
        <span className="text-muted-foreground shrink-0">{suggestion.field.title} =</span>
      ) : undefined}
      <span className="truncate">{suggestion.value.title}</span>
    </>
  );
}

function PersonMark(props: { readonly name: string }): ReactElement {
  return (
    <DitherAvatar
      name={props.name}
      animate={false}
      className="size-4 shrink-0 overflow-hidden rounded-full"
    />
  );
}

function chipLabel(token: SearchToken, fields: readonly SearchField[]): string {
  if (token.kind === "text") return `search for “${token.text}”`;

  return `${searchFieldTitle(fields, token.field)} ${SEARCH_OPERATOR_TITLE[token.operator]} ${searchValueTitle(fields, token)}`;
}

function suggestionKey(suggestion: SearchSuggestion): string {
  if (suggestion.kind === "field") return `field:${suggestion.field.key}`;

  if (suggestion.kind === "text") return "text";

  return `value:${suggestion.field.key}:${suggestion.value.value}`;
}
