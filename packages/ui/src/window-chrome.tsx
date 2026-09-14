/**
 * The shape of the window, shared by every screen that fills it.
 *
 * There are two — the workspace and settings — and they are the same window with
 * different contents: an inset sidebar on the window's own surface, a bar above
 * a raised card, and the card. That was a claim written twice and drifting;
 * settings had an uninset sidebar, no way back from a collapsed one, and its
 * form against the window frame. It is now one set of constants, so a change to
 * the window is a change to the window.
 */

import { cn, Elevated, SidebarTrigger, useSidebar, useSize } from "@janela/design";
import type { ReactElement, ReactNode } from "react";

/**
 * The strip above the content card.
 *
 * It sits on the window's own surface — the same colour the sidebar is painted
 * in, outside the card — because what it holds are *handles on* the card below,
 * not things inside it. On the card, tabs read as chrome the terminals grew; off
 * it, the card is one object the tabs point at, which is also what makes a tab
 * plausible to drag somewhere else later.
 *
 * No height of its own: `p-1` around content that is one step of the size ladder
 * tall, which is the 4px the card insets its panes by on either side of a
 * control. A number here would be a third place to re-tier — the ladder decides
 * how tall a control is, and this bar is a control's worth of band.
 */
export const WINDOW_BAR = "flex shrink-0 items-center gap-1 p-1";

/**
 * The raised surface a screen's content is drawn on.
 *
 * One step above the window, which is level 1 — so the card is level 2, and
 * `Elevated` both paints it and *announces* it: a menu opened from anything
 * inside climbs from 2, not from the page. That announcement is the reason this
 * is a component and not the class string it used to be. Without it a dropdown
 * over the card computed its colour from a substrate that was two steps down.
 *
 * The sidebar's `inset` variant paints nothing itself, so this card is the only
 * thing separating the content from the window behind it; in dark appearance
 * both would otherwise be `--background`.
 */
export function ContentCard(props: {
  readonly className?: string | undefined;
  readonly children?: ReactNode;
}): ReactElement {
  return (
    <Elevated
      offset={1}
      className={cn("relative min-h-0 flex-1 overflow-hidden rounded-xl", props.className)}
    >
      {props.children}
    </Elevated>
  );
}

/**
 * Where the panes live: spacing, and nothing else.
 *
 * Deliberately not a card. A terminal is the thing that is raised off the
 * window — it has a surface of its own, and a card behind it would be a second
 * elevation saying the same thing twice, plus a visible frame around a pane that
 * already has an edge. So this contributes only the 4px inset that keeps the
 * panes off the window's edge and off each other.
 */
export const PANE_REGION = "relative min-h-0 flex-1 overflow-hidden p-1";

/**
 * What `SidebarInset` is left doing: being the column.
 *
 * Its own surface, radius and shadow move inward to `CONTENT_CARD`, because the
 * bar above the card is not part of the card. What stays is what only the
 * primitive can do — the inset margins, and the one that closes when the sidebar
 * collapses.
 */
export const WINDOW_COLUMN =
  "min-w-0 gap-1.5 overflow-hidden bg-transparent md:peer-data-[variant=inset]:rounded-none md:peer-data-[variant=inset]:bg-transparent md:peer-data-[variant=inset]:shadow-none";

/**
 * The sidebar's scrolling region, for both screens that have one.
 *
 * The scrollbar has to come in off the edge, because the sidebar's own
 * resize/collapse rail is already there: an 8px strip on the panel's inner edge,
 * above the scroller in z-order. Left flush, 8px of the track's 10px sit behind
 * the rail — the thumb unhoverable, and a drag on it resizing the sidebar
 * instead of scrolling it. Two pointer targets, one strip, and the rail wins.
 *
 * A translate rather than an offset: the primitive positions its scrollbar with
 * an *inline* `inset-inline-end`, which no class can outrank without
 * `!important`. Nothing sets a transform on it, so moving it that way is
 * composition rather than a fight with the cascade.
 */
export const SIDEBAR_SCROLLER = "[&_[data-slot='scroll-area-scrollbar']]:-translate-x-2";

/**
 * The measure a settings pane reads in, centred in the card.
 *
 * Here rather than in `settings-window.tsx` because two modules need it and one
 * of them is that file's own child: a project's pane owns its scroller — its
 * Save footer has to sit outside it — so it applies this itself, and a pane
 * whose fields did not line up with every other pane's would be visible the
 * moment you switched rows.
 */
export const PANE_COLUMN = "mx-auto max-w-2xl p-6";

/**
 * The "show the sidebar again" control, which exists only while it is hidden.
 *
 * Collapsing is offcanvas — the list is names, and a column of initials would be
 * useless — so the button that brings it back cannot live in the sidebar. It
 * sits at the head of the window bar instead, where the space it takes is space
 * the tabs were not using.
 *
 * The primitive's trigger brings its own tooltip, which names the action for the
 * state it is in ("Expand sidebar" here) and carries the ⌘B chip. Wrapping it in
 * a second tooltip would have stacked two popups on one control.
 */
export function ShowSidebarButton(): ReactElement | null {
  const { state } = useSidebar();
  if (state !== "collapsed") return null;
  return <SidebarTrigger className="mr-1" />;
}

/**
 * The window bar on screens that have nothing else to put in it.
 *
 * Nothing, while the sidebar is open: a band above the card holding one absent
 * button is a band of nothing. It appears with the button, because that button
 * is the only way back from an offcanvas sidebar.
 *
 * The row inside it is a control tall even though the trigger is smaller, so the
 * bar is the same height here as it is over a tab strip. Otherwise the card
 * would jump 4px between the welcome screen and a session.
 */
export function ShowSidebarBar(): ReactElement | null {
  const { state } = useSidebar();
  const size = useSize();
  if (state !== "collapsed") return null;
  return (
    <div className={WINDOW_BAR}>
      <div className={cn(size.control, "flex items-center")}>
        <ShowSidebarButton />
      </div>
    </div>
  );
}
