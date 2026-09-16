import type { Session, TerminalID, TerminalState } from "@janela/core";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  FieldDescription,
  Item,
  ItemContent,
  ItemTitle,
} from "@janela/design";
import type { ReactElement } from "react";
import { useCallback, useState } from "react";

import type { BackgroundServiceControlling } from "../../../shared/model/index.ts";
import {
  NO_SERVICE_CONFIRMATION,
  SERVICE_CONFIRM_TITLE,
  SERVICE_REQUEST_TITLE,
  type ServiceConfirmation,
  type ServiceRequest,
  type ServiceStopCost,
  serviceControlReducer,
  serviceRequestCost,
  serviceStopCost,
} from "../model/background-service.ts";
import { DAEMON_STATE_SECTION, DAEMON_STOP_SECTION } from "../model/settings-index.ts";
import { Section } from "./pane.tsx";

export interface SettingsDaemonProps {
  readonly sessions: readonly Session[];
  readonly terminalStates: Readonly<Record<TerminalID, TerminalState>>;
  readonly service: BackgroundServiceControlling | undefined;
}

export function SettingsDaemon(props: SettingsDaemonProps): ReactElement {
  const { service } = props;
  const cost = serviceStopCost(props.sessions, props.terminalStates);

  return (
    <>
      <Section section={DAEMON_STATE_SECTION}>
        <Item variant="muted" size="sm">
          <ItemContent>
            <ItemTitle>{cost.sentence}</ItemTitle>
          </ItemContent>
        </Item>
      </Section>

      {service === undefined ? undefined : <ServiceStopSection cost={cost} service={service} />}
    </>
  );
}

function ServiceStopSection(props: {
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
    <Section section={DAEMON_STOP_SECTION}>
      <div className="flex gap-2">
        <ServiceRequestButton request="stop" onRequest={request} />
        <ServiceRequestButton request="stopAndUnregister" onRequest={request} />
      </div>
      {confirmation.pending === undefined ? undefined : (
        <ServiceCostConfirmation
          request={confirmation.pending}
          cost={cost}
          onConfirm={confirm}
          onCancel={cancel}
        />
      )}
      <FieldDescription>
        Quitting Janela does not stop it. That is the point: a terminal you started keeps running
        until you end it or the daemon has nothing left to run.
      </FieldDescription>
    </Section>
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
