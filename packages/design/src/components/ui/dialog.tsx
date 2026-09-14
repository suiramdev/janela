import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cn } from "cn";
import { motion, type MotionStyle } from "framer-motion";
import {
  forwardRef,
  isValidElement,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";

import { useIcon } from "../../lib/icon-context.tsx";
import { useShape } from "../../lib/shape-context.tsx";
import { useSize, useSizeVariant } from "../../lib/size-context.tsx";
import { spring } from "../../lib/springs.ts";
import { surfaceClasses } from "../../lib/surface-classes.ts";
import { SurfaceProvider, useSurface } from "../../lib/surface-context.tsx";
import { Button } from "./button.tsx";

const DIALOG_OFFSET = 4;

interface DialogProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  modal?: boolean;
  children?: ReactNode;
}

function Dialog({ children, open, defaultOpen, onOpenChange, modal }: DialogProps) {
  // Base UI's Root handles controlled/uncontrolled state internally. We only
  // narrow the (open, eventDetails) callback to (open) for our public prop.
  return (
    <DialogPrimitive.Root
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={(next) => onOpenChange?.(next)}
      modal={modal}
    >
      {children}
    </DialogPrimitive.Root>
  );
}

// Trigger and Close compose either way — `render={<Button/>}` (the
// library's composition API, shared with DropdownTrigger) or Radix-style
// `asChild` with a single child element — so one snippet works everywhere.
// Plain button attributes, which both the trigger and the close accept —
// their state-typed render/className/style function forms stay off the
// public surface.
interface DialogSlotProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Element to render as the control, e.g. a Button. */
  render?: ReactElement;
  /** Compose onto the single child element instead. */
  asChild?: boolean;
}

function slotRender(
  render: ReactElement | undefined,
  asChild: boolean | undefined,
  children: ReactNode,
) {
  if (render) return render;
  return asChild && isValidElement(children) ? (children as ReactElement) : undefined;
}

const DialogTrigger = forwardRef<HTMLButtonElement, DialogSlotProps>(
  ({ render, asChild, children, ...props }, ref) => {
    const el = slotRender(render, asChild, children);
    return el ? (
      <DialogPrimitive.Trigger ref={ref} render={el} {...props} />
    ) : (
      <DialogPrimitive.Trigger ref={ref} {...props}>
        {children}
      </DialogPrimitive.Trigger>
    );
  },
);
DialogTrigger.displayName = "DialogTrigger";

const DialogClose = forwardRef<HTMLButtonElement, DialogSlotProps>(
  ({ render, asChild, children, ...props }, ref) => {
    const el = slotRender(render, asChild, children);
    return el ? (
      <DialogPrimitive.Close ref={ref} render={el} {...props} />
    ) : (
      <DialogPrimitive.Close ref={ref} {...props}>
        {children}
      </DialogPrimitive.Close>
    );
  },
);
DialogClose.displayName = "DialogClose";

interface DialogContentProps extends HTMLAttributes<HTMLDivElement> {
  /** Width: sm 400, lg 540, xl 880 (each one notch narrower in compact
   *  regions). `xl` is the canvas for composed layouts — a sidebar beside
   *  a panel — which usually pair it with `className="p-0"` and a fixed
   *  height. */
  size?: "sm" | "lg" | "xl";
  /** Portal target. When set, the overlay and panel render inside this element
   *  (positioned `absolute`) instead of covering the viewport (`fixed`). Pair
   *  with a `position: relative; overflow: hidden` container — and usually
   *  `<Dialog modal={false}>` — to scope a dialog to a bounded region, e.g. a
   *  docs preview. Defaults to the document body / full-viewport behaviour. */
  container?: HTMLElement | null;
  /** The ✕ in the top-right corner. Drop it when the content has its own
   *  way out, e.g. a command menu that closes on Escape and on a pick.
   *  @default true */
  showCloseButton?: boolean;
  /** Where the panel sits: centered, or anchored 12dvh from the top so a
   *  panel whose height follows its content (a command menu) keeps its top
   *  edge still. @default "center" */
  position?: "center" | "top";
  /**
   * Adapted: the two focus props are the primitive's and are forwarded to it
   * rather than spread onto the panel.
   *
   * Every sheet in this application is opened from a menu, a chord or the
   * palette, so there is no trigger to return focus to — `finalFocus={false}`
   * turns that off and the host sends focus back to the terminal itself
   * (`sheets.tsx`). `initialFocus` picks the field the sheet was opened to
   * type in, which is not always the first tabbable one.
   *
   * They are named here because the registry's panel spreads the rest of its
   * props onto a `motion.div`: left in that bag, these two would become DOM
   * attributes and the primitive would never see them.
   */
  initialFocus?: DialogPrimitive.Popup.Props["initialFocus"];
  finalFocus?: DialogPrimitive.Popup.Props["finalFocus"];
}

const DialogContent = forwardRef<HTMLDivElement, DialogContentProps>(
  (
    {
      className,
      children,
      size = "sm",
      container,
      showCloseButton = true,
      position = "center",
      initialFocus,
      finalFocus,
      ...props
    },
    ref,
  ) => {
    const XIcon = useIcon("x");
    const shape = useShape();
    const substrate = useSurface();
    const dialogLevel = Math.min(substrate + DIALOG_OFFSET, 8);
    // The size ladder narrows the dialog one notch in compact regions —
    // width only, the padding stays put (see /docs/sizes).
    const compact = useSize().variant === "compact";

    // No `if (!open) return null` here — Base UI's `<DialogPrimitive.Popup>`
    // handles mount/unmount itself, and waits for the framer-motion opacity
    // tween below to finish (via `element.getAnimations()`) before unmounting.
    // Returning null early would short-circuit the closing animation.
    return (
      <DialogPrimitive.Portal container={container ?? undefined}>
        <DialogPrimitive.Backdrop
          render={(backdropProps, state) => {
            const exiting = state.transitionStatus === "ending";
            const {
              style: _style,
              onDrag: _onDrag,
              onDragStart: _onDragStart,
              onDragEnd: _onDragEnd,
              onAnimationStart: _onAnimationStart,
              onAnimationEnd: _onAnimationEnd,
              onAnimationIteration: _onAnimationIteration,
              ...rest
            } = backdropProps as HTMLAttributes<HTMLDivElement>;
            return (
              <motion.div
                {...rest}
                className={cn(
                  container ? "absolute" : "fixed",
                  "inset-0 z-50 bg-black/40 dark:bg-black/80",
                )}
                initial={{ opacity: 0 }}
                animate={{ opacity: exiting ? 0 : 1 }}
                transition={exiting ? spring.slow.exit : spring.slow}
              />
            );
          }}
        />
        <DialogPrimitive.Popup
          ref={ref}
          initialFocus={initialFocus}
          finalFocus={finalFocus}
          render={(popupProps, state) => {
            const exiting = state.transitionStatus === "ending";
            const {
              style: baseStyle,
              onDrag: _onDrag,
              onDragStart: _onDragStart,
              onDragEnd: _onDragEnd,
              onAnimationStart: _onAnimationStart,
              onAnimationEnd: _onAnimationEnd,
              onAnimationIteration: _onAnimationIteration,
              ...rest
            } = popupProps as HTMLAttributes<HTMLDivElement>;
            return (
              <motion.div
                // Base UI's props first (data attrs, refs, role, etc.)…
                {...rest}
                // …then the consumer's `<DialogContent>` props (className,
                // event handlers, data-*, etc.) land on the visible motion.div.
                {...(props as Omit<
                  HTMLAttributes<HTMLDivElement>,
                  | "onDrag"
                  | "onDragStart"
                  | "onDragEnd"
                  | "onAnimationStart"
                  | "onAnimationEnd"
                  | "onAnimationIteration"
                >)}
                className={cn(
                  container ? "absolute" : "fixed",
                  "left-1/2 z-50 w-[calc(100%-2rem)]",
                  position === "top" ? "top-[12dvh]" : "top-1/2",
                  // Adapted: the shadow is pinned to 5 rather than tracking the
                  // panel's own level. A modal is the top of the ladder wherever
                  // it was opened from, and the scrim — not a deeper shadow —
                  // is what separates it from the window.
                  surfaceClasses(dialogLevel, 5),
                  "p-6 text-foreground focus:outline-none",
                  size === "sm" && (compact ? "max-w-[360px]" : "max-w-[400px]"),
                  size === "lg" && (compact ? "max-w-[480px]" : "max-w-[540px]"),
                  size === "xl" && (compact ? "max-w-[800px]" : "max-w-[880px]"),
                  shape.container,
                  className,
                )}
                // Adapted: one cast, because `exactOptionalPropertyTypes` reads
                // a spread `CSSProperties` as "every property, possibly
                // undefined" and framer-motion's `MotionStyle` declares them
                // without it. The values are the primitive's own inline styles
                // and the caller's; neither is narrowed here.
                style={
                  {
                    ...(baseStyle as CSSProperties | undefined),
                    ...(props.style as CSSProperties | undefined),
                  } as MotionStyle
                }
                initial={{
                  opacity: 0,
                  scale: 0.97,
                  x: "-50%",
                  y: position === "top" ? 0 : "-50%",
                }}
                animate={{
                  opacity: exiting ? 0 : 1,
                  scale: exiting ? 0.97 : 1,
                  x: "-50%",
                  y: position === "top" ? 0 : "-50%",
                }}
                transition={exiting ? spring.slow.exit : spring.slow}
              >
                {/* A menu opened from inside the dialog climbs from the dialog. */}
                <SurfaceProvider value={dialogLevel}>
                  {children}
                  {showCloseButton && (
                    <DialogPrimitive.Close
                      render={
                        <Button variant="ghost" size="icon-sm" className="absolute top-3 right-3" />
                      }
                    >
                      <XIcon />
                      <span className="sr-only">Close</span>
                    </DialogPrimitive.Close>
                  )}
                </SurfaceProvider>
              </motion.div>
            );
          }}
        />
      </DialogPrimitive.Portal>
    );
  },
);
DialogContent.displayName = "DialogContent";

function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mb-4 flex flex-col gap-1.5", className)} {...props} />;
}

function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mt-6 flex justify-end gap-2", className)} {...props} />;
}

const DialogTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => {
    // The title role of the type scale — see /docs/sizes.
    const compact = useSizeVariant() === "compact";
    return (
      <DialogPrimitive.Title
        ref={ref}
        className={cn(
          compact ? "text-[15px]" : "text-[16px]",
          "text-foreground leading-tight",
          className,
        )}
        style={{ fontVariationSettings: "'wght' 700" }}
        {...props}
      />
    );
  },
);
DialogTitle.displayName = "DialogTitle";

const DialogDescription = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => {
    const compact = useSizeVariant() === "compact";
    return (
      <DialogPrimitive.Description
        ref={ref}
        className={cn(compact ? "text-[12px]" : "text-[13px]", "text-muted-foreground", className)}
        {...props}
      />
    );
  },
);
DialogDescription.displayName = "DialogDescription";

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
};
export type { DialogContentProps, DialogProps, DialogSlotProps };
