import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { DaemonConnection } from "@janela/client";
import {
  type Axis,
  type GridSize,
  type TerminalDescriptor,
  type TerminalID,
  type TerminalState,
} from "@janela/core";
import { Badge, Button, useSize, cn } from "@janela/design";
import { TerminalSurface, type TerminalSurfaceHandle } from "@janela/terminal-ui";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import { useClientEnvironment } from "../../../shared/model/index.ts";
import { ContextMenuRegion, type MenuRow } from "../../../shared/ui/index.ts";
import { terminalMenuRows } from "../model/menu-rows.ts";
import { isFailureState, terminalStateText } from "../model/tab-rows.ts";
import { attachPane, shouldStartOnAttach } from "../model/terminal-attach.ts";

const NO_MENU_ROWS: readonly MenuRow[] = [];

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
  } = props;

  const environment = useClientEnvironment();
  const view = environment.view;
  const store = environment.sessions;

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

  const title = descriptor?.title ?? "Terminal";
  const stateText = terminalStateText(state);
  const size = useSize();

  return (
    <div
      data-slot="terminal-pane"
      onFocusCapture={handleFocusCapture}
      className="bg-terminal-background shadow-surface-2 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 flex h-full w-full flex-col overflow-hidden rounded-lg transition-none motion-safe:duration-(--spring-slow)"
    >
      <div
        className={cn(
          size.control,
          "flex shrink-0 items-center gap-1.5 border-b border-[oklch(0_0_0/0.08)] pr-0.5 pl-2 dark:border-[oklch(1_0_0/0.08)]",
        )}
      >
        <span className="text-foreground/70 min-w-0 flex-1 truncate text-xs font-medium">
          {title}
        </span>
        {state?.kind === "running" ? null : (
          <Badge variant={isFailureState(state) ? "destructive" : "secondary"}>{stateText}</Badge>
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
          onInput={handleInput}
          onViewportChange={handleViewportChange}
        />
      </ContextMenuRegion>
    </div>
  );
}

function swallowRequestFailure(): undefined {
  return undefined;
}
