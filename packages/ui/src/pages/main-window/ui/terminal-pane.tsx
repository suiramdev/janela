import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { DaemonConnection } from "@janela/client";
import {
  type Axis,
  type DockEdge,
  type GridSize,
  type PaneDestination,
  type TerminalDescriptor,
  type TerminalID,
  type TerminalState,
} from "@janela/core";
import { Badge, Button, useSize, cn } from "@janela/design";
import { TerminalSurface, type TerminalSurfaceHandle } from "@janela/terminal-ui";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactElement,
} from "react";

import { useClientEnvironment, useStoreValue } from "../../../shared/model/index.ts";
import { ContextMenuRegion, type MenuRow } from "../../../shared/ui/index.ts";
import { terminalMenuRows } from "../model/menu-rows.ts";
import { TERMINAL_DRAG_TYPE, dockEdge } from "../model/pane-drag.ts";
import { isFailureState, terminalBadgeText, terminalStateText } from "../model/tab-rows.ts";
import { attachPane, shouldStartOnAttach } from "../model/terminal-attach.ts";

const NO_MENU_ROWS: readonly MenuRow[] = [];

const EDGE_CLASSES = {
  left: "inset-y-0 left-0 w-1/2",
  right: "inset-y-0 right-0 w-1/2",
  top: "inset-x-0 top-0 h-1/2",
  bottom: "inset-x-0 bottom-0 h-1/2",
} satisfies Record<DockEdge, string>;

export function TerminalPane(props: {
  readonly terminalID: TerminalID;
  readonly descriptor: TerminalDescriptor | undefined;
  readonly state: TerminalState | undefined;
  readonly isFocused: boolean;
  readonly connection: DaemonConnection;
  readonly isConnected: boolean;
  readonly onFocusTerminal: (id: TerminalID) => void;
  readonly onClose: (id: TerminalID) => void;
  readonly onSplit: (id: TerminalID, axis: Axis) => void;
  readonly onNewTerminal: () => void;
  readonly draggedTerminalID: TerminalID | undefined;
  readonly onDragTerminal: (id: TerminalID | undefined) => void;
  readonly onDropTerminal: (destination: PaneDestination) => void;
}): ReactElement {
  const {
    terminalID,
    descriptor,
    state,
    isFocused,
    connection,
    isConnected,
    onFocusTerminal,
    onClose,
    onSplit,
    onNewTerminal,
    draggedTerminalID,
    onDragTerminal,
    onDropTerminal,
  } = props;

  const environment = useClientEnvironment();
  const view = environment.view;
  const store = environment.sessions;

  const settings = useStoreValue(view, () => view.settings);
  const font = useMemo(
    () => ({ family: settings.terminalFontFamily, size: settings.terminalFontSize }),
    [settings.terminalFontFamily, settings.terminalFontSize],
  );

  const handleRef = useRef<TerminalSurfaceHandle | null>(null);
  const isAttachedRef = useRef(false);
  const [attachViewport, setAttachViewport] = useState<GridSize | undefined>(undefined);

  const registerSurface = useCallback(
    (handle: TerminalSurfaceHandle | null) => {
      handleRef.current = handle;

      if (handle === null) return undefined;

      return view.registerSurface(terminalID, handle);
    },
    [view, terminalID],
  );

  const feed = useCallback((bytes: Uint8Array) => {
    handleRef.current?.feed(bytes);
  }, []);

  const handleViewportChange = useCallback(
    (size: GridSize) => {
      if (!isAttachedRef.current) {
        setAttachViewport(size);

        return;
      }

      connection.request({ type: "resize", terminalID, size }).catch(swallowRequestFailure);
    },
    [connection, terminalID],
  );

  useEffect(() => {
    if (!isConnected || attachViewport === undefined) return;

    isAttachedRef.current = true;

    const owner = store.sessions.find((session) =>
      session.terminals.some((terminal) => terminal.id === terminalID),
    );

    const current = owner?.terminals.find((terminal) => terminal.id === terminalID);

    const started = shouldStartOnAttach(current, store.terminalStates[terminalID])
      ? connection.request({ type: "startTerminal", terminalID }).catch(swallowRequestFailure)
      : Promise.resolve(undefined);

    let release: (() => void) | undefined;
    let unmounted = false;
    void started.then(() => {
      if (unmounted) return undefined;

      release = attachPane(connection, terminalID, feed, attachViewport);

      return undefined;
    });

    return () => {
      unmounted = true;
      isAttachedRef.current = false;
      release?.();
    };
  }, [isConnected, connection, terminalID, feed, attachViewport, store]);

  const handleInput = useCallback(
    (bytes: Uint8Array) => {
      connection.sendInput(bytes, terminalID);
    },
    [connection, terminalID],
  );

  const handleFocusCapture = useCallback(() => {
    onFocusTerminal(terminalID);
  }, [onFocusTerminal, terminalID]);

  const handleClose = useCallback(() => {
    onClose(terminalID);
  }, [onClose, terminalID]);

  const [menuRows, setMenuRows] = useState<readonly MenuRow[]>(NO_MENU_ROWS);
  const clipboard = environment.clipboard;

  const buildMenu = useCallback(() => {
    setMenuRows(
      terminalMenuRows({
        hasSelection: handleRef.current?.selectedText() !== undefined,
        copy: () => {
          const selection = handleRef.current?.selectedText();

          if (selection !== undefined) void clipboard.copy(selection);
        },
        paste: () => {
          void clipboard.paste().then((text) => {
            if (text !== undefined) handleRef.current?.paste(text);

            return undefined;
          });
        },
        clear: () => handleRef.current?.clearViewport(),
        splitRight: () => onSplit(terminalID, "horizontal"),
        splitDown: () => onSplit(terminalID, "vertical"),
        newTerminal: onNewTerminal,
        close: handleClose,
      }),
    );
  }, [clipboard, handleClose, onNewTerminal, onSplit, terminalID]);

  const isDragSource = draggedTerminalID === terminalID;
  const acceptsDrop = draggedTerminalID !== undefined && !isDragSource;
  const [edge, setEdge] = useState<DockEdge | undefined>(undefined);

  const handleDragStart = useCallback(
    (event: DragEvent<HTMLElement>) => {
      event.dataTransfer.setData(TERMINAL_DRAG_TYPE, terminalID);
      event.dataTransfer.effectAllowed = "move";
      onDragTerminal(terminalID);
    },
    [onDragTerminal, terminalID],
  );

  const handleDragEnd = useCallback(() => {
    onDragTerminal(undefined);
  }, [onDragTerminal]);

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!acceptsDrop) return;

      event.preventDefault();
      event.dataTransfer.dropEffect = "move";

      const next = dockEdge(
        { x: event.clientX, y: event.clientY },
        event.currentTarget.getBoundingClientRect(),
      );

      if (next !== edge) setEdge(next);
    },
    [acceptsDrop, edge],
  );

  const handleDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return;
    }

    setEdge(undefined);
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!acceptsDrop) return;

      event.preventDefault();

      const at = dockEdge(
        { x: event.clientX, y: event.clientY },
        event.currentTarget.getBoundingClientRect(),
      );

      setEdge(undefined);
      onDropTerminal({ kind: "beside", terminal: terminalID, edge: at });
    },
    [acceptsDrop, onDropTerminal, terminalID],
  );

  const title = descriptor?.title ?? "Terminal";
  const stateText = terminalStateText(state);
  const badgeText = terminalBadgeText(state);
  const size = useSize();

  return (
    <div
      data-slot="terminal-pane"
      {...(edge === undefined ? {} : { "data-drop-edge": edge })}
      onFocusCapture={handleFocusCapture}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        "bg-terminal-background shadow-surface-2 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 relative flex h-full w-full flex-col overflow-hidden rounded-lg transition-none motion-safe:duration-(--spring-slow)",
        isDragSource && "opacity-50",
      )}
    >
      <div
        draggable
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        className={cn(
          size.control,
          "flex shrink-0 cursor-grab items-center gap-1.5 border-b border-[oklch(0_0_0/0.08)] pr-0.5 pl-2 active:cursor-grabbing dark:border-[oklch(1_0_0/0.08)]",
        )}
      >
        <span className="text-foreground/70 min-w-0 flex-1 truncate text-xs font-medium">
          {title}
        </span>
        {badgeText === undefined ? null : (
          <Badge variant={isFailureState(state) ? "destructive" : "secondary"}>{badgeText}</Badge>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Close terminal: ${title}`}
          onClick={handleClose}
          className="size-5 shrink-0 opacity-65 hover:opacity-100 focus-visible:opacity-100 [&_svg:not([class*='size-'])]:size-3"
        >
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
        </Button>
      </div>
      <ContextMenuRegion
        label={`Terminal: ${title}`}
        rows={menuRows}
        onOpen={buildMenu}
        className="relative min-h-0 flex-1"
      >
        <TerminalSurface
          ref={registerSurface}
          label={`Terminal: ${title} — ${stateText}`}
          focused={isFocused}
          font={font}
          onInput={handleInput}
          onViewportChange={handleViewportChange}
        />
      </ContextMenuRegion>
      {edge === undefined ? null : (
        <div
          aria-hidden
          className={cn(
            "bg-ring/15 ring-ring pointer-events-none absolute z-10 rounded-lg ring-2 ring-inset",
            EDGE_CLASSES[edge],
          )}
        />
      )}
    </div>
  );
}

function swallowRequestFailure(): undefined {
  return undefined;
}
