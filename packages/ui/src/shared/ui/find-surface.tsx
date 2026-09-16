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

export interface FindRow extends CommandMenuItemData {
  readonly status?: string;
}

export interface FindSurfaceProps {
  readonly label: string;
  readonly placeholder: string;
  readonly rank: (query: string) => readonly FindRow[];
  readonly onPick: (value: string) => void;
  readonly onCancel: () => void;
  readonly emptyText: string;
}

const ACCEPT_EVERY_ROW = (): boolean => true;

export function FindSurface(props: FindSurfaceProps): ReactElement {
  const { label, placeholder, rank, onPick, onCancel, emptyText } = props;

  const [query, setQuery] = useState("");
  const rows = useMemo(() => rank(query), [rank, query]);

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
        <CommandMenuInput placeholder={placeholder} aria-label={label} data-autofocus="" />
        <CommandMenuList renderItem={renderRow}>
          <CommandMenuEmpty>{emptyText}</CommandMenuEmpty>
        </CommandMenuList>
        <CommandMenuFooter />
      </CommandMenu>
    </CommandMenuShell>
  );
}
