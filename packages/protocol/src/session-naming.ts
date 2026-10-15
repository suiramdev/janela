import {
  MAX_SESSION_NAMER_MODEL_LENGTH,
  SESSION_NAMER_IDS,
  type SessionNamerReport,
  type SessionNaming,
  type SessionNamingOverview,
} from "@janela/core";
import { Option, Result, Schema } from "effect";

const SessionNamingSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("off") }),
  Schema.Struct({
    kind: Schema.Literal("agent"),
    agent: Schema.Literals(SESSION_NAMER_IDS),
    model: Schema.optionalKey(
      Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(MAX_SESSION_NAMER_MODEL_LENGTH)),
    ),
  }),
]);

const SessionNamerReportSchema = Schema.Struct({
  id: Schema.Literals(SESSION_NAMER_IDS),
  name: Schema.String,
  executable: Schema.String,
  isAvailable: Schema.Boolean,
  defaultModel: Schema.optionalKey(Schema.String),
});

const SessionNamingOverviewSchema = Schema.Struct({
  naming: SessionNamingSchema,
  namers: Schema.Array(SessionNamerReportSchema),
});

const decodeNaming = Schema.decodeUnknownOption(SessionNamingSchema);

const decodeOverviewText = Schema.decodeUnknownResult(
  Schema.fromJsonString(SessionNamingOverviewSchema),
);

export function decodeSessionNaming(naming: SessionNaming): SessionNaming | undefined {
  return Option.getOrUndefined(decodeNaming(naming));
}

export function serializeSessionNamingOverview(overview: SessionNamingOverview): string {
  return JSON.stringify({
    naming: overview.naming,
    namers: overview.namers.map((report): SessionNamerReport =>
      report.defaultModel === undefined
        ? {
            id: report.id,
            name: report.name,
            executable: report.executable,
            isAvailable: report.isAvailable,
          }
        : {
            id: report.id,
            name: report.name,
            executable: report.executable,
            isAvailable: report.isAvailable,
            defaultModel: report.defaultModel,
          },
    ),
  });
}

export function parseSessionNamingOverview(text: string): SessionNamingOverview {
  const decoded = Result.mapError(
    decodeOverviewText(text),
    (error) => new TypeError(`not a session naming overview: ${error.message}`),
  );

  return Result.getOrThrowWith(decoded, (error) => error);
}
