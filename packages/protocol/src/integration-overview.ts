import { INTEGRATION_IDS, type IntegrationOverview, type IntegrationReport } from "@janela/core";
import { Result, Schema } from "effect";

const IntegrationStatusSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("installed") }),
  Schema.Struct({ kind: Schema.Literal("outdated") }),
  Schema.Struct({ kind: Schema.Literal("absent") }),
  Schema.Struct({ kind: Schema.Literal("unreadable"), reason: Schema.String }),
]);

const IntegrationReportSchema = Schema.Struct({
  id: Schema.Literals(INTEGRATION_IDS),
  name: Schema.String,
  executable: Schema.String,
  isAvailable: Schema.Boolean,
  configPath: Schema.String,
  reports: Schema.Array(Schema.String),
  status: IntegrationStatusSchema,
});

const IntegrationOverviewSchema = Schema.Struct({
  integrations: Schema.Array(IntegrationReportSchema),
});

const decodeOverviewText = Schema.decodeUnknownResult(
  Schema.fromJsonString(IntegrationOverviewSchema),
);

export function serializeIntegrationOverview(overview: IntegrationOverview): string {
  return JSON.stringify({
    integrations: overview.integrations.map((report): IntegrationReport => ({
      id: report.id,
      name: report.name,
      executable: report.executable,
      isAvailable: report.isAvailable,
      configPath: report.configPath,
      reports: [...report.reports],
      status: report.status,
    })),
  });
}

export function parseIntegrationOverview(text: string): IntegrationOverview {
  const decoded = Result.mapError(
    decodeOverviewText(text),
    (error) => new TypeError(`not an integration overview: ${error.message}`),
  );

  return Result.getOrThrowWith(decoded, (error) => error);
}
