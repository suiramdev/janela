import { RequestFailed, type DaemonConnection } from "@janela/client";
import type { IntegrationID, IntegrationOverview, IntegrationReport } from "@janela/core";
import { parseIntegrationOverview } from "@janela/protocol";
import { Match } from "effect";

export type IntegrationAction = "install" | "update" | "remove";

export type IntegrationBadgeVariant = "secondary" | "outline" | "destructive";

export type IntegrationsState =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly overview: IntegrationOverview }
  | { readonly kind: "failed"; readonly summary: string };

export type IntegrationRequesting = Pick<DaemonConnection, "request">;

class OverviewMissing extends TypeError {
  constructor() {
    super("the daemon answered the integrations request without an overview");
    this.name = "OverviewMissing";
  }
}

const UNREACHABLE_SUMMARY = "Could not reach the background service.";

export async function loadIntegrations(
  connection: IntegrationRequesting,
): Promise<IntegrationOverview> {
  const text = await connection.request({ type: "integrations" });

  if (text === undefined) throw new OverviewMissing();

  return parseIntegrationOverview(text);
}

export async function installIntegration(
  connection: IntegrationRequesting,
  integrationID: IntegrationID,
): Promise<void> {
  await connection.request({ type: "installIntegration", integrationID });
}

export async function removeIntegration(
  connection: IntegrationRequesting,
  integrationID: IntegrationID,
): Promise<void> {
  await connection.request({ type: "removeIntegration", integrationID });
}

export async function actOnIntegration(
  connection: IntegrationRequesting,
  report: IntegrationReport,
): Promise<IntegrationOverview> {
  await (integrationAction(report) === "remove"
    ? removeIntegration(connection, report.id)
    : installIntegration(connection, report.id));

  return loadIntegrations(connection);
}

export function integrationAction(report: IntegrationReport): IntegrationAction {
  return Match.value(report.status).pipe(
    Match.when({ kind: "installed" }, (): IntegrationAction => "remove"),
    Match.when({ kind: "outdated" }, (): IntegrationAction => "update"),
    Match.when({ kind: "absent" }, (): IntegrationAction => "install"),
    Match.when({ kind: "unreadable" }, (): IntegrationAction => "install"),
    Match.exhaustive,
  );
}

export function integrationStatusText(report: IntegrationReport): string {
  const status = report.status;

  if (status.kind === "unreadable") return `Unreadable: ${status.reason}`;

  if (!report.isAvailable) return `${report.executable} is not on your PATH`;

  return Match.value(status).pipe(
    Match.when({ kind: "installed" }, () => "Installed"),
    Match.when({ kind: "outdated" }, () => "Needs updating"),
    Match.when({ kind: "absent" }, () => "Not installed"),
    Match.exhaustive,
  );
}

export function integrationBadgeVariant(report: IntegrationReport): IntegrationBadgeVariant {
  if (report.status.kind === "unreadable") return "destructive";

  if (!report.isAvailable) return "outline";

  return report.status.kind === "installed" ? "secondary" : "outline";
}

export function integrationFailureSummary(cause: unknown): string {
  return cause instanceof RequestFailed ? cause.failure.summary : UNREACHABLE_SUMMARY;
}
