/**
 * The surface, as a React component.
 *
 * ## Why there is no output in state
 *
 * Bytes arrive through the imperative handle and go straight into the renderer.
 * A component that put terminal output in state would re-render React sixty times
 * a second and turn the cheapest path in the client into the most expensive one —
 * `docs/performance.md` § Throughput. The only React state here is *no state at
 * all*: the component renders one empty `<div>` and never re-renders because of
 * anything the terminal did.
 *
 * ## Accessibility, recorded rather than claimed
 *
 * The container is a labelled group; xterm builds its own focusable textarea
 * inside it. With `screenReaderMode` off (the default) a screen reader gets the
 * label and the echo of typing but **not the output content**; with it on, xterm
 * announces new lines through off-screen live regions, at a measurable cost on the
 * hot path. There is no cell-level navigation either way. See the header of
 * `xterm-rendering.ts`; the prop is the seam #38's settings will drive.
 */

import type { GridSize } from "@janela/core";
import { useEffect, useImperativeHandle, useRef, type ReactElement, type Ref } from "react";

import { animationFrameScheduler } from "./coalesce.ts";
import { createSurfaceController, type SurfaceController } from "./surface-controller.ts";
import { xtermRendering, type XtermRendering } from "./xterm-rendering.ts";

export interface TerminalSurfaceHandle {
  /**
   * Copies before queueing, so this is safe to call with the transient view
   * `DaemonConnection.onOutput` hands up.
   */
  feed(bytes: Uint8Array): void;

  /** Clears this client's view. The daemon's scrollback is untouched. */
  clearViewport(): void;

  selectedText(): string | undefined;

  focus(): void;

  /** The measured grid, or undefined before the first measurement lands. */
  viewport(): GridSize | undefined;
}

export interface TerminalSurfaceProps {
  readonly ref?: Ref<TerminalSurfaceHandle>;

  /** Keyboard and paste bytes. Forward them; do not interpret them. */
  readonly onInput?: (bytes: Uint8Array) => void;

  /** Already coalesced to at most one per frame. The parent votes with it. */
  readonly onViewportChange?: (size: GridSize) => void;

  readonly focused?: boolean;

  /** Accessible name, e.g. `Terminal: zsh — running`. */
  readonly label: string;

  /** Turns on xterm's live-region announcements. Off by default. */
  readonly screenReaderMode?: boolean;
}

export function TerminalSurface({
  ref,
  onInput,
  onViewportChange,
  focused,
  label,
  screenReaderMode: screenReaderModeProp,
}: TerminalSurfaceProps): ReactElement {
  const screenReaderMode = screenReaderModeProp === true;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const renderingRef = useRef<XtermRendering | undefined>(undefined);
  const controllerRef = useRef<SurfaceController | undefined>(undefined);
  const viewportRef = useRef<GridSize | undefined>(undefined);

  // The handlers are read through refs so that a parent re-rendering with fresh
  // closures does not tear down a terminal and lose its scrollback.
  const onInputRef = useRef(onInput);
  const onViewportChangeRef = useRef(onViewportChange);
  useEffect(() => {
    onInputRef.current = onInput;
    onViewportChangeRef.current = onViewportChange;
  }, [onInput, onViewportChange]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const reducedMotion =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const rendering = xtermRendering({ container, screenReaderMode, reducedMotion });
    const controller = createSurfaceController(
      rendering,
      {
        onInput: (bytes) => onInputRef.current?.(bytes),
        onViewportChange: (size) => {
          viewportRef.current = size;
          onViewportChangeRef.current?.(size);
        },
      },
      animationFrameScheduler(),
    );
    renderingRef.current = rendering;
    controllerRef.current = controller;

    // Create/dispose in pairs, which is also what makes StrictMode's double mount
    // a non-event rather than a leaked emulator.
    return () => {
      controller.dispose();
      rendering.dispose();
      renderingRef.current = undefined;
      controllerRef.current = undefined;
      viewportRef.current = undefined;
    };
  }, [screenReaderMode]);

  useEffect(() => {
    if (focused === true) renderingRef.current?.focus();
  }, [focused]);

  useImperativeHandle(
    ref,
    () => ({
      feed: (bytes: Uint8Array) => {
        controllerRef.current?.feed(bytes);
      },
      clearViewport: () => {
        renderingRef.current?.clearViewport();
      },
      selectedText: () => renderingRef.current?.selectedText(),
      focus: () => {
        renderingRef.current?.focus();
      },
      viewport: () => viewportRef.current,
    }),
    [],
  );

  return (
    // A labelled region rather than a bare div: xterm builds its own focusable
    // textarea inside, and this is the name a screen reader reads before it.
    <section
      ref={containerRef}
      aria-label={label}
      className="bg-terminal-background h-full w-full overflow-hidden"
    />
  );
}
