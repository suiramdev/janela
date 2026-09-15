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

import { useClientEnvironment, useStoreValue } from "./client-environment.tsx";

/**
 * Where macOS draws this window's controls.
 *
 * The title bar is an overlay — `titleBarStyle: "Overlay"` and `hiddenTitle` in
 * `tauri.conf.json` — so the traffic lights sit *inside* the window rather than
 * in a strip above it, and the sidebar's first row is what they land on. That is
 * the row that used to carry the mark and the word "Janela", which were saying
 * the app's name a second time 16px below a title bar already saying it.
 *
 * Two places have to agree and cannot import each other, so these are the
 * numbers and `apps/desktop`'s `window-controls.test.ts` holds the config to
 * them. Both are measured against this row rather than chosen: `x` puts the
 * close button where the mark's left edge was, and `y` centres a 16pt button on
 * a 28px row whose top is 16px down — the sidebar panel's `py-2`, then the
 * header's `p-2`.
 *
 * `y` is **not** the buttons' top edge. tao resizes the title bar *container* to
 * `buttonHeight + y` and moves the buttons only horizontally, which leaves their
 * top at `y - 10`: 10 puts them flush against the window's edge, 32 puts them at
 * 22. Measured on a running window through the accessibility API, because the
 * arithmetic is AppKit's and not ours to predict.
 */
export const TRAFFIC_LIGHT_POSITION = { x: 12, y: 32 } as const;

/**
 * The room the three buttons need, at the head of the row they land on.
 *
 * 68px, and the row's own leading padding makes up the rest of the 74 the
 * buttons occupy — so the control after this one clears the zoom button by a
 * couple of pixels on the sidebar's row and by six on the window bar's, where
 * the column is already inset. Slack after the last button is room; overlap
 * would be a bug, which is why this is not the exact remainder.
 *
 * `self-stretch` because the row centres its children and this one has none: an
 * empty box in an `items-center` row is 0px tall, which is invisible until you
 * try to press it. It is inside a drag region, and a band you cannot hit is a
 * window you cannot move.
 */
export const WINDOW_CONTROLS_ROOM = "w-[68px] shrink-0 self-stretch";

/**
 * What makes a row a title bar: press the band, move the window; press it
 * twice, zoom it.
 *
 * `"deep"` rather than a bare attribute, so the whole row drags rather than only
 * the exact element carrying it. Tauri's own script walks up from whatever was
 * pressed and stops at the first clickable thing — a button, a link, anything
 * with a `tabindex` or an interactive `role` — so a tab, the search control and
 * the sidebar trigger keep their clicks without opting out of anything. What is
 * left is the empty band, which is exactly what a title bar is.
 *
 * Every row that sits under the window's top edge needs this. Removing the
 * system title bar took the drag and double-click with it, and getting them back
 * is not optional: they are how a window is moved and zoomed.
 */
export const WINDOW_DRAG_REGION = "deep";

/**
 * What the window controls take out of the row they overlay, and give back in
 * fullscreen where macOS takes them away.
 *
 * Rendered by whichever row is under the window's top-left corner: a sidebar
 * header, or the window bar when the sidebar is not in the layout
 * (`ShowSidebarButton`). Below the drawer breakpoint both draw it, because the
 * drawer is an overlay *above* the bar — and whichever one the user is looking
 * at is the one the buttons are sitting on.
 *
 * Nothing, wherever the title bar is not an overlay: in fullscreen, and on any
 * platform that draws its controls above the WebView rather than inside it. The
 * row is then just empty at its leading end — the mark and the word "Janela"
 * are not coming back as a fallback, because a window whose own title bar says
 * the app's name does not need the sidebar to say it again.
 */
export function WindowControlsRoom(): ReactElement | null {
  const { windowControls } = useClientEnvironment();
  const areVisible = useStoreValue(windowControls, () => windowControls.areVisible);
  if (!areVisible) return null;
  return <div className={WINDOW_CONTROLS_ROOM} />;
}

/**
 * The first row of a sidebar header: the one the window controls land on.
 *
 * One component for both sidebars, because it is one row in one window with a
 * different word in it — and because everything it carries is a fact about the
 * window rather than about projects or settings: the room for the buttons, the
 * band that drags, and one step of the ladder so the buttons' centre line
 * (`TRAFFIC_LIGHT_POSITION`) is the row's.
 *
 * `mt-2` in the drawer, and this is the one place that has to know it: the
 * desktop panel is inset 8px from the window's top by the `inset` variant's
 * `py-2`, the drawer's sheet is inset by nothing, and macOS draws the buttons
 * at the same point either way. Without it the row is 8px above them.
 */
export function SidebarTitleRow(props: { readonly children?: ReactNode }): ReactElement {
  const size = useSize();
  const { isMobile } = useSidebar();
  return (
    <div
      className={cn(size.control, "flex items-center gap-0.5", isMobile && "mt-2")}
      data-tauri-drag-region={WINDOW_DRAG_REGION}
    >
      <WindowControlsRoom />
      {props.children}
    </div>
  );
}

/**
 * The strip above the content card.
 *
 * It sits on the window's own surface — the same colour the sidebar is painted
 * in, outside the card — because what it holds are *handles on* the card below,
 * not things inside it. On the card, tabs read as chrome the terminals grew; off
 * it, the card is one object the tabs point at, which is also what makes a tab
 * plausible to drag somewhere else later.
 *
 * No height of its own: a control's worth of band, with 4px around it — the
 * inset the card uses on either side of a pane. A number here would be a third
 * place to re-tier; the ladder decides how tall a control is.
 *
 * The top is 8px rather than 4, and that is the one asymmetry: it puts this
 * row's centre line on the sidebar header's. Both columns start 8px inside the
 * window — the panel's `py-2` and the inset column's `m-2` — and the header
 * then spends `p-2` where this bar spent `p-1`, which left the tab strip 4px
 * above the row across the gap from it. Invisible until the window controls
 * moved into that row: they are drawn at a fixed point by macOS, so a tab or a
 * sidebar trigger 4px above them reads as broken rather than as tight.
 *
 * A component rather than the class string it used to be, because the bar is
 * also a title bar now (`WINDOW_DRAG_REGION`) and a second row that forgot to
 * say so is a band that looks draggable and is not.
 */
export function WindowBar(props: { readonly children?: ReactNode }): ReactElement {
  return (
    <div className={WINDOW_BAR} data-tauri-drag-region={WINDOW_DRAG_REGION}>
      {props.children}
    </div>
  );
}

const WINDOW_BAR = "flex shrink-0 items-center gap-1 px-1 pt-2 pb-1";

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
 * Whether the sidebar is out of the layout, and the window bar is therefore the
 * row under the window's top-left corner.
 *
 * Two ways for that to happen, and the second is easy to miss. `state` is
 * `"collapsed"` when the user collapsed it — but below the primitive's drawer
 * breakpoint the panel is an overlay whatever `state` says, so a window narrow
 * enough reports `"expanded"` while the sidebar is off screen. Reading only
 * `state` there left the bar with no room and no trigger: the traffic lights
 * landed on the tabs, and there was no way to open the sidebar at all.
 */
function useIsSidebarOutOfLayout(): boolean {
  const { state, isMobile } = useSidebar();
  return state === "collapsed" || isMobile;
}

/**
 * The head of the window bar while the sidebar is not in the layout: the room
 * the window controls need, and the control that brings the sidebar back.
 *
 * Collapsing is offcanvas — the list is names, and a column of initials would be
 * useless — so the button that brings it back cannot live in the sidebar. It
 * sits at the head of the window bar instead, where the space it takes is space
 * the tabs were not using. Below the drawer breakpoint the same button opens the
 * sidebar as a drawer, because that is what the primitive renders there and
 * `toggleSidebar` already knows it.
 *
 * The traffic lights come with it, and for the same reason: with the sidebar
 * gone this bar is what sits under the window's top-left corner, so it is the
 * row that has to make room. Both bars — the tab strip and `ShowSidebarBar` —
 * lead with this one component, which is why neither of them has to know that
 * the title bar is an overlay.
 *
 * The primitive's trigger brings its own tooltip, which names the action for the
 * state it is in ("Expand sidebar" here) and carries the ⌘B chip. Wrapping it in
 * a second tooltip would have stacked two popups on one control.
 */
export function ShowSidebarButton(): ReactElement | null {
  const isOutOfLayout = useIsSidebarOutOfLayout();
  if (!isOutOfLayout) return null;
  return (
    <>
      <WindowControlsRoom />
      <SidebarTrigger className="mr-1" />
    </>
  );
}

/**
 * The window bar on screens that have nothing else to put in it.
 *
 * Nothing, while the sidebar is in the layout: a band above the card holding one
 * absent button is a band of nothing. It appears with the button, because that
 * button is the only way back from a sidebar that is off screen — and on a
 * narrow window it is also the only thing keeping the window controls off
 * whatever the card put in its top-left corner.
 *
 * The row inside it is a control tall even though the trigger is smaller, so the
 * bar is the same height here as it is over a tab strip. Otherwise the card
 * would jump 4px between the welcome screen and a session.
 */
export function ShowSidebarBar(): ReactElement | null {
  const size = useSize();
  const isOutOfLayout = useIsSidebarOutOfLayout();
  if (!isOutOfLayout) return null;
  return (
    <WindowBar>
      <div className={cn(size.control, "flex items-center")}>
        <ShowSidebarButton />
      </div>
    </WindowBar>
  );
}
