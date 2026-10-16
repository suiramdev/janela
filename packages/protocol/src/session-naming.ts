import {
  MAX_SESSION_NAMER_CATALOG_MODELS,
  MAX_SESSION_NAMER_EFFORT_LENGTH,
  MAX_SESSION_NAMER_MODEL_LENGTH,
  SESSION_NAMER_EFFORT_PATTERN,
  SESSION_NAMER_IDS,
  type SessionNamerCatalog,
  type SessionNamerID,
  type SessionNamerReport,
  type SessionNaming,
  type SessionNamingOverview,
} from "@janela/core";
import { Option, Result, Schema } from "effect";

const ModelSchema = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_SESSION_NAMER_MODEL_LENGTH),
);

const EffortSchema = Schema.String.check(
  Schema.isMaxLength(MAX_SESSION_NAMER_EFFORT_LENGTH),
  Schema.isPattern(SESSION_NAMER_EFFORT_PATTERN),
);

const SessionNamingSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("off") }),
  Schema.Struct({
    kind: Schema.Literal("agent"),
    agent: Schema.Literals(SESSION_NAMER_IDS),
    model: Schema.optionalKey(ModelSchema),
    effort: Schema.optionalKey(EffortSchema),
  }),
]);

const SessionNamerCatalogSchema = Schema.Struct({
  agent: Schema.Literals(SESSION_NAMER_IDS),
  models: Schema.Array(
    Schema.Struct({
      id: ModelSchema,
      name: Schema.String,
      efforts: Schema.Array(EffortSchema),
    }),
  ).check(Schema.isMaxLength(MAX_SESSION_NAMER_CATALOG_MODELS)),
});

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

const decodeCatalogText = Schema.decodeUnknownResult(
  Schema.fromJsonString(SessionNamerCatalogSchema),
);

const decodeNamerID = Schema.decodeUnknownOption(Schema.Literals(SESSION_NAMER_IDS));

export function decodeSessionNamerID(agent: string): SessionNamerID | undefined {
  return Option.getOrUndefined(decodeNamerID(agent));
}

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

export function serializeSessionNamerCatalog(catalog: SessionNamerCatalog): string {
  return JSON.stringify({
    agent: catalog.agent,
    models: catalog.models.map((model) => ({
      id: model.id,
      name: model.name,
      efforts: [...model.efforts],
    })),
  });
}

export function parseSessionNamerCatalog(text: string): SessionNamerCatalog {
  const decoded = Result.mapError(
    decodeCatalogText(text),
    (error) => new TypeError(`not a session namer catalog: ${error.message}`),
  );

  return Result.getOrThrowWith(decoded, (error) => error);
}
