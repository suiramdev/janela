import { Undo02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Button,
  Field,
  FieldContent,
  FieldError,
  FieldLabel,
  Kbd,
  KbdGroup,
  cn,
} from "@janela/design";
import type { KeyboardEvent, ReactElement } from "react";
import { useCallback, useEffect, useId, useState } from "react";

import {
  type Command,
  type CommandID,
  type CommandMenu,
  acceleratorCapTokens,
  acceleratorForChord,
} from "../../../shared/config/index.ts";
import {
  type GlobalSettings,
  SHORTCUT_GRAMMAR_MESSAGE,
  commandsWithShortcuts,
  isShortcutOverridden,
  shortcutViolation,
  withCommandShortcut,
} from "../../../shared/model/index.ts";
import { SHORTCUTS_SECTION } from "../model/settings-index.ts";
import { FieldSection } from "./fields.tsx";
import { Section } from "./pane.tsx";

export interface SettingsShortcutsProps {
  readonly settings: GlobalSettings;
  readonly onChange: (settings: GlobalSettings) => void;
  readonly onRecording: (isRecording: boolean) => void;
}

export const SHORTCUT_MENU_TITLE = {
  app: "Janela",
  file: "File",
  view: "View",
  session: "Session",
  terminal: "Terminal",
} satisfies Record<CommandMenu, string>;

const MENU_ORDER: readonly CommandMenu[] = ["file", "view", "session", "terminal", "app"];

export const RECORDING_PROMPT = "Press the new shortcut. Esc keeps the old one.";

export const NO_SHORTCUT = "None";

const MODIFIER_CODE = /^(Meta|Shift|Alt|Control|CapsLock)/;

export function SettingsShortcuts(props: SettingsShortcutsProps): ReactElement {
  const { settings, onChange, onRecording } = props;
  const change = useCallback(
    (id: CommandID, accelerator: string | undefined) => {
      onChange(withCommandShortcut(settings, id, accelerator));
    },
    [onChange, settings],
  );

  useEffect(
    () => () => {
      onRecording(false);
    },
    [onRecording],
  );

  const merged = commandsWithShortcuts(settings, true);

  return (
    <Section section={SHORTCUTS_SECTION}>
      {MENU_ORDER.map((menu) => (
        <FieldSection key={menu} title={SHORTCUT_MENU_TITLE[menu]}>
          {merged
            .filter((command) => command.menu === menu)
            .map((command) => (
              <ShortcutField
                key={command.id}
                command={command}
                settings={settings}
                isOverridden={isShortcutOverridden(settings, command.id)}
                onChange={change}
                onRecording={onRecording}
              />
            ))}
        </FieldSection>
      ))}
    </Section>
  );
}

function ShortcutField(props: {
  readonly command: Command;
  readonly settings: GlobalSettings;
  readonly isOverridden: boolean;
  readonly onChange: (id: CommandID, accelerator: string | undefined) => void;
  readonly onRecording: (isRecording: boolean) => void;
}): ReactElement {
  const { command, settings, onChange, onRecording } = props;
  const id = useId();
  const labelID = `${id}-label`;
  const [isRecording, setRecording] = useState(false);
  const [violation, setViolation] = useState<string | undefined>(undefined);

  const record = useCallback(() => {
    setViolation(undefined);
    setRecording(true);
    onRecording(true);
  }, [onRecording]);

  const stop = useCallback(() => {
    setRecording(false);
    onRecording(false);
  }, [onRecording]);

  const reset = useCallback(() => {
    setViolation(undefined);
    onChange(command.id, undefined);
  }, [command.id, onChange]);

  const keyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (!isRecording) return;

      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        stop();

        return;
      }

      if (MODIFIER_CODE.test(event.code)) return;

      const accelerator = acceleratorForChord(event);
      const refused =
        accelerator === undefined
          ? SHORTCUT_GRAMMAR_MESSAGE
          : shortcutViolation(settings, command.id, accelerator);

      if (accelerator === undefined || refused !== undefined) {
        setViolation(refused);

        return;
      }

      setViolation(undefined);
      stop();
      onChange(command.id, accelerator);
    },
    [command.id, isRecording, onChange, settings, stop],
  );

  return (
    <Field orientation="horizontal" data-invalid={violation === undefined ? undefined : true}>
      <FieldContent>
        <FieldLabel id={labelID} htmlFor={id}>
          {command.title}
        </FieldLabel>
        {violation === undefined ? undefined : <FieldError>{violation}</FieldError>}
      </FieldContent>
      <div className="flex items-center gap-1">
        <Button
          id={id}
          type="button"
          variant="outline"
          size="sm"
          aria-labelledby={labelID}
          aria-pressed={isRecording}
          data-recording={isRecording ? true : undefined}
          className={cn("min-w-24 justify-center", isRecording && "ring-2 ring-ring/60")}
          onClick={record}
          onKeyDown={keyDown}
          onBlur={stop}
        >
          {isRecording ? (
            <span className="text-muted-foreground text-xs">{RECORDING_PROMPT}</span>
          ) : (
            <ShortcutCaps accelerator={command.accelerator} />
          )}
        </Button>
        {props.isOverridden ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Reset ${command.title} to its default`}
            onClick={reset}
          >
            <HugeiconsIcon icon={Undo02Icon} strokeWidth={2} />
          </Button>
        ) : undefined}
      </div>
    </Field>
  );
}

function ShortcutCaps(props: { readonly accelerator: string | undefined }): ReactElement {
  if (props.accelerator === undefined) {
    return <span className="text-muted-foreground text-xs">{NO_SHORTCUT}</span>;
  }

  return (
    <KbdGroup>
      {acceleratorCapTokens(props.accelerator).map((cap) => (
        <Kbd key={cap}>{cap}</Kbd>
      ))}
    </KbdGroup>
  );
}
