import { cn, Elevated, SidebarInset, SidebarTrigger, useSidebar, useSize } from "@janela/design";
import type { ReactElement, ReactNode } from "react";

import { useClientEnvironment, useStoreValue } from "../model/index.ts";

export const TRAFFIC_LIGHT_POSITION = { x: 12, y: 32 } as const;

export const WINDOW_CONTROLS_ROOM = "w-[68px] shrink-0 self-stretch";

export const WINDOW_DRAG_REGION = "deep";

const WINDOW_BAR = "flex shrink-0 items-center gap-1 px-1 pt-2 pb-1";

export const PANE_REGION = "relative min-h-0 flex-1 overflow-hidden p-1";

export const WINDOW_COLUMN = "min-w-0 gap-1.5 overflow-hidden bg-transparent";

export const SIDEBAR_SCROLLER = "[&_[data-slot='scroll-area-scrollbar']]:-translate-x-2";

export const PANE_COLUMN = "mx-auto max-w-2xl p-6";

export function WindowControlsRoom(): ReactElement | null {
  const { windowControls } = useClientEnvironment();
  const areVisible = useStoreValue(windowControls, () => windowControls.areVisible);

  if (!areVisible) return null;

  return <div className={WINDOW_CONTROLS_ROOM} />;
}

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

export function WindowBar(props: { readonly children?: ReactNode }): ReactElement {
  return (
    <div className={WINDOW_BAR} data-tauri-drag-region={WINDOW_DRAG_REGION}>
      {props.children}
    </div>
  );
}

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

export function WindowColumn(props: { readonly children?: ReactNode }): ReactElement {
  return (
    <SidebarInset className={WINDOW_COLUMN} surface={false}>
      {props.children}
    </SidebarInset>
  );
}

function useIsSidebarOutOfLayout(): boolean {
  const { state, isMobile } = useSidebar();

  return state === "collapsed" || isMobile;
}

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
