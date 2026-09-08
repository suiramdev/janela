import type {
  LaunchProfile,
  LaunchProfileAvailability,
  LaunchProfileID,
  Session,
  TerminalID,
  TerminalState,
} from "@janela/core";
import type { ReactElement } from "react";
import { useCallback, useState } from "react";

import type {
  BackgroundServiceControlling,
  ServiceConfirmation,
  ServiceRequest,
  ServiceStopCost,
} from "./background-service.ts";
import {
  NO_SERVICE_CONFIRMATION,
  SERVICE_CONFIRM_TITLE,
  SERVICE_REQUEST_TITLE,
  serviceControlReducer,
  serviceRequestCost,
  serviceStopCost,
} from "./background-service.ts";
import { Section } from "./controls.tsx";
import type { GlobalSettings } from "./global-settings.ts";
import { withDefaultProfileID } from "./global-settings.ts";
import { ProfileSelect } from "./launch-profile-picker.tsx";
import * as style from "./styles.ts";

/**
 * The General tab: the default profile, and the background service.
 *
 * The service controls live here rather than in a menu because stopping the
 * daemon closes the user's terminals, and a destructive action reachable from a
 * menu with a keyboard shortcut is one that will be hit by accident. Settings is
 * where you go on purpose.
 */

export interface SettingsGeneralProps {
  readonly settings: GlobalSettings;
  readonly onChange: (settings: GlobalSettings) => void;
  readonly profiles: readonly LaunchProfile[];
  readonly availability: LaunchProfileAvailability;
  /** From the mirror, so the cost is what the daemon last reported. */
  readonly sessions: readonly Session[];
  readonly terminalStates: Readonly<Record<TerminalID, TerminalState>>;
  readonly service: BackgroundServiceControlling;
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

  return (
    <div style={style.PANE}>
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

      <BackgroundServiceSection cost={cost} service={service} />
    </div>
  );
}

/**
 * The two controls that end the user's terminals.
 *
 * Neither acts on its first press. Pressing one shows what it would cost — the
 * session and terminal counts from the mirror, in a sentence — and a second,
 * differently-labelled button performs it. That is the whole mechanism behind
 * "never kill a user's terminals to make our lives easier": the app never does
 * this, and the user cannot do it without reading the number first.
 */
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
      <p style={style.HINT}>Running now: {cost.sentence}.</p>
      <div style={style.ROW}>
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
    <button type="button" onClick={press} style={style.BUTTON}>
      {SERVICE_REQUEST_TITLE[request]}
    </button>
  );
}

/**
 * The cost, and the only button that acts.
 *
 * Exported because #29's version-skew banner owes the user exactly this sentence
 * before restarting the daemon, and two implementations of "what you are about to
 * lose" would drift the first time the counting changed.
 */
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
    // A `fieldset` rather than a labelled `role="group"`: it is a named group of
    // controls, which is what the element is for, and the legend gives the
    // confirmation an accessible name without a role attribute.
    <fieldset style={style.COST}>
      <legend style={style.SECTION_HEADING}>{SERVICE_REQUEST_TITLE[request]}</legend>
      <p style={style.COST_SENTENCE}>{serviceRequestCost(request, props.cost)}</p>
      <div style={style.ROW}>
        <button type="button" onClick={confirm} style={style.DESTRUCTIVE_BUTTON}>
          {SERVICE_CONFIRM_TITLE[request]}
        </button>
        <button type="button" onClick={props.onCancel} style={style.BUTTON}>
          Keep it running
        </button>
      </div>
    </fieldset>
  );
}
