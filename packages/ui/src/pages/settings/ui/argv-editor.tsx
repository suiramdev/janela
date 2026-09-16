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

import { type ArgumentDraft, argumentsAppending } from "../../../shared/model/index.ts";
import { FieldSection } from "./fields.tsx";

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
    <FieldSection title={props.title} hint={props.hint}>
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
    </FieldSection>
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

  const label = index === 0 ? "Executable" : `Argument ${index}`;

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup>
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
