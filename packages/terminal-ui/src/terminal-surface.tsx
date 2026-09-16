import type { GridSize } from "@janela/core";
import { useEffect, useImperativeHandle, useRef, type ReactElement, type Ref } from "react";

import { animationFrameScheduler } from "./coalesce.ts";
import { mediaMatches } from "./media-queries.ts";
import { createSurfaceController, type SurfaceController } from "./surface-controller.ts";
import { xtermRendering, type TerminalFont, type XtermRendering } from "./xterm-rendering.ts";

export interface TerminalSurfaceHandle {
  feed(bytes: Uint8Array): void;

  clearViewport(): void;

  selectedText(): string | undefined;

  paste(text: string): void;

  focus(): void;

  viewport(): GridSize | undefined;
}

export interface TerminalSurfaceProps {
  readonly ref?: Ref<TerminalSurfaceHandle>;

  readonly onInput?: (bytes: Uint8Array) => void;

  readonly onViewportChange?: (size: GridSize) => void;

  readonly focused?: boolean;

  readonly label: string;

  readonly font: TerminalFont;

  readonly screenReaderMode?: boolean;
}

export function TerminalSurface({
  ref,
  onInput,
  onViewportChange,
  focused,
  label,
  font,
  screenReaderMode: screenReaderModeProp,
}: TerminalSurfaceProps): ReactElement {
  const screenReaderMode = screenReaderModeProp === true;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const renderingRef = useRef<XtermRendering | undefined>(undefined);
  const controllerRef = useRef<SurfaceController | undefined>(undefined);
  const viewportRef = useRef<GridSize | undefined>(undefined);

  const fontRef = useRef(font);
  const onInputRef = useRef(onInput);
  const onViewportChangeRef = useRef(onViewportChange);
  useEffect(() => {
    onInputRef.current = onInput;
    onViewportChangeRef.current = onViewportChange;
  }, [onInput, onViewportChange]);

  useEffect(() => {
    const container = containerRef.current;

    if (container === null) return;

    const reducedMotion = mediaMatches("(prefers-reduced-motion: reduce)");

    const rendering = xtermRendering({
      container,
      font: fontRef.current,
      screenReaderMode,
      reducedMotion,
    });

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

    return () => {
      controller.dispose();
      rendering.dispose();
      renderingRef.current = undefined;
      controllerRef.current = undefined;
      viewportRef.current = undefined;
    };
  }, [screenReaderMode]);

  useEffect(() => {
    fontRef.current = font;
    renderingRef.current?.setFont(font);
  }, [font]);

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
      paste: (text: string) => renderingRef.current?.paste(text),
      focus: () => {
        renderingRef.current?.focus();
      },
      viewport: () => viewportRef.current,
    }),
    [],
  );

  return (
    <section
      ref={containerRef}
      aria-label={label}
      className="bg-terminal-background h-full w-full overflow-hidden"
    />
  );
}
