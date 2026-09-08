import type { ChangeEvent, ReactElement, ReactNode } from "react";
import { useCallback } from "react";

import * as style from "./styles.ts";

/**
 * The handful of controls the settings surface needs.
 *
 * These are local to `@janela/ui` on purpose. `@janela/design`'s control set is a
 * seam another issue owns, and its list is closed by design — a design package
 * that grows a component per screen has become the UI package. When those land,
 * these move; until then a settings pane is not a reason to open that file.
 *
 * Two rules, from AGENTS.md § Non-negotiables 4 and the design package's own
 * comment, and both are why these are hand-written rather than borrowed:
 *
 * - Keyboard-reachable, with the platform focus ring left alone. Every control
 *   here is a real `input`, `select` or `button` inside a `label`, so focus,
 *   labelling and activation are the browser's job and cannot be got wrong.
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
}

export function TextField(props: TextFieldProps): ReactElement {
  const { onChange } = props;
  const handle = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onChange(event.target.value);
    },
    [onChange],
  );

  return (
    <label style={style.FIELD}>
      <span style={style.FIELD_LABEL}>{props.label}</span>
      <input
        type="text"
        value={props.value}
        placeholder={props.placeholder}
        readOnly={props.isReadOnly ?? false}
        onChange={handle}
        style={props.isMonospaced === true ? style.ARGUMENT_INPUT : style.INPUT}
      />
      {props.hint === undefined ? undefined : <span style={style.HINT}>{props.hint}</span>}
    </label>
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
  const handle = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      // `valueAsNumber` is NaN for an empty field, which the caller's clamp turns
      // into the default rather than into a broken `font-size`.
      onChange(event.target.valueAsNumber);
    },
    [onChange],
  );

  return (
    <label style={style.FIELD}>
      <span style={style.FIELD_LABEL}>{props.label}</span>
      <input
        type="number"
        value={props.value}
        min={props.minimum}
        max={props.maximum}
        onChange={handle}
        style={style.INPUT}
      />
      {props.hint === undefined ? undefined : <span style={style.HINT}>{props.hint}</span>}
    </label>
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
  const handle = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onChange(event.target.checked);
    },
    [onChange],
  );

  return (
    <label style={style.FIELD}>
      <span style={style.ROW}>
        <input type="checkbox" checked={props.isOn} onChange={handle} />
        <span style={style.FIELD_LABEL}>{props.label}</span>
      </span>
      {props.hint === undefined ? undefined : <span style={style.HINT}>{props.hint}</span>}
    </label>
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
    <ul style={style.LIST} role="alert">
      {props.violations.map((violation) => (
        <li key={violation} style={style.VIOLATION}>
          {violation}
        </li>
      ))}
    </ul>
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
    <fieldset style={style.SECTION}>
      <legend style={style.SECTION_HEADING}>{props.title}</legend>
      {props.hint === undefined ? undefined : <p style={style.HINT}>{props.hint}</p>}
      {props.children}
    </fieldset>
  );
}
