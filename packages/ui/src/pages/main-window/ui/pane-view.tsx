import type { DaemonConnection } from "@janela/client";
import {
  FRACTION_RANGE,
  type Axis,
  type Pane,
  type PaneDestination,
  type TerminalDescriptor,
  type TerminalID,
  type TerminalState,
} from "@janela/core";
import { cn } from "@janela/design";
import { animationFrameScheduler, coalescePerFrame } from "@janela/terminal-ui";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type PointerEvent,
  type ReactElement,
} from "react";

import type { PanePath } from "../../../shared/model/index.ts";
import { TerminalPane } from "./terminal-pane.tsx";

interface PaneViewProps {
  readonly pane: Pane;
  readonly path: PanePath;
  readonly focusedTerminalID: TerminalID;
  readonly terminals: readonly TerminalDescriptor[];
  readonly states: Readonly<Record<TerminalID, TerminalState>>;
  readonly connection: DaemonConnection;
  readonly isConnected: boolean;
  readonly onFocusTerminal: (id: TerminalID) => void;
  readonly onFraction: (path: PanePath, fraction: number) => void;
  readonly onClosePane: (id: TerminalID) => void;
  readonly onSplitPane: (id: TerminalID, axis: Axis) => void;
  readonly onNewTerminal: () => void;
  readonly draggedTerminalID: TerminalID | undefined;
  readonly onDragTerminal: (id: TerminalID | undefined) => void;
  readonly onDropTerminal: (destination: PaneDestination) => void;
}

const DIVIDER_STEP = 2;

const DIVIDER_MINIMUM = Math.round(FRACTION_RANGE.minimum * 100);

const DIVIDER_MAXIMUM = Math.round(FRACTION_RANGE.maximum * 100);

export function PaneView(props: PaneViewProps): ReactElement {
  const { pane, path } = props;

  const [isResizing, setResizing] = useState(false);

  const firstPath = useMemo<PanePath>(() => [...path, "first"], [path]);
  const secondPath = useMemo<PanePath>(() => [...path, "second"], [path]);

  const firstStyle = useMemo(
    () => (pane.kind === "split" ? { flexBasis: `${pane.fraction * 100}%` } : undefined),
    [pane],
  );

  if (pane.kind === "terminal") {
    return (
      <TerminalPane
        key={pane.id}
        terminalID={pane.id}
        descriptor={props.terminals.find((terminal) => terminal.id === pane.id)}
        state={props.states[pane.id]}
        isFocused={props.focusedTerminalID === pane.id}
        connection={props.connection}
        isConnected={props.isConnected}
        onFocusTerminal={props.onFocusTerminal}
        onClose={props.onClosePane}
        onSplit={props.onSplitPane}
        onNewTerminal={props.onNewTerminal}
        draggedTerminalID={props.draggedTerminalID}
        onDragTerminal={props.onDragTerminal}
        onDropTerminal={props.onDropTerminal}
      />
    );
  }

  const isRow = pane.axis === "horizontal";

  return (
    <div className={`flex h-full w-full ${isRow ? "flex-row" : "flex-col"}`}>
      <div
        style={firstStyle}
        className={cn(
          "min-h-0 min-w-0 shrink-0 grow-0",
          !isResizing &&
            "motion-safe:transition-[flex-basis] motion-safe:duration-(--spring-moderate) ease-out",
        )}
      >
        <PaneView {...props} pane={pane.first} path={firstPath} />
      </div>
      <Divider
        axis={pane.axis}
        fraction={pane.fraction}
        path={path}
        onFraction={props.onFraction}
        onResizingChange={setResizing}
      />
      <div className="min-h-0 min-w-0 flex-1">
        <PaneView {...props} pane={pane.second} path={secondPath} />
      </div>
    </div>
  );
}

function Divider(props: {
  readonly axis: Axis;
  readonly fraction: number;
  readonly path: PanePath;
  readonly onFraction: (path: PanePath, fraction: number) => void;
  readonly onResizingChange: (isResizing: boolean) => void;
}): ReactElement {
  const { axis, fraction, path, onFraction, onResizingChange } = props;

  const flush = useMemo(
    () =>
      coalescePerFrame<number>((value) => {
        onFraction(path, value);
      }, animationFrameScheduler()),
    [onFraction, path],
  );

  useEffect(
    () => () => {
      flush.cancel();
    },
    [flush],
  );

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onFraction(path, event.currentTarget.valueAsNumber / 100);
    },
    [onFraction, path],
  );

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLInputElement>) => {
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      onResizingChange(true);
    },
    [onResizingChange],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLInputElement>) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;

      const box = event.currentTarget.parentElement?.getBoundingClientRect();

      if (box === undefined) return;

      const along =
        axis === "horizontal"
          ? (event.clientX - box.left) / box.width
          : (event.clientY - box.top) / box.height;

      flush.push(along);
    },
    [axis, flush],
  );

  const handlePointerUp = useCallback(
    (event: PointerEvent<HTMLInputElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      onResizingChange(false);
    },
    [onResizingChange],
  );

  return (
    <input
      type="range"
      aria-label="Resize panes"
      aria-orientation={axis === "horizontal" ? "vertical" : "horizontal"}
      min={DIVIDER_MINIMUM}
      max={DIVIDER_MAXIMUM}
      step={DIVIDER_STEP}
      value={Math.round(fraction * 100)}
      onChange={handleChange}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onLostPointerCapture={handlePointerUp}
      className={`hover:bg-ring/50 focus-visible:bg-ring active:bg-ring/60 m-0 shrink-0 appearance-none bg-transparent bg-clip-content transition-colors duration-(--spring-fast) [&::-moz-range-thumb]:hidden [&::-webkit-slider-thumb]:hidden ${
        axis === "horizontal"
          ? "h-full w-1.5 cursor-col-resize px-[2px]"
          : "h-1.5 w-full cursor-row-resize py-[2px]"
      }`}
    />
  );
}
