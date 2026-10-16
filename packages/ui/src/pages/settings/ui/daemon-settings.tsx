import type { Session, TerminalID, TerminalState } from "@janela/core";
import { Alert, AlertDescription, AlertTitle, Button } from "@janela/design";
import type { ReactElement } from "react";
import { useCallback, useState } from "react";

import {
  NO_SERVICE_CONFIRMATION,
  SERVICE_CONFIRM_TITLE,
  SERVICE_REQUEST_TITLE,
  type BackgroundServiceControlling,
  type ServiceConfirmation,
  type ServiceRequest,
  type ServiceStopCost,
  serviceControlReducer,
  serviceRequestCost,
  serviceStopCost,
} from "../../../shared/model/index.ts";
import { DAEMON_SECTION } from "../model/settings-index.ts";
import { SettingRow, SettingsGroup } from "./pane.tsx";

export interface SettingsDaemonProps {
  readonly sessions: readonly Session[];
  readonly terminalStates: Readonly<Record<TerminalID, TerminalState>>;
  readonly service: BackgroundServiceControlling | undefined;
}

export const DAEMON_STOP_HINT = "Ends every live terminal. Quitting Janela never does.";

export function SettingsDaemon(props: SettingsDaemonProps): ReactElement {
  const { service } = props;
  const cost = serviceStopCost(props.sessions, props.terminalStates);

  return (
    <SettingsGroup section={DAEMON_SECTION}>
      <SettingRow label="Running now">
        <span className="text-muted-foreground text-xs">{cost.sentence}</span>
      </SettingRow>

      {service === undefined ? undefined : <ServiceStopRow cost={cost} service={service} />}
    </SettingsGroup>
  );
}

function ServiceStopRow(props: {
  readonly cost: ServiceStopCost;
  readonly service: BackgroundServiceControlling;
}): ReactElement {
  const { cost, service } = props;
  const [confirmation, setConfirmation] = useState<ServiceConfirmation>(NO_SERVICE_CONFIRMATION);

  const perform = useCallback(
    (request: ServiceRequest) => {
      if (request === "stop") service.stop();
      else service.stopAndUnregister();
    },
    [service],
  );

  const request = useCallback((requested: ServiceRequest) => {
    setConfirmation(
      serviceControlReducer(NO_SERVICE_CONFIRMATION, { kind: "request", request: requested })
        .confirmation,
    );
  }, []);

  const confirm = useCallback(
    (requested: ServiceRequest) => {
      setConfirmation((current) => {
        const outcome = serviceControlReducer(current, { kind: "confirm", request: requested });

        if (outcome.perform !== undefined) perform(outcome.perform);

        return outcome.confirmation;
      });
    },
    [perform],
  );

  const cancel = useCallback(() => {
    setConfirmation(
      serviceControlReducer(NO_SERVICE_CONFIRMATION, { kind: "cancel" }).confirmation,
    );
  }, []);

  return (
    <div className="flex flex-col pb-2.5">
      <SettingRow label="Shut down" description={DAEMON_STOP_HINT}>
        <ServiceRequestButton request="stop" onRequest={request} />
        <ServiceRequestButton request="stopAndUnregister" onRequest={request} />
      </SettingRow>
      {confirmation.pending === undefined ? undefined : (
        <ServiceCostConfirmation
          request={confirmation.pending}
          cost={cost}
          onConfirm={confirm}
          onCancel={cancel}
        />
      )}
    </div>
  );
}

function ServiceRequestButton(props: {
  readonly request: ServiceRequest;
  readonly onRequest: (request: ServiceRequest) => void;
}): ReactElement {
  const { request, onRequest } = props;

  const press = useCallback(() => {
    onRequest(request);
  }, [onRequest, request]);

  return (
    <Button type="button" variant="outline" size="sm" onClick={press}>
      {SERVICE_REQUEST_TITLE[request]}
    </Button>
  );
}

export function ServiceCostConfirmation(props: {
  readonly request: ServiceRequest;
  readonly cost: ServiceStopCost;
  readonly onConfirm: (request: ServiceRequest) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const { request, onConfirm } = props;

  const confirm = useCallback(() => {
    onConfirm(request);
  }, [onConfirm, request]);

  return (
    <Alert variant="destructive">
      <AlertTitle>{SERVICE_REQUEST_TITLE[request]}</AlertTitle>
      <AlertDescription>{serviceRequestCost(request, props.cost)}</AlertDescription>
      <div className="mt-2 flex gap-2">
        <Button type="button" variant="destructive" size="sm" onClick={confirm}>
          {SERVICE_CONFIRM_TITLE[request]}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={props.onCancel}>
          Keep it running
        </Button>
      </div>
    </Alert>
  );
}
