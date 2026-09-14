import type { ReactElement } from "react";
import { useCallback } from "react";

import { acceleratorSymbols, COMMANDS, isCommandID, type CommandID } from "./commands.ts";
import { rankBy } from "./fuzzy.ts";
import { QuickList, type QuickListItem } from "./quick-list.tsx";

/**
 * ⌘⇧P: everything the menu bar can do, by name.
 *
 * It reads `COMMANDS` — the same table the native menu is built from — so a row
 * added there appears here, in the menu bar, and nowhere else that has to be kept
 * in step.
 */

/** The commands that match, best first. An empty query keeps the table's order. */
export function rankedCommands(query: string): readonly QuickListItem[] {
  const ranked =
    query.length === 0
      ? COMMANDS
      : rankBy(
          query,
          COMMANDS,
          (command) => command.title,
          () => 0,
        );

  return ranked.map((command) => ({
    id: command.id,
    title: command.title,
    ...(command.accelerator === undefined
      ? {}
      : { chord: acceleratorSymbols(command.accelerator) }),
  }));
}

export interface CommandPaletteProps {
  readonly onPick: (id: CommandID) => void;
  readonly onCancel: () => void;
}

export function CommandPalette(props: CommandPaletteProps): ReactElement {
  const { onPick, onCancel } = props;

  const pick = useCallback(
    (id: string) => {
      // The rows come from the table, so this cannot fail — and narrowing here
      // rather than asserting is what keeps `CommandID` meaning something.
      if (isCommandID(id)) onPick(id);
    },
    [onPick],
  );

  return (
    <QuickList
      label="Commands"
      placeholder="Run a command…"
      rank={rankedCommands}
      onPick={pick}
      onCancel={onCancel}
      emptyText="No command matches."
    />
  );
}
