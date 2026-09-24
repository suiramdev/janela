import {
  identifier,
  instant,
  isWebURL,
  type ForgeItem,
  type ForgeOverview,
  type ForgeRepository,
  type ForgeState,
  type SessionForgeLink,
} from "@janela/core";
import { Result, Schema } from "effect";

const WireInstant = Schema.String.check(
  Schema.makeFilter<string>((raw) => !Number.isNaN(Date.parse(raw))),
);

const WireURL = Schema.String.check(Schema.makeFilter<string>(isWebURL));

const WireHost = Schema.Literals(["gitHub", "gitLab"]);

const WireState = Schema.Literals(["open", "merged", "closed"]);

const WireItem = Schema.Struct({
  kind: Schema.Literals(["issue", "pullRequest"]),
  number: Schema.Int,
  title: Schema.String,
  state: WireState,
  isDraft: Schema.Boolean,
  url: WireURL,
  author: Schema.optionalKey(Schema.String),
  assignees: Schema.Array(Schema.String),
  reviewers: Schema.Array(Schema.String),
  labels: Schema.Array(Schema.String),
  branch: Schema.optionalKey(Schema.String),
  updatedAt: WireInstant,
});

const WireRepository = Schema.Struct({
  projectID: Schema.String.check(Schema.isGUID()),
  host: WireHost,
  name: Schema.String,
  isAvailable: Schema.Boolean,
  viewer: Schema.optionalKey(Schema.String),
  items: Schema.Array(WireItem),
});

const WireForgeState = Schema.Struct({
  host: WireHost,
  pullRequest: Schema.optionalKey(
    Schema.Struct({
      number: Schema.Int,
      title: Schema.String,
      state: WireState,
      isDraft: Schema.Boolean,
      url: WireURL,
    }),
  ),
  checks: Schema.optionalKey(Schema.Literals(["passing", "failing", "running", "none"])),
  refreshedAt: WireInstant,
});

const WireSessionLink = Schema.Struct({
  sessionID: Schema.String.check(Schema.isGUID()),
  branch: Schema.optionalKey(Schema.String),
  forge: Schema.optionalKey(WireForgeState),
});

const WireOverview = Schema.Struct({
  repositories: Schema.Array(WireRepository),
  sessions: Schema.Array(WireSessionLink),
});

const decodeOverviewText = Schema.decodeUnknownResult(Schema.fromJsonString(WireOverview));

type WireItem = typeof WireItem.Type;

type WireRepository = typeof WireRepository.Type;

type WireSessionLink = typeof WireSessionLink.Type;

export function serializeForgeOverview(overview: ForgeOverview): string {
  return JSON.stringify(overview);
}

export function parseForgeOverview(text: string): ForgeOverview {
  const decoded = Result.mapError(
    decodeOverviewText(text),
    (error) => new TypeError(`not a forge overview: ${error.message}`),
  );

  const wire = Result.getOrThrowWith(decoded, (error) => error);

  return {
    repositories: wire.repositories.map(parsedRepository),
    sessions: wire.sessions.map(parsedSessionLink),
  };
}

function parsedItem(item: WireItem): ForgeItem {
  const { updatedAt, ...rest } = item;

  return { ...rest, updatedAt: instant(updatedAt) };
}

function parsedRepository(repository: WireRepository): ForgeRepository {
  const { projectID, items, ...rest } = repository;

  return { ...rest, projectID: identifier<"Project">(projectID), items: items.map(parsedItem) };
}

function parsedSessionLink(link: WireSessionLink): SessionForgeLink {
  const { sessionID, forge, ...rest } = link;
  const parsed: SessionForgeLink = { ...rest, sessionID: identifier<"Session">(sessionID) };

  if (forge === undefined) return parsed;

  const state: ForgeState = { ...forge, refreshedAt: instant(forge.refreshedAt) };

  return { ...parsed, forge: state };
}
