import type { ReactElement } from "react";
import { useCallback } from "react";

import { Section, TextField } from "./controls.tsx";
import type { ArgumentDraft } from "./profile-editing.ts";
import { argumentsAppending } from "./profile-editing.ts";
import * as style from "./styles.ts";

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
      <div style={style.ROW}>
        <button type="button" onClick={append} style={style.BUTTON}>
          Add Argument
        </button>
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
  const change = useCallback(
    (value: string) => {
      onChange(draft.id, value);
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
    <div style={style.ROW}>
      <TextField label={label} value={draft.value} onChange={change} isMonospaced />
      <button type="button" onClick={remove} style={style.BUTTON} aria-label={`Remove ${label}`}>
        Remove
      </button>
    </div>
  );
}
