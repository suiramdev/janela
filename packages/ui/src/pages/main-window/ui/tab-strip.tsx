import {
  Cancel01Icon,
  LayoutTwoColumnIcon,
  LayoutTwoRowIcon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type Axis, type SessionLayout, type TerminalDescriptor } from "@janela/core";
import {
  Button,
  Kbd,
  Separator,
  Tabs,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from "@janela/design";
import {
  useCallback,
  useMemo,
  useState,
  type ComponentProps,
  type DragEvent,
  type ReactElement,
} from "react";

import type { TabCloseScope } from "../../../shared/model/index.ts";
import { ContextMenuRegion, ShowSidebarButton, WindowBar } from "../../../shared/ui/index.ts";
import { tabMenuRows } from "../model/menu-rows.ts";
import { tabLabel } from "../model/tab-rows.ts";

interface TabDrag {
  readonly from: number;
  readonly to: number | undefined;
}

type TabChangeHandler = NonNullable<ComponentProps<typeof Tabs>["onValueChange"]>;

const TAB_DRAG_TYPE = "application/x-janela-tab";

const NEW_TERMINAL_BUTTON = (
  <Button variant="ghost" size="icon-sm" aria-label="New Terminal">
    <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
  </Button>
);

const SPLIT_VERTICALLY_BUTTON = (
  <Button variant="ghost" size="icon-sm" aria-label="Split Vertically">
    <HugeiconsIcon icon={LayoutTwoColumnIcon} strokeWidth={2} />
  </Button>
);

const SPLIT_HORIZONTALLY_BUTTON = (
  <Button variant="ghost" size="icon-sm" aria-label="Split Horizontally">
    <HugeiconsIcon icon={LayoutTwoRowIcon} strokeWidth={2} />
  </Button>
);

export function TabStrip(props: {
  readonly layout: SessionLayout;
  readonly terminals: readonly TerminalDescriptor[];
  readonly onFocusTab: (index: number) => void;
  readonly onNewTerminal: () => void;
  readonly onSplitTab: (index: number, axis: Axis) => void;
  readonly onMoveTab: (from: number, to: number) => void;
  readonly onCloseTabs: (index: number, scope: TabCloseScope) => void;
}): ReactElement {
  const { layout, terminals, onFocusTab, onNewTerminal, onSplitTab, onMoveTab, onCloseTabs } =
    props;

  const handleValueChange = useCallback<TabChangeHandler>(
    (value) => {
      const chosen = String(value);
      const index = layout.tabs.findIndex((_tab, at) => String(at) === chosen);

      if (index !== -1) onFocusTab(index);
    },
    [layout.tabs, onFocusTab],
  );

  const [drag, setDrag] = useState<TabDrag | undefined>(undefined);

  const endDrag = useCallback(() => {
    setDrag(undefined);
  }, []);

  const focusedTabIndex = layout.focusedTabIndex;

  const splitVertically = useCallback(() => {
    onSplitTab(focusedTabIndex, "horizontal");
  }, [onSplitTab, focusedTabIndex]);

  const splitHorizontally = useCallback(() => {
    onSplitTab(focusedTabIndex, "vertical");
  }, [onSplitTab, focusedTabIndex]);

  return (
    <WindowBar>
      <ShowSidebarButton />
      <Tabs
        value={String(focusedTabIndex)}
        onValueChange={handleValueChange}
        className="min-w-0 flex-1 gap-0"
      >
        <TabsList
          aria-label="Terminals"
          className="scroll-fade-x scrollbar-hide max-w-full justify-start gap-0.5 overflow-x-auto overflow-y-hidden [--scroll-fade-size:20px]"
        >
          {layout.tabs.map((tab, index) => (
            <TabItem
              key={tab.focusedTerminalID}
              index={index}
              tabCount={layout.tabs.length}
              label={tabLabel(tab, terminals)}
              drag={drag}
              onDrag={setDrag}
              onDrop={onMoveTab}
              onDragEnd={endDrag}
              onClose={onCloseTabs}
              onNewTerminal={onNewTerminal}
              onSplit={onSplitTab}
            />
          ))}
        </TabsList>
      </Tabs>
      <div className="flex shrink-0 items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger render={SPLIT_VERTICALLY_BUTTON} onClick={splitVertically} />
          <TooltipContent>
            Split Vertically <Kbd>⌘D</Kbd>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={SPLIT_HORIZONTALLY_BUTTON} onClick={splitHorizontally} />
          <TooltipContent>
            Split Horizontally <Kbd>⇧⌘D</Kbd>
          </TooltipContent>
        </Tooltip>
        <Separator orientation="vertical" className="mx-0.5 h-4" />
        <Tooltip>
          <TooltipTrigger render={NEW_TERMINAL_BUTTON} onClick={onNewTerminal} />
          <TooltipContent>
            New Terminal <Kbd>⌘T</Kbd>
          </TooltipContent>
        </Tooltip>
      </div>
    </WindowBar>
  );
}

export function dropSlot(
  from: number,
  over: number,
  pointerX: number,
  bounds: { readonly left: number; readonly width: number },
): number {
  const after = pointerX - bounds.left > bounds.width / 2;
  const slot = after ? over + 1 : over;

  return slot > from ? slot - 1 : slot;
}

function TabItem(props: {
  readonly index: number;
  readonly tabCount: number;
  readonly label: string;
  readonly drag: TabDrag | undefined;
  readonly onDrag: (drag: TabDrag | undefined) => void;
  readonly onDrop: (from: number, to: number) => void;
  readonly onDragEnd: () => void;
  readonly onClose: (index: number, scope: TabCloseScope) => void;
  readonly onNewTerminal: () => void;
  readonly onSplit: (index: number, axis: Axis) => void;
}): ReactElement {
  const {
    index,
    tabCount,
    label,
    drag,
    onDrag,
    onDrop,
    onDragEnd,
    onClose,
    onNewTerminal,
    onSplit,
  } = props;

  const close = useCallback(
    (scope: TabCloseScope) => {
      onClose(index, scope);
    },
    [index, onClose],
  );

  const handleClose = useCallback(() => {
    close("this");
  }, [close]);

  const splitRight = useCallback(() => {
    onSplit(index, "horizontal");
  }, [index, onSplit]);

  const splitDown = useCallback(() => {
    onSplit(index, "vertical");
  }, [index, onSplit]);

  const menuRows = useMemo(
    () =>
      tabMenuRows({ newTerminal: onNewTerminal, splitRight, splitDown, close, index, tabCount }),
    [close, index, onNewTerminal, splitDown, splitRight, tabCount],
  );

  const handleDragStart = useCallback(
    (event: DragEvent<HTMLElement>) => {
      event.dataTransfer.setData(TAB_DRAG_TYPE, String(index));
      event.dataTransfer.effectAllowed = "move";
      onDrag({ from: index, to: undefined });
    },
    [index, onDrag],
  );

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (drag === undefined) return;

      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const bounds = event.currentTarget.getBoundingClientRect();
      const to = dropSlot(drag.from, index, event.clientX, bounds);

      if (to !== drag.to) onDrag({ from: drag.from, to });
    },
    [drag, index, onDrag],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (drag === undefined) return;

      event.preventDefault();

      const to = dropSlot(
        drag.from,
        index,
        event.clientX,
        event.currentTarget.getBoundingClientRect(),
      );

      onDragEnd();

      if (to !== drag.from) onDrop(drag.from, to);
    },
    [drag, index, onDrop, onDragEnd],
  );

  const indicator = drag === undefined || drag.to === undefined ? undefined : dropEdge(drag, index);

  return (
    <ContextMenuRegion
      label={`Tab: ${label}`}
      rows={menuRows}
      className={cn(
        "relative flex h-full min-w-0 shrink-0 items-center",
        indicator === "before" && "shadow-[inset_2px_0_0_0_var(--color-foreground)]",
        indicator === "after" && "shadow-[inset_-2px_0_0_0_var(--color-foreground)]",
        drag?.from === index && "opacity-50",
      )}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <TabsTrigger
        value={String(index)}
        draggable
        onDragStart={handleDragStart}
        onDragEnd={onDragEnd}
        className="max-w-48 min-w-0 flex-none pr-7 pl-2"
      >
        <span className="truncate">{label}</span>
      </TabsTrigger>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Close tab: ${label}`}
        onClick={handleClose}
        className="absolute right-0.5 size-5 opacity-65 hover:opacity-100 focus-visible:opacity-100 [&_svg:not([class*='size-'])]:size-3"
      >
        <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
      </Button>
    </ContextMenuRegion>
  );
}

export function dropEdge(drag: TabDrag, index: number): "before" | "after" | undefined {
  if (drag.to === undefined || drag.to === drag.from) return undefined;

  const slot = drag.to >= drag.from ? drag.to + 1 : drag.to;

  if (slot === index) return "before";

  if (slot === index + 1) return "after";

  return undefined;
}
