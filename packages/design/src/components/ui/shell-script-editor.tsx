import { cn } from "cn";
import type { ChangeEvent, ReactElement } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { TERMINAL_FONT_STACK } from "../../tokens.ts";

export interface ShellScriptEditorProps {
  readonly id?: string | undefined;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string | undefined;
  readonly className?: string | undefined;
}

interface MountedEditor {
  readonly read: () => string;
  readonly write: (value: string) => void;
  readonly dispose: () => void;
}

const SHELL = "shell";

const LINE_HEIGHT = 20;

const FONT_SIZE = 12;

const DARK_SCHEME = "(prefers-color-scheme: dark)";

const FRAME =
  "border-input bg-input/20 focus-within:border-ring focus-within:ring-ring/30 dark:bg-input/30 relative h-52 w-full overflow-hidden rounded-md border transition-colors focus-within:ring-2";

const FALLBACK =
  "placeholder:text-muted-foreground absolute inset-0 h-full w-full resize-none bg-transparent px-2 py-2 text-xs/relaxed outline-none";

function themeFor(isDark: boolean): string {
  return isDark ? "vs-dark" : "vs";
}

async function mountMonaco(
  container: HTMLElement,
  initial: string,
  onChange: (value: string) => void,
): Promise<MountedEditor> {
  const monaco = await import("monaco-editor/esm/vs/editor/editor.api.js");
  await import("monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js");

  self.MonacoEnvironment = {
    getWorker: () =>
      new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), {
        type: "module",
      }),
  };

  const scheme = window.matchMedia(DARK_SCHEME);

  const editor = monaco.editor.create(container, {
    value: initial,
    language: SHELL,
    theme: themeFor(scheme.matches),
    automaticLayout: true,
    minimap: { enabled: false },
    lineNumbers: "on",
    folding: false,
    scrollBeyondLastLine: false,
    renderLineHighlight: "none",
    fontFamily: TERMINAL_FONT_STACK,
    fontSize: FONT_SIZE,
    lineHeight: LINE_HEIGHT,
    tabSize: 2,
    wordWrap: "on",
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    scrollbar: { vertical: "auto", horizontal: "hidden", useShadows: false },
    padding: { top: 8, bottom: 8 },
  });

  const model = editor.getModel();
  const changes = model?.onDidChangeContent(() => onChange(editor.getValue()));

  const follow = (): void => monaco.editor.setTheme(themeFor(scheme.matches));
  scheme.addEventListener("change", follow);

  return {
    read: () => editor.getValue(),
    write: (value) => editor.setValue(value),
    dispose: () => {
      scheme.removeEventListener("change", follow);
      changes?.dispose();
      editor.dispose();
    },
  };
}

export function ShellScriptEditor(props: ShellScriptEditorProps): ReactElement {
  const { value, onChange } = props;
  const container = useRef<HTMLDivElement | null>(null);
  const mounted = useRef<MountedEditor | undefined>(undefined);
  const change = useRef(onChange);
  const [isMounted, setMounted] = useState(false);

  useEffect(() => {
    change.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const host = container.current;

    if (host === null) return undefined;

    let cancelled = false;

    void mountMonaco(host, value, (next) => change.current(next)).then(
      (editor) => {
        if (cancelled) {
          editor.dispose();

          return undefined;
        }

        mounted.current = editor;
        setMounted(true);

        return undefined;
      },
      () => undefined,
    );

    return () => {
      cancelled = true;
      mounted.current?.dispose();
      mounted.current = undefined;
      setMounted(false);
    };
    // SAFETY: `value` is read once, at mount; later values reach the editor through the sync effect below, and re-mounting Monaco on every keystroke would lose the caret.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = mounted.current;

    if (editor !== undefined && editor.read() !== value) editor.write(value);
  }, [value, isMounted]);

  const changeFallback = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      onChange(event.target.value);
    },
    [onChange],
  );

  return (
    <div
      data-slot="shell-script-editor"
      data-editor={isMounted ? "monaco" : "textarea"}
      className={cn(FRAME, props.className)}
    >
      <div ref={container} className="absolute inset-0" />
      {isMounted ? undefined : (
        <textarea
          id={props.id}
          value={value}
          onChange={changeFallback}
          placeholder={props.placeholder}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          className={FALLBACK}
          style={{ fontFamily: TERMINAL_FONT_STACK }}
        />
      )}
    </div>
  );
}
