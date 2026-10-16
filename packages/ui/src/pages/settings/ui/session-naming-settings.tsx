import type { SessionNamerID, SessionNaming, SessionNamingOverview } from "@janela/core";
import { Alert, AlertDescription, Spinner } from "@janela/design";
import { Match } from "effect";
import type { ReactElement } from "react";
import { useCallback, useEffect, useId, useState } from "react";

import { integrationFailureSummary } from "../model/integrations.ts";
import {
  type NamerCatalogState,
  type NamerChoice,
  type SessionNamingRequesting,
  type SessionNamingState,
  chosenNamer,
  configureSessionNaming,
  effortItems,
  loadNamerCatalog,
  loadSessionNaming,
  modelItems,
  namerOptions,
  namingEffort,
  namingFor,
  namingModel,
} from "../model/session-naming.ts";
import { INTEGRATIONS_NAMING_SECTION } from "../model/settings-index.ts";
import { SelectRow } from "./fields.tsx";
import { SettingRow, SettingsGroup } from "./pane.tsx";
import { SuggestionCombobox } from "./suggestion-combobox.tsx";

export interface SettingsSessionNamingProps {
  readonly connection: SessionNamingRequesting;
}

export interface SessionNamingFormProps {
  readonly state: SessionNamingState;
  readonly catalog: NamerCatalogState;
  readonly isPending: boolean;
  readonly onConfigure: (naming: SessionNaming) => void;
}

export const NAMING_HINT = "Renames a session after what you first ask its agent.";

interface AgentCatalog {
  readonly agent: SessionNamerID;
  readonly state: NamerCatalogState;
}

const LOADING: SessionNamingState = { kind: "loading" };

const CATALOG_LOADING: NamerCatalogState = { kind: "loading" };

export function SettingsSessionNaming(props: SettingsSessionNamingProps): ReactElement {
  const { connection } = props;
  const [state, setState] = useState<SessionNamingState>(LOADING);
  const [catalogs, setCatalog] = useState<AgentCatalog | undefined>(undefined);
  const [isPending, setPending] = useState(false);

  const agent: SessionNamerID | undefined =
    state.kind === "loaded" && state.overview.naming.kind === "agent"
      ? state.overview.naming.agent
      : undefined;

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

  useEffect(() => {
    if (agent === undefined) return undefined;

    let cancelled = false;

    loadNamerCatalog(connection, agent).then(
      (loaded) => {
        if (!cancelled) setCatalog({ agent, state: { kind: "loaded", catalog: loaded } });

        return undefined;
      },
      (cause: unknown) => {
        if (!cancelled) {
          setCatalog({
            agent,
            state: { kind: "failed", summary: integrationFailureSummary(cause) },
          });
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [agent, connection]);

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

  const catalog =
    catalogs !== undefined && catalogs.agent === agent ? catalogs.state : CATALOG_LOADING;

  return (
    <SessionNamingForm
      state={state}
      catalog={catalog}
      isPending={isPending}
      onConfigure={configure}
    />
  );
}

export function SessionNamingForm(props: SessionNamingFormProps): ReactElement {
  const { catalog, isPending, onConfigure } = props;

  return (
    <SettingsGroup section={INTEGRATIONS_NAMING_SECTION}>
      {Match.value(props.state).pipe(
        Match.when({ kind: "loading" }, () => (
          <div className="py-3">
            <Spinner className="text-muted-foreground" />
          </div>
        )),
        Match.when({ kind: "failed" }, (failed) => (
          <Alert variant="destructive" className="my-2.5">
            <AlertDescription>{failed.summary}</AlertDescription>
          </Alert>
        )),
        Match.when({ kind: "loaded" }, (loaded) => (
          <NamingRows
            overview={loaded.overview}
            catalog={catalog}
            isPending={isPending}
            onConfigure={onConfigure}
          />
        )),
        Match.exhaustive,
      )}
    </SettingsGroup>
  );
}

function NamingRows(props: {
  readonly overview: SessionNamingOverview;
  readonly catalog: NamerCatalogState;
  readonly isPending: boolean;
  readonly onConfigure: (naming: SessionNaming) => void;
}): ReactElement {
  const { overview, catalog, isPending, onConfigure } = props;
  const { naming } = overview;
  const chosen = chosenNamer(overview);
  const model = namingModel(naming);
  const effort = namingEffort(naming);
  const modelID = useId();
  const effortID = useId();
  const loaded = catalog.kind === "loaded" ? catalog.catalog : undefined;
  const current = loaded?.agent === chosen?.id ? loaded : undefined;

  const empty = Match.value(catalog).pipe(
    Match.when({ kind: "loading" }, () => "Asking the provider…"),
    Match.when({ kind: "failed" }, (failed) => failed.summary),
    Match.when({ kind: "loaded" }, () => "Nothing matches. Type to use your own."),
    Match.exhaustive,
  );

  const choose = useCallback(
    (choice: NamerChoice) => {
      onConfigure(namingFor(choice, ""));
    },
    [onConfigure],
  );

  const commitModel = useCallback(
    (next: string) => {
      if (chosen !== undefined) onConfigure(namingFor(chosen.id, next, effort));
    },
    [chosen, effort, onConfigure],
  );

  const commitEffort = useCallback(
    (next: string) => {
      if (chosen !== undefined) onConfigure(namingFor(chosen.id, model, next));
    },
    [chosen, model, onConfigure],
  );

  return (
    <>
      <SelectRow
        label="Provider"
        description={NAMING_HINT}
        value={naming.kind === "off" ? "off" : naming.agent}
        choices={namerOptions(overview)}
        onChange={choose}
        isDisabled={isPending}
      />
      {chosen === undefined ? undefined : (
        <>
          <SettingRow label="Model" controlID={modelID}>
            <SuggestionCombobox
              id={modelID}
              value={model}
              items={modelItems(current)}
              placeholder={chosen.defaultModel ?? "Default"}
              empty={empty}
              isDisabled={isPending}
              onCommit={commitModel}
            />
          </SettingRow>
          <SettingRow label="Reasoning effort" controlID={effortID}>
            <SuggestionCombobox
              id={effortID}
              value={effort}
              items={effortItems(current, model === "" ? (chosen.defaultModel ?? "") : model)}
              placeholder="Default"
              empty={empty}
              isDisabled={isPending}
              onCommit={commitEffort}
            />
          </SettingRow>
        </>
      )}
    </>
  );
}
