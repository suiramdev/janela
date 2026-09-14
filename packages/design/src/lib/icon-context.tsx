import {
  ArrowRight01Icon,
  Cancel01Icon,
  Search01Icon,
  SidebarLeftIcon,
  SidebarRightIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { createContext, useContext, useMemo, type ComponentType, type ReactNode } from "react";

export interface IconComponentProps {
  size?: number;
  strokeWidth?: number;
  className?: string;
}

export type IconComponent = ComponentType<IconComponentProps>;

/**
 * The names the vendored components ask for.
 *
 * Upstream's table is 59 Lucide icons, most of which nothing here renders. This
 * application's icon library is Hugeicons (packages/design/components.json), so
 * every entry is a Hugeicons component and the union is the set the sidebar
 * actually looks up — an unused name would be an icon import that ships in the
 * bundle to be a table row.
 */
export type IconName = "chevron-right" | "panel-left" | "panel-right" | "search" | "x";

/**
 * Hugeicons takes its glyph as data on one component; the registry's contract is
 * a component per icon. The adapter is per glyph and defined once, at module
 * scope, so a row of this table is a stable component type rather than a new
 * one on every render.
 */
export function hugeicon(icon: IconSvgElement): IconComponent {
  return function Icon({ size = 16, strokeWidth = 1.5, className }: IconComponentProps) {
    return (
      <HugeiconsIcon icon={icon} size={size} strokeWidth={strokeWidth} className={className} />
    );
  };
}

export const defaultIcons: Record<IconName, IconComponent> = {
  "chevron-right": hugeicon(ArrowRight01Icon),
  "panel-left": hugeicon(SidebarLeftIcon),
  "panel-right": hugeicon(SidebarRightIcon),
  search: hugeicon(Search01Icon),
  // The dialog's corner close. Hugeicons calls it Cancel01; the registry's
  // components ask for it by the Lucide name, which is the table's contract.
  x: hugeicon(Cancel01Icon),
};

const IconContext = createContext<Record<IconName, IconComponent> | null>(null);

/**
 * Returns a single icon component for the given name.
 * Falls back to the default (Hugeicons) set if no provider is present.
 */
function useIcon(name: IconName): IconComponent {
  const icons = useContext(IconContext);
  return (icons ?? defaultIcons)[name];
}

/**
 * Returns the full icon map.
 * Falls back to the default (Hugeicons) set if no provider is present.
 */
function useIcons(): Record<IconName, IconComponent> {
  const icons = useContext(IconContext);
  return icons ?? defaultIcons;
}

/**
 * Swap some or all icons for components from another library.
 * Names left out of `icons` keep their default (Hugeicons) component.
 */
function IconProvider({
  children,
  icons,
}: {
  children: ReactNode;
  icons?: Partial<Record<IconName, IconComponent>>;
}) {
  const value = useMemo(() => ({ ...defaultIcons, ...icons }), [icons]);
  return <IconContext.Provider value={value}>{children}</IconContext.Provider>;
}

export { IconProvider, useIcon, useIcons };
