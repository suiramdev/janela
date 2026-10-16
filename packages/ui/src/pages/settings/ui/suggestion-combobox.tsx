import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  type ComboboxItemData,
} from "@janela/design";
import type { ReactElement } from "react";
import { useCallback, useMemo } from "react";

import type { SuggestionItem } from "../model/session-naming.ts";
import { CONTROL_WIDTH } from "./pane.tsx";

export interface SuggestionComboboxProps {
  readonly id: string;
  readonly value: string;
  readonly items: readonly SuggestionItem[];
  readonly placeholder: string;
  readonly empty: string;
  readonly isDisabled?: boolean | undefined;
  readonly onCommit: (value: string) => void;
}

const customLabel = (query: string): string => `Use “${query}”`;

function matches(item: SuggestionItem, query: string): boolean {
  const needle = query.toLocaleLowerCase();

  return (
    item.label.toLocaleLowerCase().includes(needle) ||
    item.value.toLocaleLowerCase().includes(needle)
  );
}

export function SuggestionCombobox(props: SuggestionComboboxProps): ReactElement {
  const { value, onCommit } = props;

  const items = useMemo<readonly SuggestionItem[]>(
    () =>
      value === "" || props.items.some((item) => item.value === value)
        ? props.items
        : [{ value, label: value }, ...props.items],
    [props.items, value],
  );

  const byItem = useMemo(
    () => new Map<ComboboxItemData, SuggestionItem>(items.map((item) => [item, item])),
    [items],
  );

  const create = useCallback(
    (query: string): SuggestionItem => ({ value: query, label: query }),
    [],
  );

  const change = useCallback(
    (next: string) => {
      if (next !== value) onCommit(next);
    },
    [onCommit, value],
  );

  const renderItem = useCallback(
    (item: ComboboxItemData) => {
      const suggestion = byItem.get(item);

      if (suggestion === undefined) return null;

      return (
        <ComboboxItem value={suggestion.value}>
          {suggestion.label}
          {suggestion.detail === undefined ? undefined : (
            <span className="text-muted-foreground ml-2 font-mono text-[0.6875rem]">
              {suggestion.detail}
            </span>
          )}
        </ComboboxItem>
      );
    },
    [byItem],
  );

  return (
    <Combobox<SuggestionItem>
      items={items}
      value={value}
      onValueChange={change}
      filter={matches}
      onCreate={create}
      createLabel={customLabel}
      disabled={props.isDisabled ?? false}
      size="compact"
    >
      <ComboboxInput
        id={props.id}
        placeholder={props.placeholder}
        clearable
        className={CONTROL_WIDTH}
        autoComplete="off"
        spellCheck={false}
      />
      <ComboboxContent>
        <ComboboxEmpty>{props.empty}</ComboboxEmpty>
        <ComboboxList>{renderItem}</ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
