import { Cancel01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Button,
  Field,
  FieldLabel,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@janela/design";
import type { ChangeEvent, ReactElement } from "react";
import { useCallback, useId } from "react";

import { Section } from "./controls.tsx";
import type { ArgumentDraft } from "./profile-editing.ts";
import { argumentsAppending } from "./profile-editing.ts";

/**
 * One field per argv element, shared by launch profiles and automation commands.
 *
 * Both edit an argv array for the same reason and with the same rule, so they get
 * the same editor: there is **no** field that takes `claude --model opus` and
 * splits it. Splitting a string into argv has no correct implementation —
 * `zsh -lc "echo 'a b'"` has no right answer — and every wrong one is a quoting
 * bug in a program the user cares about. A user who wants a shell types `zsh`,
 * `-lc` and the script into three fields, and has chosen that.
 *
 * See AGENTS.md § Conventions.
 */
export interface ArgumentsEditorProps {
  readonly drafts: readonly ArgumentDraft[];
  readonly onChange: (drafts: readonly ArgumentDraft[]) => void;
  readonly title: string;
  readonly hint: string;
}

export function ArgumentsEditor(props: ArgumentsEditorProps): ReactElement {
  const { drafts, onChange } = props;

  const change = useCallback(
    (id: string, value: string) => {
      onChange(drafts.map((draft) => (draft.id === id ? { id, value } : draft)));
    },
    [drafts, onChange],
  );
  const remove = useCallback(
    (id: string) => {
      onChange(drafts.filter((draft) => draft.id !== id));
    },
    [drafts, onChange],
  );
  const append = useCallback(() => {
    onChange(argumentsAppending(drafts));
  }, [drafts, onChange]);

  return (
    <Section title={props.title} hint={props.hint}>
      {drafts.map((draft, index) => (
        <ArgumentRow
          key={draft.id}
          draft={draft}
          index={index}
          onChange={change}
          onRemove={remove}
        />
      ))}
      <div>
        <Button type="button" variant="outline" size="sm" onClick={append}>
          <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
          Add Argument
        </Button>
      </div>
    </Section>
  );
}

function ArgumentRow(props: {
  readonly draft: ArgumentDraft;
  readonly index: number;
  readonly onChange: (id: string, value: string) => void;
  readonly onRemove: (id: string) => void;
}): ReactElement {
  const { draft, index, onChange, onRemove } = props;
  const id = useId();
  const change = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onChange(draft.id, event.target.value);
    },
    [draft.id, onChange],
  );
  const remove = useCallback(() => {
    onRemove(draft.id);
  }, [draft.id, onRemove]);

  // Position is the label: argv[0] is the executable and the rest are numbered
  // the way the program itself will see them.
  const label = index === 0 ? "Executable" : `Argument ${index}`;

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup>
        {/* Monospaced because an argument is read character by character: a
            trailing space or an l/1 confusion is the bug being looked for. */}
        <InputGroupInput
          id={id}
          value={draft.value}
          onChange={change}
          className="font-mono"
          autoComplete="off"
          spellCheck={false}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" onClick={remove} aria-label={`Remove ${label}`}>
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </Field>
  );
}
