import {
  MAX_SESSION_NAMER_CATALOG_MODELS,
  MAX_SESSION_NAMER_EFFORT_LENGTH,
  MAX_SESSION_NAMER_MODEL_LENGTH,
  SESSION_NAMER_EFFORT_PATTERN,
  type SessionNamerID,
  type SessionNamerModel,
} from "@janela/core";
import { Option, Schema } from "effect";

export interface NamerCatalogCommand {
  readonly arguments: readonly string[];
  readonly standardInput?: string;
  readonly parse: (standardOutput: string) => readonly SessionNamerModel[] | undefined;
}

export const NAMER_CATALOG_TIMEOUT_MILLISECONDS = 20_000;

export const MAX_NAMER_CATALOG_OUTPUT_BYTES = 4 * 1024 * 1024;

const decodeJsonLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const optionalField = <Field extends Schema.Top>(field: Field) =>
  Schema.optionalKey(Schema.NullOr(field));

const ClaudeModel = Schema.Struct({
  value: Schema.String,
  displayName: optionalField(Schema.String),
  supportedEffortLevels: optionalField(Schema.Array(Schema.String)),
});

const ClaudeInitializeResponse = Schema.Struct({
  type: Schema.Literal("control_response"),
  response: Schema.Struct({
    subtype: Schema.Literal("success"),
    response: Schema.Struct({ models: Schema.Array(ClaudeModel) }),
  }),
});

const CodexCatalog = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      slug: Schema.String,
      display_name: optionalField(Schema.String),
      visibility: optionalField(Schema.String),
      supported_reasoning_levels: optionalField(
        Schema.Array(Schema.Struct({ effort: Schema.String })),
      ),
    }),
  ),
});

const OmpCatalog = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      selector: Schema.String,
      name: optionalField(Schema.String),
      kind: optionalField(Schema.String),
      thinking: optionalField(Schema.Array(Schema.String)),
    }),
  ),
});

const decodeClaudeResponse = Schema.decodeUnknownOption(ClaudeInitializeResponse);

const decodeCodexCatalog = Schema.decodeUnknownOption(Schema.fromJsonString(CodexCatalog));

const decodeOmpCatalog = Schema.decodeUnknownOption(Schema.fromJsonString(OmpCatalog));

export const CLAUDE_INITIALIZE_REQUEST = `${JSON.stringify({
  type: "control_request",
  request_id: "janela-models",
  request: { subtype: "initialize" },
})}\n`;

const isEffort = (effort: string): boolean =>
  effort.length <= MAX_SESSION_NAMER_EFFORT_LENGTH && SESSION_NAMER_EFFORT_PATTERN.test(effort);

function namerModel(
  id: string,
  name: string | null | undefined,
  efforts: readonly string[],
): SessionNamerModel | undefined {
  const trimmed = id.trim();

  if (trimmed === "" || trimmed.length > MAX_SESSION_NAMER_MODEL_LENGTH) return undefined;

  return {
    id: trimmed,
    name: name === undefined || name === null || name.trim() === "" ? trimmed : name.trim(),
    efforts: [...new Set(efforts.filter(isEffort))],
  };
}

function bounded(models: readonly (SessionNamerModel | undefined)[]): readonly SessionNamerModel[] {
  const seen = new Set<string>();
  const kept: SessionNamerModel[] = [];

  for (const model of models) {
    if (model === undefined || seen.has(model.id)) continue;

    seen.add(model.id);
    kept.push(model);

    if (kept.length === MAX_SESSION_NAMER_CATALOG_MODELS) break;
  }

  return kept;
}

export function parseClaudeCatalog(
  standardOutput: string,
): readonly SessionNamerModel[] | undefined {
  for (const line of standardOutput.split("\n")) {
    const response = Option.getOrUndefined(
      Option.flatMap(decodeJsonLine(line), decodeClaudeResponse),
    );

    if (response === undefined) continue;

    return bounded(
      response.response.response.models.map((model) =>
        namerModel(model.value, model.displayName, model.supportedEffortLevels ?? []),
      ),
    );
  }

  return undefined;
}

export function parseCodexCatalog(
  standardOutput: string,
): readonly SessionNamerModel[] | undefined {
  const catalog = Option.getOrUndefined(decodeCodexCatalog(standardOutput));

  if (catalog === undefined) return undefined;

  return bounded(
    catalog.models
      .filter((model) => (model.visibility ?? "list") === "list")
      .map((model) =>
        namerModel(
          model.slug,
          model.display_name,
          (model.supported_reasoning_levels ?? []).map((level) => level.effort),
        ),
      ),
  );
}

export function parseOmpCatalog(standardOutput: string): readonly SessionNamerModel[] | undefined {
  const catalog = Option.getOrUndefined(decodeOmpCatalog(standardOutput));

  if (catalog === undefined) return undefined;

  return bounded(
    catalog.models
      .filter((model) => (model.kind ?? "chat") === "chat")
      .map((model) => namerModel(model.selector, model.name, model.thinking ?? [])),
  );
}

export const NAMER_CATALOGS: Readonly<Record<SessionNamerID, NamerCatalogCommand>> = {
  claude: {
    arguments: [
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--no-session-persistence",
    ],
    standardInput: CLAUDE_INITIALIZE_REQUEST,
    parse: parseClaudeCatalog,
  },
  codex: { arguments: ["debug", "models"], parse: parseCodexCatalog },
  omp: { arguments: ["models", "--json"], parse: parseOmpCatalog },
};
