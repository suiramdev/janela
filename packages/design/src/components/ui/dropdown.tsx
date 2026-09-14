import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import type { MenuTriggerProps } from "@base-ui/react/menu";
import { cn } from "cn";
import { motion, AnimatePresence } from "framer-motion";
import {
  useRef,
  useState,
  useEffect,
  useCallback,
  useMemo,
  createContext,
  useContext,
  forwardRef,
  type ReactNode,
  type HTMLAttributes,
  type ComponentProps,
} from "react";

import { useFluidHover } from "../../hooks/use-fluid-hover.ts";
import { Elevated } from "../../lib/elevated.tsx";
import {
  popupMotionClass,
  popupScrollAreaClass,
  popupViewportClass,
  isDisabledRow,
} from "../../lib/popup.ts";
import { shapeMap } from "../../lib/shape-context.tsx";
import { SizeProvider, useSize, type SizeVariant } from "../../lib/size-context.tsx";
import { spring, exitFallbackMs } from "../../lib/springs.ts";
import { FluidHoverHighlight } from "./fluid-hover-highlight.tsx";
import {
  DropdownContext,
  useDropdown,
  useDropdownMaybe,
  type DropdownContextValue,
  type MenuItemRenderOptions,
} from "./menu-item.tsx";
import { ScrollArea } from "./scroll-area.tsx";

// Dropdown opts out of the global pill/rounded shape context — popover surfaces
// look cleaner with the smaller "rounded" radii regardless of how the rest of
// the UI is shaped (the heavy pill bubbling distorts perceived padding at this
// scale and produces the corner-shadow asymmetry).
const shape = shapeMap.rounded;

// ---------------------------------------------------------------------------
// Panel context — shared by the inline Dropdown and the popup DropdownContent.
//
// The context object itself lives in menu-item.tsx so MenuItem resolves
// whichever dropdown provider actually wraps it, even when dropdowns built
// on different primitives render side by side. Re-exported here so the
// public dropdown API is unchanged.
// ---------------------------------------------------------------------------

export { useDropdown, useDropdownMaybe };
export type { DropdownContextValue, MenuItemRenderOptions };

// ---------------------------------------------------------------------------
// DropdownMenu (popup root)
//
// Built on Base UI's Menu primitive, which owns the trigger wiring,
// positioning (collision flipping, anchor tracking), dismissal (outside
// press, focus-out, Escape), roving highlight, typeahead, and close-on-select.
// This layer keeps the fluid-hover overlays and the
// spring open/close animation (via actionsRef deferred unmount) — the same
// verified pattern as select.tsx.
// ---------------------------------------------------------------------------

interface DropdownMenuActions {
  unmount: () => void;
  close: () => void;
}

interface DropdownMenuContextValue {
  open: boolean;
  actionsRef: React.RefObject<DropdownMenuActions | null>;
  /** A context menu anchors to the pointer, so its popup needs the other
   *  primitive's positioner. Every part below it is Menu's own. */
  contextual: boolean;
}

const DropdownMenuContext = createContext<DropdownMenuContextValue | null>(null);

function useDropdownMenuContext() {
  const ctx = useContext(DropdownMenuContext);
  if (!ctx) throw new Error("DropdownMenu compound components must be inside <DropdownMenu>");
  return ctx;
}

interface DropdownMenuProps {
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  /** Pins trigger-side content and the portalled popup rows to one step of
   *  the size ladder (default 36px, compact 28px — see /docs/sizes).
   *  Omitted, they follow the surrounding SizeProvider. */
  size?: SizeVariant;
}

function DropdownMenu({
  children,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  disabled = false,
  size,
}: DropdownMenuProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const open = openProp !== undefined ? openProp : internalOpen;
  const actionsRef = useRef<DropdownMenuActions | null>(null);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [openProp, onOpenChange],
  );

  const ctx = useMemo(() => ({ open, actionsRef, contextual: false }), [open]);

  // A size prop pins the whole compound (trigger content + portalled popup —
  // React context crosses portals) to one ladder step.
  const root = (
    <DropdownMenuContext.Provider value={ctx}>
      <Menu.Root
        open={open}
        onOpenChange={handleOpenChange}
        actionsRef={actionsRef}
        disabled={disabled}
        // Non-modal: the page keeps scrolling and the Positioner tracks the
        // anchor, so the popup follows its trigger instead of detaching.
        modal={false}
      >
        {children}
      </Menu.Root>
    </DropdownMenuContext.Provider>
  );

  return size ? <SizeProvider size={size}>{root}</SizeProvider> : root;
}

DropdownMenu.displayName = "DropdownMenu";

// ---------------------------------------------------------------------------
// DropdownTrigger
//
// Base UI's Menu.Trigger, re-exported under the library name. Composes via
// the `render` prop, so any element can be the trigger:
//
//   <DropdownTrigger render={<Button variant="secondary">Open</Button>} />
// ---------------------------------------------------------------------------

type DropdownTriggerProps = MenuTriggerProps;

const DropdownTrigger = Menu.Trigger;

// ---------------------------------------------------------------------------
// DropdownContent (popup panel)
//
// Portal > Positioner > Popup carrying the exact inline-panel visuals:
// Elevated surface, fluid-hover overlays, animated selected background,
// and animated focus ring. Children are wrapped in a Menu.RadioGroup so
// radio-style MenuItems (boolean `checked`) get correct aria-checked from
// `checkedIndex`.
// ---------------------------------------------------------------------------

type MenuPositionerProps = ComponentProps<typeof Menu.Positioner>;

interface DropdownContentProps {
  children: ReactNode;
  className?: string;
  /** Index of the checked item. Drives the animated selected background and
   *  the radio-group value announced to assistive tech. */
  checkedIndex?: number;
  side?: MenuPositionerProps["side"];
  align?: MenuPositionerProps["align"];
  sideOffset?: number;
  /**
   * Adapted: the popup's accessible name.
   *
   * A dropdown is named by its trigger, which Base UI wires up for it. A context
   * menu has no trigger to be named by — its trigger is a region of the window —
   * so this is the only place "Terminal: zsh" can be said.
   */
  "aria-label"?: string;
}

const DropdownContent = forwardRef<HTMLDivElement, DropdownContentProps>(
  (
    {
      className,
      children,
      checkedIndex,
      "aria-label": ariaLabel,
      side = "bottom",
      align = "start",
      sideOffset = 6,
    },
    ref,
  ) => {
    const { open, actionsRef, contextual } = useDropdownMenuContext();
    // The two positioners have the same props and different anchors: Menu's
    // tracks the trigger element, the context menu's the point that was
    // right-clicked. Everything inside — portal, popup, items — is shared.
    const Positioner = contextual ? ContextMenuPrimitive.Positioner : Menu.Positioner;
    const containerRef = useRef<HTMLDivElement>(null);

    const hover = useFluidHover(containerRef, { isItemDisabled: isDisabledRow });
    const { activeIndex, setActiveIndex, itemRects, handlers, registerItem, remeasure } = hover;

    // Open ready to act: focus the first enabled row, a frame after the
    // primitive's own open autofocus, which lands on the popup for pointer
    // opens.
    useEffect(() => {
      if (!open) return;
      let inner: number | undefined;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => {
          const container = containerRef.current;
          if (
            !container ||
            (container.contains(document.activeElement) && document.activeElement !== container)
          )
            return;
          const first = container.querySelector<HTMLElement>(
            '[role="menuitem"]:not([aria-disabled="true"]), [role="menuitemradio"]:not([aria-disabled="true"]), [role="menuitemcheckbox"]:not([aria-disabled="true"])',
          );
          first?.focus();
        });
      });
      return () => {
        cancelAnimationFrame(outer);
        if (inner !== undefined) cancelAnimationFrame(inner);
      };
    }, [open]);

    // Release Base UI's deferred unmount once the exit tween has played.
    // onAnimationComplete on the motion.div is the primary signal; this
    // timeout is a fallback for throttled/background tabs where rAF-driven
    // animation callbacks can stall. The popup exits with spring.fast, so the
    // fallback tracks that tier's exit duration plus a safety buffer.
    useEffect(() => {
      if (open) return;
      const id = setTimeout(() => actionsRef.current?.unmount(), exitFallbackMs(spring.fast));
      return () => clearTimeout(id);
    }, [open, actionsRef]);

    // The popup keeps its rows registered between opens, so their rects
    // were taken while it was hidden: re-measure once it is open and laid out.
    useEffect(() => {
      if (!open) return;
      remeasure();
    }, [open, remeasure]);

    const checkedRect = (checkedIndex == null ? null : itemRects[checkedIndex]) ?? null;
    // Multiple: one merged block per contiguous run of checked rows.
    // Inside the popup, Base UI's Menu.Item / Menu.RadioItem own the role,
    // aria-checked, tabIndex, roving highlight, typeahead, and Enter/Space/
    // click activation (activation synthesizes a click, so the row div's
    // onClick also fires for keyboard). The render div carries the Fluid
    // Functionalism visuals and the fluid-hover registration.
    const renderMenuItem = useCallback(
      ({
        radio,
        checkbox,
        checked,
        value,
        disabled,
        label,
        closeOnClick,
        element,
        children,
      }: MenuItemRenderOptions) =>
        checkbox ? (
          // The row's own onClick toggles the consumer state; the primitive
          // only owns the role, aria-checked, and keyboard activation.
          <Menu.CheckboxItem
            checked={!!checked}
            disabled={disabled}
            label={label}
            closeOnClick={closeOnClick}
            render={element}
          >
            {children}
          </Menu.CheckboxItem>
        ) : radio ? (
          <Menu.RadioItem
            value={value}
            disabled={disabled}
            label={label}
            closeOnClick={closeOnClick}
            render={element}
          >
            {children}
          </Menu.RadioItem>
        ) : (
          <Menu.Item disabled={disabled} label={label} closeOnClick={closeOnClick} render={element}>
            {children}
          </Menu.Item>
        ),
      [],
    );

    const contentCtx = useMemo(
      () => ({
        registerItem,
        activeIndex,
        ...(checkedIndex === undefined ? {} : { checkedIndex }),
        multiple: false,
        inMenu: true,
        renderMenuItem,
      }),
      [registerItem, activeIndex, checkedIndex, renderMenuItem],
    );

    return (
      <Menu.Portal>
        <Positioner side={side} align={align} sideOffset={sideOffset} className="z-50 outline-none">
          <motion.div
            className={popupMotionClass}
            initial={{ opacity: 0, y: "var(--popup-enter-y)", scaleY: 0.96 }}
            animate={
              open
                ? { opacity: 1, y: 0, scaleY: 1 }
                : { opacity: 0, y: "var(--popup-enter-y)", scaleY: 0.96 }
            }
            transition={open ? spring.fast : spring.fast.exit}
            // Base UI defers unmount while actionsRef is set; release it once
            // the exit spring has finished so the close animation fully plays.
            onAnimationComplete={() => {
              if (!open) actionsRef.current?.unmount();
            }}
          >
            <DropdownContext.Provider value={contentCtx}>
              <Menu.Popup
                aria-label={ariaLabel}
                render={<Elevated offset={2} shadowLevel={3} ref={ref} />}
                onMouseEnter={handlers.onMouseEnter}
                onMouseMove={handlers.onMouseMove}
                onClick={handlers.onClick}
                onMouseLeave={handlers.onMouseLeave}
                onFocus={(e) => {
                  const indexAttr = (e.target as HTMLElement)
                    .closest("[data-fluid-hover-index]")
                    ?.getAttribute("data-fluid-hover-index");
                  // Keyboard navigation moves the hover background only — no
                  // ring: in a menu the highlighted row is the focus indicator.
                  if (indexAttr != null) {
                    setActiveIndex(Number(indexAttr));
                  } else if (e.target !== e.currentTarget) {
                    // Focus moved to some other non-row inside the popup: no
                    // row is highlighted any more. The popup focusing itself
                    // (pointer leaving a row) doesn't count.
                    setActiveIndex(null);
                  }
                }}
                onBlur={(e) => {
                  // The popup itself takes focus when the pointer leaves a row; only a
                  // departure from the whole popup ends the hover session.
                  if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                  setActiveIndex(null);
                }}
                className={cn(
                  // min-w tracks the trigger via the Positioner's
                  // --anchor-width var.
                  `flex max-h-[min(480px,var(--available-height))] w-72 max-w-full min-w-[var(--anchor-width)] flex-col overflow-hidden ${shape.container} outline-none select-none`,
                  className,
                )}
              >
                {/* The list scrolls inside a ScrollArea; this wrapper is the rows'
                    offsetParent, so the overlays scroll with them. */}
                <ScrollArea
                  className={popupScrollAreaClass}
                  viewportClassName={cn(popupViewportClass, "scroll-fade")}
                >
                  <div ref={containerRef} className="relative flex flex-col p-1">
                    {/* Selected background */}
                    <AnimatePresence>
                      {checkedRect && (
                        <motion.div
                          className={`absolute ${shape.bg} bg-active pointer-events-none`}
                          initial={false}
                          animate={{
                            top: checkedRect.top,
                            left: checkedRect.left,
                            width: checkedRect.width,
                            height: checkedRect.height,
                            opacity: 1,
                          }}
                          exit={{ opacity: 0, transition: spring.moderate.exit }}
                          transition={{
                            ...spring.moderate,
                            opacity: { duration: 0.08 },
                          }}
                        />
                      )}
                    </AnimatePresence>

                    {/* Hover background */}
                    <FluidHoverHighlight hover={hover} from={checkedRect} className={shape.bg} />

                    {/* display: contents keeps items direct flex children of the
                    wrapper so fluid hover measurement and gap layout still work,
                    while the group provides the radio value context. */}
                    <Menu.RadioGroup value={checkedIndex ?? null} className="contents">
                      {children}
                    </Menu.RadioGroup>
                  </div>
                </ScrollArea>
              </Menu.Popup>
            </DropdownContext.Provider>
          </motion.div>
        </Positioner>
      </Menu.Portal>
    );
  },
);

DropdownContent.displayName = "DropdownContent";

// ---------------------------------------------------------------------------
// ContextMenu (right-click root)
//
// Adapted: the registry ships no context menu. It does not need to — Base UI's
// ContextMenu is a Menu whose *positioner* anchors to the pointer instead of to
// a trigger element, and every part below that (portal, popup, item, group) is
// literally Menu's own. So this is the same `DropdownContent` popup, with the
// same surface, fluid hover, spring and dismissal, under the other root:
//
//   <ContextMenu>
//     <ContextMenuTrigger render={<div />}>…</ContextMenuTrigger>
//     <DropdownContent side="bottom" align="start" sideOffset={0}>
//       <MenuItem index={0} label="…" onSelect={…} />
//     </DropdownContent>
//   </ContextMenu>
//
// A right-click anywhere in the trigger opens it; a long press does on touch.
// ---------------------------------------------------------------------------

interface ContextMenuProps {
  children: ReactNode;
  onOpenChange?: (open: boolean) => void;
  /** Pins the popup's rows to one step of the size ladder. Omitted, they follow
   *  the surrounding SizeProvider. */
  size?: SizeVariant;
}

function ContextMenu({ children, onOpenChange, size }: ContextMenuProps) {
  // Uncontrolled: the gesture opens it and a pick or a dismissal closes it.
  // There is no state a caller could own that the pointer does not already
  // decide. `open` is mirrored here only so the popup can animate its exit.
  const [open, setOpen] = useState(false);
  const actionsRef = useRef<DropdownMenuActions | null>(null);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  const ctx = useMemo(() => ({ open, actionsRef, contextual: true }), [open]);

  const root = (
    <DropdownMenuContext.Provider value={ctx}>
      <ContextMenuPrimitive.Root
        open={open}
        onOpenChange={handleOpenChange}
        actionsRef={actionsRef}
      >
        {children}
      </ContextMenuPrimitive.Root>
    </DropdownMenuContext.Provider>
  );

  return size ? <SizeProvider size={size}>{root}</SizeProvider> : root;
}

ContextMenu.displayName = "ContextMenu";

const ContextMenuTrigger = ContextMenuPrimitive.Trigger;

// ---------------------------------------------------------------------------
// DropdownLabel
// ---------------------------------------------------------------------------

const DropdownLabel = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    // Group labels are the caption role of the type scale — see /docs/sizes.
    const compact = useSize().variant === "compact";
    return (
      <div
        ref={ref}
        className={cn(
          "px-2 py-1.5 shrink-0 text-muted-foreground",
          compact ? "text-[11px]" : "text-[12px]",
          className,
        )}
        {...props}
      />
    );
  },
);

DropdownLabel.displayName = "DropdownLabel";

// ---------------------------------------------------------------------------
// DropdownSeparator
// ---------------------------------------------------------------------------

const DropdownSeparator = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      role="separator"
      className={cn("my-1 -mx-1 h-px shrink-0 bg-border/60", className)}
      {...props}
    />
  ),
);

DropdownSeparator.displayName = "DropdownSeparator";

export {
  ContextMenu,
  ContextMenuTrigger,
  DropdownContent,
  DropdownLabel,
  DropdownMenu,
  DropdownSeparator,
  DropdownTrigger,
};
// DropdownContextValue and MenuItemRenderOptions are already re-exported
// above next to their import — repeating them here is a duplicate-export
// build error.
export type { DropdownContentProps, DropdownMenuProps, DropdownTriggerProps };
