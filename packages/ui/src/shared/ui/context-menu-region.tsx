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

export type MenuRow =
  | {
      readonly kind: "item";
      readonly label: string;
      readonly icon?: IconComponent;
      readonly onSelect: () => void;
      readonly disabled?: boolean;
      readonly destructive?: boolean;
    }
  | { readonly kind: "label"; readonly label: string }
  | { readonly kind: "separator" };

export type MenuActionRow = Extract<MenuRow, { kind: "item" }>;

export interface ContextMenuRegionProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  readonly label: string;
  readonly rows: readonly MenuRow[];
  readonly className?: string;
  readonly onOpen?: () => void;
  readonly children: ReactNode;
}

interface PlacedRow {
  readonly row: MenuRow;
  readonly key: string;
  readonly index: number;
}

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
