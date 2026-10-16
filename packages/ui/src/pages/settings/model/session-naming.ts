import type { DaemonConnection } from "@janela/client";
import type {
  SessionNamerCatalog,
  SessionNamerID,
  SessionNamerReport,
  SessionNaming,
  SessionNamingOverview,
} from "@janela/core";
import { isSessionNamerID } from "@janela/core";
import { parseSessionNamerCatalog, parseSessionNamingOverview } from "@janela/protocol";

export type NamerChoice = "off" | SessionNamerID;

export interface NamerOption {
  readonly value: NamerChoice;
  readonly title: string;
  readonly isDisabled: boolean;
}

export interface SuggestionItem {
  readonly value: string;
  readonly label: string;
  readonly detail?: string;
}

export type SessionNamingState =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly overview: SessionNamingOverview }
  | { readonly kind: "failed"; readonly summary: string };

export type NamerCatalogState =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly catalog: SessionNamerCatalog }
  | { readonly kind: "failed"; readonly summary: string };

type AgentNaming = Extract<SessionNaming, { readonly kind: "agent" }>;

type AgentNamingDraft = { -readonly [Field in keyof AgentNaming]: AgentNaming[Field] };

export type SessionNamingRequesting = Pick<DaemonConnection, "request">;

class OverviewMissing extends TypeError {
  constructor() {
    super("the daemon answered the session naming request without an overview");
    this.name = "OverviewMissing";
  }
}

class CatalogMissing extends TypeError {
  constructor() {
    super("the daemon answered the namer models request without a catalog");
    this.name = "CatalogMissing";
  }
}

const OFF_OPTION: NamerOption = { value: "off", title: "Off", isDisabled: false };

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

export async function loadNamerCatalog(
  connection: SessionNamingRequesting,
  agent: SessionNamerID,
): Promise<SessionNamerCatalog> {
  const text = await connection.request({ type: "sessionNamerModels", agent });

  if (text === undefined) throw new CatalogMissing();

  return parseSessionNamerCatalog(text);
}

export function namingModel(naming: SessionNaming): string {
  return naming.kind === "off" ? "" : (naming.model ?? "");
}

export function namingEffort(naming: SessionNaming): string {
  return naming.kind === "off" ? "" : (naming.effort ?? "");
}

export function namingFor(choice: NamerChoice, model: string, effort = ""): SessionNaming {
  if (!isSessionNamerID(choice)) return { kind: "off" };

  const trimmedModel = model.trim();
  const trimmedEffort = effort.trim();
  const naming: AgentNamingDraft = { kind: "agent", agent: choice };

  if (trimmedModel !== "") naming.model = trimmedModel;

  if (trimmedEffort !== "") naming.effort = trimmedEffort;

  return naming;
}

export function namerOptions(overview: SessionNamingOverview): readonly NamerOption[] {
  const chosen = overview.naming.kind === "off" ? undefined : overview.naming.agent;

  return [OFF_OPTION, ...overview.namers.map((report) => namerOption(report, chosen))];
}

export function chosenNamer(overview: SessionNamingOverview): SessionNamerReport | undefined {
  const { naming } = overview;

  return naming.kind === "off"
    ? undefined
    : overview.namers.find((report) => report.id === naming.agent);
}

export function modelItems(catalog: SessionNamerCatalog | undefined): readonly SuggestionItem[] {
  return (catalog?.models ?? []).map((model) =>
    model.name === model.id
      ? { value: model.id, label: model.id }
      : { value: model.id, label: model.name, detail: model.id },
  );
}

export function effortItems(
  catalog: SessionNamerCatalog | undefined,
  model: string,
): readonly SuggestionItem[] {
  const models = catalog?.models ?? [];
  const chosen = models.find((candidate) => candidate.id === model);
  const efforts =
    chosen === undefined ? models.flatMap((candidate) => candidate.efforts) : chosen.efforts;

  return [...new Set(efforts)].map((effort) => ({ value: effort, label: effort }));
}

function namerOption(report: SessionNamerReport, chosen: SessionNamerID | undefined): NamerOption {
  return {
    value: report.id,
    title: report.isAvailable ? report.name : `${report.name} (not installed)`,
    isDisabled: !report.isAvailable && report.id !== chosen,
  };
}
