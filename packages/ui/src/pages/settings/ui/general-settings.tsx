import type {
  LaunchProfile,
  LaunchProfileAvailability,
  LaunchProfileID,
  Session,
  TerminalID,
  TerminalState,
} from "@janela/core";
import { Alert, AlertDescription, AlertTitle, Button, FieldDescription } from "@janela/design";
import type { ReactElement } from "react";
import { useCallback, useState } from "react";

import {
  type BackgroundServiceControlling,
  type GlobalSettings,
  isConfirmationSilenced,
  withDefaultProfileID,
  withSilencedConfirmation,
} from "../../../shared/model/index.ts";
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
import { ProfileSelect, Section, SwitchField } from "./fields.tsx";

export interface SettingsGeneralProps {
  readonly settings: GlobalSettings;
  readonly onChange: (settings: GlobalSettings) => void;
  readonly profiles: readonly LaunchProfile[];
  readonly availability: LaunchProfileAvailability;
  readonly sessions: readonly Session[];
  readonly terminalStates: Readonly<Record<TerminalID, TerminalState>>;
  readonly service: BackgroundServiceControlling | undefined;
}

export function SettingsGeneral(props: SettingsGeneralProps): ReactElement {
  const { settings, onChange, service } = props;
  const cost = serviceStopCost(props.sessions, props.terminalStates);

  const changeDefaultProfile = useCallback(
    (profileID: LaunchProfileID | undefined) => {
      onChange(withDefaultProfileID(settings, profileID));
    },
    [onChange, settings],
  );

  const changeAsksBeforeClosing = useCallback(
    (asks: boolean) => {
      onChange(withSilencedConfirmation(settings, "closeTerminals", !asks));
    },
    [onChange, settings],
  );

  return (
    <div className="flex flex-col gap-6">
      <Section title="New terminals">
        <ProfileSelect
          label="Default launch profile"
          profiles={props.profiles}
          availability={props.availability}
          value={settings.defaultProfileID}
          onChange={changeDefaultProfile}
          unsetTitle="Your login shell"
          hint="Used when a project has not chosen one of its own. A project's choice always wins."
        />
      </Section>

      <Section title="Confirmations">
        <SwitchField
          label="Ask before closing a running terminal"
          isOn={!isConfirmationSilenced(settings, "closeTerminals")}
          onChange={changeAsksBeforeClosing}
          hint="Closing a pane or a tab ends the programs in it. Idle and finished terminals never ask."
        />
      </Section>

      {service === undefined ? undefined : (
        <BackgroundServiceSection cost={cost} service={service} />
      )}
    </div>
  );
}

function BackgroundServiceSection(props: {
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
    <Section
      title="Background service"
      hint="janelad runs your terminals, which is why they survive closing the window. It exits on its own when nothing is live."
    >
      <FieldDescription>Running now: {cost.sentence}.</FieldDescription>
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
