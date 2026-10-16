import { cn, FieldError, Input, NativeSelect, NativeSelectOption, Switch } from "@janela/design";
import type { ChangeEvent, ReactElement, ReactNode } from "react";
import { useCallback, useId } from "react";

import { CONTROL_WIDTH, SettingRow, labelIDFor } from "./pane.tsx";

export interface Choice<Value extends string> {
  readonly value: Value;
  readonly title: string;
  readonly isDisabled?: boolean | undefined;
}

export interface TextRowProps {
  readonly label: string;
  readonly description?: ReactNode;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string | undefined;
  readonly isMonospaced?: boolean | undefined;
  readonly isWide?: boolean | undefined;
}

export interface NumberRowProps {
  readonly label: string;
  readonly description?: ReactNode;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly minimum: number;
  readonly maximum: number;
  readonly unit?: string | undefined;
}

export interface SwitchRowProps {
  readonly label: string;
  readonly description?: ReactNode;
  readonly isOn: boolean;
  readonly onChange: (isOn: boolean) => void;
}

export interface SelectRowProps<Value extends string> {
  readonly label: string;
  readonly description?: ReactNode;
  readonly value: Value;
  readonly choices: readonly Choice<Value>[];
  readonly onChange: (value: Value) => void;
  readonly isDisabled?: boolean | undefined;
}

export function TextRow(props: TextRowProps): ReactElement {
  const { onChange } = props;
  const id = useId();

  const handle = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onChange(event.target.value);
    },
    [onChange],
  );

  return (
    <SettingRow label={props.label} description={props.description} controlID={id}>
      <Input
        id={id}
        type="text"
        value={props.value}
        placeholder={props.placeholder}
        onChange={handle}
        className={cn(
          props.isWide === true ? "w-72" : CONTROL_WIDTH,
          props.isMonospaced === true && "font-mono",
        )}
        autoComplete="off"
        spellCheck={false}
      />
    </SettingRow>
  );
}

export function NumberRow(props: NumberRowProps): ReactElement {
  const { onChange } = props;
  const id = useId();

  const handle = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onChange(event.target.valueAsNumber);
    },
    [onChange],
  );

  return (
    <SettingRow label={props.label} description={props.description} controlID={id}>
      <Input
        id={id}
        type="number"
        value={props.value}
        min={props.minimum}
        max={props.maximum}
        onChange={handle}
        className="w-20 tabular-nums"
      />
      {props.unit === undefined ? undefined : (
        <span className="text-muted-foreground text-xs">{props.unit}</span>
      )}
    </SettingRow>
  );
}

export function SwitchRow(props: SwitchRowProps): ReactElement {
  const { onChange } = props;
  const id = useId();

  const handle = useCallback(
    (checked: boolean) => {
      onChange(checked);
    },
    [onChange],
  );

  return (
    <SettingRow label={props.label} description={props.description} controlID={id}>
      <Switch
        id={id}
        aria-labelledby={labelIDFor(id)}
        checked={props.isOn}
        onCheckedChange={handle}
      />
    </SettingRow>
  );
}

export function SelectRow<Value extends string>(props: SelectRowProps<Value>): ReactElement {
  const id = useId();

  return (
    <SettingRow
      label={props.label}
      description={props.description}
      controlID={id}
      isDisabled={props.isDisabled}
    >
      <ChoiceSelect
        id={id}
        value={props.value}
        choices={props.choices}
        onChange={props.onChange}
        isDisabled={props.isDisabled}
      />
    </SettingRow>
  );
}

export function ChoiceSelect<Value extends string>(props: {
  readonly id?: string | undefined;
  readonly label?: string | undefined;
  readonly value: Value;
  readonly choices: readonly Choice<Value>[];
  readonly onChange: (value: Value) => void;
  readonly isDisabled?: boolean | undefined;
  readonly className?: string | undefined;
}): ReactElement {
  const { choices, onChange } = props;

  const handle = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const chosen = choices.find((choice) => choice.value === event.target.value);

      if (chosen !== undefined) onChange(chosen.value);
    },
    [choices, onChange],
  );

  return (
    <NativeSelect
      id={props.id}
      aria-label={props.label}
      value={props.value}
      onChange={handle}
      disabled={props.isDisabled ?? false}
      className={props.className ?? CONTROL_WIDTH}
    >
      {choices.map((choice) => (
        <NativeSelectOption key={choice.value} value={choice.value} disabled={choice.isDisabled}>
          {choice.title}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

export function Violations(props: { readonly violations: readonly string[] }): ReactElement | null {
  if (props.violations.length === 0) return null;

  return (
    <FieldError className="py-2.5">
      <ul className="ml-4 flex list-disc flex-col gap-1">
        {props.violations.map((violation) => (
          <li key={violation}>{violation}</li>
        ))}
      </ul>
    </FieldError>
  );
}
