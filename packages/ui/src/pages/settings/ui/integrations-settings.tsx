import type { IntegrationID, IntegrationReport } from "@janela/core";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  Spinner,
} from "@janela/design";
import { Match } from "effect";
import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import {
  type IntegrationAction,
  type IntegrationRequesting,
  type IntegrationsState,
  actOnIntegration,
  integrationAction,
  integrationBadgeVariant,
  integrationFailureSummary,
  integrationStatusText,
  loadIntegrations,
} from "../model/integrations.ts";
import { INTEGRATIONS_HOOKS_SECTION } from "../model/settings-index.ts";
import { Section } from "./pane.tsx";

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
    <Section section={INTEGRATIONS_HOOKS_SECTION}>
      {Match.value(props.state).pipe(
        Match.when({ kind: "loading" }, () => <Spinner className="text-muted-foreground" />),
        Match.when({ kind: "failed" }, (failed) => (
          <Alert variant="destructive">
            <AlertDescription>{failed.summary}</AlertDescription>
          </Alert>
        )),
        Match.when({ kind: "loaded" }, (loaded) => (
          <ItemGroup>
            {loaded.overview.integrations.map((report) => (
              <IntegrationRow
                key={report.id}
                report={report}
                isPending={report.id === pending}
                onAct={onAct}
              />
            ))}
          </ItemGroup>
        )),
        Match.exhaustive,
      )}
    </Section>
  );
}

function IntegrationRow(props: {
  readonly report: IntegrationReport;
  readonly isPending: boolean;
  readonly onAct: (report: IntegrationReport) => void;
}): ReactElement {
  const { report, onAct } = props;

  const act = useCallback(() => {
    onAct(report);
  }, [onAct, report]);

  return (
    <Item size="sm" variant="outline">
      <ItemContent>
        <ItemTitle>{report.name}</ItemTitle>
        <ItemDescription className="font-mono text-xs">{report.configPath}</ItemDescription>
        <ul className="text-muted-foreground text-xs leading-relaxed">
          {report.reports.map((reported) => (
            <li key={reported}>{reported}</li>
          ))}
        </ul>
      </ItemContent>
      <ItemActions>
        <Badge variant={integrationBadgeVariant(report)}>{integrationStatusText(report)}</Badge>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={act}
          disabled={props.isPending || report.status.kind === "unreadable"}
        >
          {ACTION_LABEL[integrationAction(report)]}
        </Button>
      </ItemActions>
    </Item>
  );
}
