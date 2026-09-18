import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  RadioGroup,
  RadioGroupItem,
  Switch,
} from "@janela/design";
import type { ChangeEvent, ComponentProps, ReactElement, ReactNode } from "react";
import { useCallback, useId } from "react";

type ChoiceChangeHandler = NonNullable<ComponentProps<typeof RadioGroup>["onValueChange"]>;

export interface TextFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string | undefined;
  readonly hint?: string | undefined;
  readonly isReadOnly?: boolean | undefined;
  readonly isMonospaced?: boolean | undefined;
  readonly isInitialFocus?: boolean | undefined;
}

export interface NumberFieldProps {
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly minimum: number;
  readonly maximum: number;
  readonly hint?: string | undefined;
}

export interface SwitchFieldProps {
  readonly label: string;
  readonly isOn: boolean;
  readonly onChange: (isOn: boolean) => void;
  readonly hint?: string | undefined;
}

export interface Choice<Value extends string> {
  readonly value: Value;
  readonly title: string;
  readonly detail: string;
}

export interface ChoiceFieldProps<Value extends string> {
  readonly label: string;
  readonly value: Value;
  readonly choices: readonly Choice<Value>[];
  readonly onChange: (value: Value) => void;
  readonly isDisabled?: boolean | undefined;
  readonly hint?: string | undefined;
}

export function TextField(props: TextFieldProps): ReactElement {
  const { onChange } = props;
  const id = useId();

  const handle = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onChange(event.target.value);
    },
    [onChange],
  );

  return (
    <Field>
      <FieldLabel htmlFor={id}>{props.label}</FieldLabel>
      <Input
        id={id}
        type="text"
        value={props.value}
        placeholder={props.placeholder}
        readOnly={props.isReadOnly ?? false}
        onChange={handle}
        className={props.isMonospaced === true ? "font-mono" : undefined}
        data-autofocus={props.isInitialFocus === true ? "" : undefined}
        autoComplete="off"
        spellCheck={false}
      />
      {props.hint === undefined ? undefined : <FieldDescription>{props.hint}</FieldDescription>}
    </Field>
  );
}

export function NumberField(props: NumberFieldProps): ReactElement {
  const { onChange } = props;
  const id = useId();

  const handle = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onChange(event.target.valueAsNumber);
    },
    [onChange],
  );

  return (
    <Field>
      <FieldLabel htmlFor={id}>{props.label}</FieldLabel>
      <Input
        id={id}
        type="number"
        value={props.value}
        min={props.minimum}
        max={props.maximum}
        onChange={handle}
        className="w-24"
      />
      {props.hint === undefined ? undefined : <FieldDescription>{props.hint}</FieldDescription>}
    </Field>
  );
}

export function SwitchField(props: SwitchFieldProps): ReactElement {
  const { onChange } = props;
  const id = useId();
  const labelID = `${id}-label`;

  const handle = useCallback(
    (checked: boolean) => {
      onChange(checked);
    },
    [onChange],
  );

  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel id={labelID} htmlFor={id}>
          {props.label}
        </FieldLabel>
        {props.hint === undefined ? undefined : <FieldDescription>{props.hint}</FieldDescription>}
      </FieldContent>
      <Switch id={id} aria-labelledby={labelID} checked={props.isOn} onCheckedChange={handle} />
    </Field>
  );
}

export function ChoiceField<Value extends string>(props: ChoiceFieldProps<Value>): ReactElement {
  const { choices, onChange, isDisabled = false } = props;
  const id = useId();

  const handle = useCallback<ChoiceChangeHandler>(
    (next) => {
      const chosen = choices.find((choice) => choice.value === next);

      if (chosen !== undefined) onChange(chosen.value);
    },
    [choices, onChange],
  );

  return (
    <Field data-disabled={isDisabled ? "" : undefined}>
      <FieldLabel id={id}>{props.label}</FieldLabel>
      <RadioGroup
        value={props.value}
        onValueChange={handle}
        aria-labelledby={id}
        disabled={isDisabled}
      >
        {choices.map((choice) => (
          <ChoiceOption key={choice.value} choice={choice} isDisabled={isDisabled} />
        ))}
      </RadioGroup>
      {props.hint === undefined ? undefined : <FieldDescription>{props.hint}</FieldDescription>}
    </Field>
  );
}

function ChoiceOption<Value extends string>(props: {
  readonly choice: Choice<Value>;
  readonly isDisabled: boolean;
}): ReactElement {
  const { choice, isDisabled } = props;
  const id = useId();

  return (
    <Field orientation="horizontal">
      <RadioGroupItem value={choice.value} id={id} disabled={isDisabled} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <FieldLabel htmlFor={id} className={isDisabled ? "opacity-50" : undefined}>
          {choice.title}
        </FieldLabel>
        <FieldDescription>{choice.detail}</FieldDescription>
      </div>
    </Field>
  );
}

export function Violations(props: { readonly violations: readonly string[] }): ReactElement | null {
  if (props.violations.length === 0) return null;

  return (
    <FieldError>
      <ul className="ml-4 flex list-disc flex-col gap-1">
        {props.violations.map((violation) => (
          <li key={violation}>{violation}</li>
        ))}
      </ul>
    </FieldError>
  );
}

export function FieldSection(props: {
  readonly title: string;
  readonly hint?: string | undefined;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <FieldSet>
      <FieldLegend variant="label">{props.title}</FieldLegend>
      {props.hint === undefined ? undefined : <FieldDescription>{props.hint}</FieldDescription>}
      <FieldGroup>{props.children}</FieldGroup>
    </FieldSet>
  );
}
