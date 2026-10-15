import type { SessionNaming, SessionNamingOverview } from "@janela/core";
import {
  Alert,
  AlertDescription,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  Spinner,
} from "@janela/design";
import { Match } from "effect";
import type { ChangeEvent, KeyboardEvent, ReactElement } from "react";
import { useCallback, useEffect, useId, useState } from "react";

import { integrationFailureSummary } from "../model/integrations.ts";
import {
  type NamerChoice,
  type SessionNamingRequesting,
  type SessionNamingState,
  chosenNamer,
  configureSessionNaming,
  loadSessionNaming,
  namerOptions,
  namingFor,
  namingModel,
} from "../model/session-naming.ts";
import { INTEGRATIONS_NAMING_SECTION } from "../model/settings-index.ts";
import { ChoiceField } from "./fields.tsx";
import { Section } from "./pane.tsx";

export interface SettingsSessionNamingProps {
  readonly connection: SessionNamingRequesting;
}

export interface SessionNamingFormProps {
  readonly state: SessionNamingState;
  readonly isPending: boolean;
  readonly onConfigure: (naming: SessionNaming) => void;
}

const LOADING: SessionNamingState = { kind: "loading" };

export function SettingsSessionNaming(props: SettingsSessionNamingProps): ReactElement {
  const { connection } = props;
  const [state, setState] = useState<SessionNamingState>(LOADING);
  const [isPending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;

    loadSessionNaming(connection).then(
      (overview) => {
        if (!cancelled) setState({ kind: "loaded", overview });

        return undefined;
      },
      (cause: unknown) => {
        if (!cancelled) setState({ kind: "failed", summary: integrationFailureSummary(cause) });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [connection]);

  const configure = useCallback(
    (naming: SessionNaming) => {
      setPending(true);

      configureSessionNaming(connection, naming).then(
        (overview) => {
          setState({ kind: "loaded", overview });
          setPending(false);

          return undefined;
        },
        (cause: unknown) => {
          setState({ kind: "failed", summary: integrationFailureSummary(cause) });
          setPending(false);
        },
      );
    },
    [connection],
  );

  return <SessionNamingForm state={state} isPending={isPending} onConfigure={configure} />;
}

export function SessionNamingForm(props: SessionNamingFormProps): ReactElement {
  const { isPending, onConfigure } = props;

  return (
    <Section section={INTEGRATIONS_NAMING_SECTION}>
      {Match.value(props.state).pipe(
        Match.when({ kind: "loading" }, () => <Spinner className="text-muted-foreground" />),
        Match.when({ kind: "failed" }, (failed) => (
          <Alert variant="destructive">
            <AlertDescription>{failed.summary}</AlertDescription>
          </Alert>
        )),
        Match.when({ kind: "loaded" }, (loaded) => (
          <NamingChoices
            overview={loaded.overview}
            isPending={isPending}
            onConfigure={onConfigure}
          />
        )),
        Match.exhaustive,
      )}
    </Section>
  );
}

function NamingChoices(props: {
  readonly overview: SessionNamingOverview;
  readonly isPending: boolean;
  readonly onConfigure: (naming: SessionNaming) => void;
}): ReactElement {
  const { overview, isPending, onConfigure } = props;
  const { naming } = overview;
  const chosen = chosenNamer(overview);

  const choose = useCallback(
    (choice: NamerChoice) => {
      onConfigure(namingFor(choice, ""));
    },
    [onConfigure],
  );

  const commitModel = useCallback(
    (model: string) => {
      if (chosen !== undefined && model.trim() !== namingModel(naming)) {
        onConfigure(namingFor(chosen.id, model));
      }
    },
    [chosen, naming, onConfigure],
  );

  return (
    <>
      <ChoiceField
        label="Name sessions with"
        value={naming.kind === "off" ? "off" : naming.agent}
        choices={namerOptions(overview)}
        onChange={choose}
        isDisabled={isPending}
      />
      {chosen === undefined ? undefined : (
        <ModelField
          key={chosen.id}
          initial={namingModel(naming)}
          placeholder={chosen.defaultModel ?? "the agent's default"}
          isDisabled={isPending}
          onCommit={commitModel}
        />
      )}
    </>
  );
}

function ModelField(props: {
  readonly initial: string;
  readonly placeholder: string;
  readonly isDisabled: boolean;
  readonly onCommit: (model: string) => void;
}): ReactElement {
  const { onCommit } = props;
  const id = useId();
  const [draft, setDraft] = useState(props.initial);

  const change = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setDraft(event.target.value);
  }, []);

  const commit = useCallback(() => {
    onCommit(draft);
  }, [draft, onCommit]);

  const commitOnEnter = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") onCommit(draft);
    },
    [draft, onCommit],
  );

  return (
    <Field>
      <FieldLabel htmlFor={id}>Model</FieldLabel>
      <Input
        id={id}
        type="text"
        value={draft}
        placeholder={props.placeholder}
        disabled={props.isDisabled}
        onChange={change}
        onBlur={commit}
        onKeyDown={commitOnEnter}
        className="font-mono"
        autoComplete="off"
        spellCheck={false}
      />
      <FieldDescription>
        Leave it empty for the default. Naming wants the smallest, fastest model the agent offers: a
        name is a few words, and it should land while you are still reading the first reply.
      </FieldDescription>
    </Field>
  );
}
