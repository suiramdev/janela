import type { DaemonConnection } from "@janela/client";
import type {
  SessionNamerID,
  SessionNamerReport,
  SessionNaming,
  SessionNamingOverview,
} from "@janela/core";
import { isSessionNamerID } from "@janela/core";
import { parseSessionNamingOverview } from "@janela/protocol";

export type NamerChoice = "off" | SessionNamerID;

export interface NamerOption {
  readonly value: NamerChoice;
  readonly title: string;
  readonly detail: string;
}

export type SessionNamingState =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly overview: SessionNamingOverview }
  | { readonly kind: "failed"; readonly summary: string };

export type SessionNamingRequesting = Pick<DaemonConnection, "request">;

class OverviewMissing extends TypeError {
  constructor() {
    super("the daemon answered the session naming request without an overview");
    this.name = "OverviewMissing";
  }
}

const OFF_OPTION: NamerOption = {
  value: "off",
  title: "Off",
  detail: "Sessions keep the name of their branch or folder until you rename them.",
};

export async function loadSessionNaming(
  connection: SessionNamingRequesting,
): Promise<SessionNamingOverview> {
  const text = await connection.request({ type: "sessionNaming" });

  if (text === undefined) throw new OverviewMissing();

  return parseSessionNamingOverview(text);
}

export async function configureSessionNaming(
  connection: SessionNamingRequesting,
  naming: SessionNaming,
): Promise<SessionNamingOverview> {
  await connection.request({ type: "configureSessionNaming", naming });

  return loadSessionNaming(connection);
}

export function namingModel(naming: SessionNaming): string {
  return naming.kind === "off" ? "" : (naming.model ?? "");
}

export function namingFor(choice: NamerChoice, model: string): SessionNaming {
  if (!isSessionNamerID(choice)) return { kind: "off" };

  const trimmed = model.trim();

  return trimmed === ""
    ? { kind: "agent", agent: choice }
    : { kind: "agent", agent: choice, model: trimmed };
}

export function namerOptions(overview: SessionNamingOverview): readonly NamerOption[] {
  return [OFF_OPTION, ...overview.namers.map(namerOption)];
}

export function chosenNamer(overview: SessionNamingOverview): SessionNamerReport | undefined {
  const { naming } = overview;

  return naming.kind === "off"
    ? undefined
    : overview.namers.find((report) => report.id === naming.agent);
}

function namerOption(report: SessionNamerReport): NamerOption {
  const model = report.defaultModel === undefined ? "its default model" : report.defaultModel;

  return {
    value: report.id,
    title: report.name,
    detail: report.isAvailable
      ? `Runs ${report.executable} with ${model}, no tools and no saved history.`
      : `${report.executable} is not on your PATH, so nothing would be named.`,
  };
}
