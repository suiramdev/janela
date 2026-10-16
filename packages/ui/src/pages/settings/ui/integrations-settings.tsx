import type { IntegrationID, IntegrationReport } from "@janela/core";
import { Alert, AlertDescription, Button, cn, Spinner } from "@janela/design";
import { Match } from "effect";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  type IntegrationAction,
  type IntegrationRequesting,
  type IntegrationsState,
  actOnIntegration,
  integrationAction,
  integrationCapabilitiesText,
  integrationFailureSummary,
  integrationStatusText,
  loadIntegrations,
} from "../model/integrations.ts";
import { INTEGRATIONS_HOOKS_SECTION } from "../model/settings-index.ts";
import { IntegrationLogo } from "./integration-logo.tsx";
import { SettingRow, SettingsGroup } from "./pane.tsx";

export interface SettingsIntegrationsProps {
  readonly connection: IntegrationRequesting;
}

export interface IntegrationsListProps {
  readonly state: IntegrationsState;
  readonly pending: IntegrationID | undefined;
  readonly onAct: (report: IntegrationReport) => void;
}

const LOADING: IntegrationsState = { kind: "loading" };

const ACTION_LABEL = {
  install: "Install",
  update: "Update",
  remove: "Remove",
} satisfies Record<IntegrationAction, string>;

const ACTION_VARIANT = {
  install: "outline",
  update: "default",
  remove: "ghost",
} as const satisfies Record<IntegrationAction, "outline" | "default" | "ghost">;

export function SettingsIntegrations(props: SettingsIntegrationsProps): ReactElement {
  const { connection } = props;
  const [state, setState] = useState<IntegrationsState>(LOADING);
  const [pending, setPending] = useState<IntegrationID | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    loadIntegrations(connection).then(
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

  const act = useCallback(
    (report: IntegrationReport) => {
      setPending(report.id);

      actOnIntegration(connection, report).then(
        (overview) => {
          setState({ kind: "loaded", overview });
          setPending(undefined);

          return undefined;
        },
        (cause: unknown) => {
          setState({ kind: "failed", summary: integrationFailureSummary(cause) });
          setPending(undefined);
        },
      );
    },
    [connection],
  );

  return <IntegrationsList state={state} pending={pending} onAct={act} />;
}

export function IntegrationsList(props: IntegrationsListProps): ReactElement {
  const { pending, onAct } = props;

  return (
    <SettingsGroup section={INTEGRATIONS_HOOKS_SECTION}>
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
        Match.when({ kind: "loaded" }, (loaded) =>
          loaded.overview.integrations.map((report) => (
            <IntegrationRow
              key={report.id}
              report={report}
              isPending={report.id === pending}
              onAct={onAct}
            />
          )),
        ),
        Match.exhaustive,
      )}
    </SettingsGroup>
  );
}

function IntegrationRow(props: {
  readonly report: IntegrationReport;
  readonly isPending: boolean;
  readonly onAct: (report: IntegrationReport) => void;
}): ReactElement {
  const { report, onAct } = props;
  const action = integrationAction(report);
  const status = integrationStatusText(report);
  const isUnreadable = report.status.kind === "unreadable";

  const act = useCallback(() => {
    onAct(report);
  }, [onAct, report]);

  const logo = useMemo(() => <IntegrationLogo integration={report.id} />, [report.id]);

  const description = useMemo(
    () => (
      <span title={report.configPath}>
        {integrationCapabilitiesText(report)}
        {status === undefined ? undefined : (
          <>
            {" · "}
            <span className={cn(isUnreadable && "text-destructive")}>{status}</span>
          </>
        )}
      </span>
    ),
    [isUnreadable, report, status],
  );

  return (
    <SettingRow label={report.name} media={logo} description={description}>
      <Button
        type="button"
        variant={ACTION_VARIANT[action]}
        size="sm"
        onClick={act}
        disabled={props.isPending || isUnreadable}
        aria-label={`${ACTION_LABEL[action]} ${report.name}`}
        className="min-w-16"
      >
        {props.isPending ? <Spinner /> : ACTION_LABEL[action]}
      </Button>
    </SettingRow>
  );
}
