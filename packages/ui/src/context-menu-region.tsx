import {
  ContextMenu,
  ContextMenuTrigger,
  DropdownContent,
  DropdownLabel,
  DropdownSeparator,
  MenuItem,
  type IconComponent,
} from "@janela/design";
import type { HTMLAttributes, ReactElement, ReactNode } from "react";
import { useCallback, useMemo } from "react";

/**
 * Right-click anywhere, get the actions for what is under the pointer.
 *
 * ## Why the rows are data
 *
 * Every menu in this window is a `MenuRow[]` built by a pure function, for the
 * same reason `sidebar-actions.ts` exists: the interesting part is *which rows a
 * context offers and which of them are available*, and a decision buried in
 * JSX can only be tested by rendering a menu and reading the DOM. The builders
 * live beside the surface they belong to and are tested as data.
 *
 * It also removes the one bookkeeping error this menu invites. The registry's
 * `MenuItem` is numbered by its caller — the number is how the fluid-hover
 * highlight finds the row's box — and those numbers count *items*, not
 * children, so a separator or a label between them does not take one. Written
 * by hand, that is a silent off-by-one whenever a row is inserted. Here it is
 * one counter in one place.
 */

export type MenuRow =
  | {
      readonly kind: "item";
      readonly label: string;
      readonly icon?: IconComponent;
      readonly onSelect: () => void;
      /** Offered but not available now — shown, dimmed, and unselectable. */
      readonly disabled?: boolean;
      /** Destroys something: removing a project, closing a terminal. */
      readonly destructive?: boolean;
    }
  | { readonly kind: "label"; readonly label: string }
  | { readonly kind: "separator" };

/** A row that can be picked. Exported for the builders' tests. */
export type MenuActionRow = Extract<MenuRow, { kind: "item" }>;

export interface ContextMenuRegionProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** What the menu is about, e.g. `Session: fix/pty`. Announced on the popup. */
  readonly label: string;
  readonly rows: readonly MenuRow[];
  /** Classes for the trigger wrapper, not the popup. */
  readonly className?: string;
  /**
   * Called as the menu opens, before the rows are drawn.
   *
   * For the one fact a row's availability depends on that React does not hold:
   * whether a terminal has a selection. A state update here lands in the same
   * event, so the rows paint with the answer rather than one frame behind it.
   */
  readonly onOpen?: () => void;
  readonly children: ReactNode;
}

/** A row, with the number the highlight finds it by and a key React can trust. */
interface PlacedRow {
  readonly row: MenuRow;
  readonly key: string;
  /** Its place among the selectable rows; `-1` for a label or a separator. */
  readonly index: number;
}

/**
 * Numbers the selectable rows and keys every row.
 *
 * The numbers count items only — a label or a separator between two items does
 * not take one, because the number is the index the fluid-hover highlight
 * measures a box by. The keys are derived from the labels rather than from the
 * array position: a menu whose rows change with the context (a terminal's Copy
 * appearing, a project's Remove) would otherwise re-key every row below the one
 * that changed.
 */
export function placeRows(rows: readonly MenuRow[]): readonly PlacedRow[] {
  const placed: PlacedRow[] = [];
  let index = -1;
  for (const row of rows) {
    if (row.kind === "item") {
      index += 1;
      placed.push({ row, key: `item:${row.label}`, index });
      continue;
    }
    if (row.kind === "label") {
      placed.push({ row, key: `label:${row.label}`, index: -1 });
      continue;
    }
    placed.push({ row, key: `separator:${placed[placed.length - 1]?.key ?? "top"}`, index: -1 });
  }
  return placed;
}

export function ContextMenuRegion(props: ContextMenuRegionProps): ReactElement {
  // Everything else belongs to the wrapper the trigger renders: a tab is also a
  // drop target, and the region is the element its drag handlers sit on.
  const { label, rows, className, onOpen, children, ...rest } = props;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) onOpen?.();
    },
    [onOpen],
  );

  const placed = useMemo(() => placeRows(rows), [rows]);

  return (
    <ContextMenu onOpenChange={handleOpenChange}>
      <ContextMenuTrigger className={className} {...rest}>
        {children}
      </ContextMenuTrigger>
      <DropdownContent
        aria-label={label}
        // Anchored where the pointer was, opening down and to the right like
        // every other context menu on the platform, and narrower than the
        // registry's 288px default: these rows are two or three words.
        side="bottom"
        align="start"
        sideOffset={0}
        className="w-56"
      >
        {placed.map(({ row, key, index }) => {
          if (row.kind === "separator") return <DropdownSeparator key={key} />;
          if (row.kind === "label") return <DropdownLabel key={key}>{row.label}</DropdownLabel>;
          return (
            <MenuItem
              key={key}
              index={index}
              label={row.label}
              onSelect={row.onSelect}
              {...(row.icon === undefined ? {} : { icon: row.icon })}
              {...(row.disabled === undefined ? {} : { disabled: row.disabled })}
              {...(row.destructive === undefined ? {} : { destructive: row.destructive })}
            />
          );
        })}
      </DropdownContent>
    </ContextMenu>
  );
}
