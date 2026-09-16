import {
  availableProfiles,
  type LaunchProfile,
  type LaunchProfileAvailability,
  type LaunchProfileID,
} from "@janela/core";
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
  NativeSelect,
  NativeSelectOption,
  Switch,
} from "@janela/design";
import type { ChangeEvent, ReactElement, ReactNode } from "react";
import { useCallback, useId } from "react";

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

export interface ProfileSelectProps {
  readonly label: string;
  readonly profiles: readonly LaunchProfile[];
  readonly availability: LaunchProfileAvailability;
  readonly value: LaunchProfileID | undefined;
  readonly onChange: (profileID: LaunchProfileID | undefined) => void;
  readonly unsetTitle: string;
  readonly hint?: string;
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

export function ProfileSelect(props: ProfileSelectProps): ReactElement {
  const { onChange, profiles, value } = props;
  const id = useId();
  const pickable = availableProfiles(profiles, props.availability);
  const stored = profiles.find((profile) => profile.id === value);

  const listed =
    stored === undefined || pickable.includes(stored) ? pickable : [stored, ...pickable];

  const handle = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      onChange(profiles.find((profile) => profile.id === event.target.value)?.id);
    },
    [onChange, profiles],
  );

  return (
    <Field>
      <FieldLabel htmlFor={id}>{props.label}</FieldLabel>
      <NativeSelect id={id} className="w-full" value={value ?? ""} onChange={handle}>
        <NativeSelectOption value="">{props.unsetTitle}</NativeSelectOption>
        {listed.map((profile) => (
          <NativeSelectOption key={profile.id} value={profile.id}>
            {profile.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {props.hint === undefined ? undefined : <FieldDescription>{props.hint}</FieldDescription>}
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
