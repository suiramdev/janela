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

/**
 * The handful of labelled controls the settings surfaces share.
 *
 * Each is a composition of `@janela/design` primitives — `Field`, `Input`,
 * `Switch` — and nothing more: the label, the hint below it, and the wiring that
 * ties the two to the control. They live here rather than in the design package
 * because a *labelled* field is a decision about how this app's forms read, and
 * the design package deliberately knows nothing about that.
 *
 * Two rules, from AGENTS.md § Non-negotiables 4:
 *
 * - Keyboard-reachable, with the platform focus ring left alone. The text and
 *   number fields are real `input`s; the switch is Base UI's, which mirrors a
 *   hidden checkbox so a `label` still toggles it.
 * - **No `Ctrl` handling anywhere.** `Ctrl` belongs to the program running in the
 *   terminal, and a control that swallows it breaks that program.
 */

export interface TextFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string | undefined;
  readonly hint?: string | undefined;
  /** Read-only fields explain themselves through `hint`, never through silence. */
  readonly isReadOnly?: boolean | undefined;
  /** Set for argv and environment values, where alignment carries meaning. */
  readonly isMonospaced?: boolean | undefined;
  /**
   * The field a sheet opens on. Read by `SheetHost`, which asks the dialog to
   * focus it instead of the first focusable thing — see `sheets.tsx`.
   */
  readonly isInitialFocus?: boolean | undefined;
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

export interface NumberFieldProps {
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly minimum: number;
  readonly maximum: number;
  readonly hint?: string | undefined;
}

export function NumberField(props: NumberFieldProps): ReactElement {
  const { onChange } = props;
  const id = useId();
  const handle = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      // `valueAsNumber` is NaN for an empty field, which the caller's clamp turns
      // into the default rather than into a broken `font-size`.
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

export interface SwitchFieldProps {
  readonly label: string;
  readonly isOn: boolean;
  readonly onChange: (isOn: boolean) => void;
  readonly hint?: string | undefined;
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
      {/* `htmlFor` reaches the hidden checkbox Base UI mirrors, so clicking the
          label toggles; `aria-labelledby` names the visible switch, which is the
          element a screen reader lands on. */}
      <Switch id={id} aria-labelledby={labelID} checked={props.isOn} onCheckedChange={handle} />
    </Field>
  );
}

export interface ProfileSelectProps {
  readonly label: string;
  readonly profiles: readonly LaunchProfile[];
  readonly availability: LaunchProfileAvailability;
  readonly value: LaunchProfileID | undefined;
  readonly onChange: (profileID: LaunchProfileID | undefined) => void;
  /** What an unset value means here — it differs per scope, so the caller says. */
  readonly unsetTitle: string;
  readonly hint?: string;
}

/**
 * A dropdown for "which profile by default", used by both settings scopes.
 *
 * Lists available profiles only — a profile whose tool is not installed is an
 * advert — plus the currently selected one even if it has become unavailable,
 * because a select that silently drops the stored value shows the user a setting
 * they never made.
 */
export function ProfileSelect(props: ProfileSelectProps): ReactElement {
  const { onChange, profiles, value } = props;
  const id = useId();
  const pickable = availableProfiles(profiles, props.availability);
  const stored = profiles.find((profile) => profile.id === value);
  const listed =
    stored === undefined || pickable.includes(stored) ? pickable : [stored, ...pickable];

  const handle = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      // Matched rather than re-branded: the option values are ids this component
      // rendered, so looking one up is both the validation and the conversion.
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

/**
 * Why something cannot be saved.
 *
 * Rendered as a list even for one entry, so a second violation appearing does not
 * change the shape of the surface under the user's eyes.
 */
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

/**
 * A titled group of fields.
 *
 * `fieldset`/`legend` rather than a `div` and a heading, because a screen reader
 * announces the group when focus enters it — which is the difference between
 * "Enabled" and "Enabled, When a session is first opened".
 */
export function Section(props: {
  readonly title: string;
  readonly hint?: string | undefined;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <FieldSet>
      <FieldLegend>{props.title}</FieldLegend>
      {props.hint === undefined ? undefined : <FieldDescription>{props.hint}</FieldDescription>}
      <FieldGroup>{props.children}</FieldGroup>
    </FieldSet>
  );
}
