import { createHash } from "node:crypto";

import { Option, Schema } from "effect";

export interface CodexTrustSubject {
  readonly label: string;
  readonly command: string;
  readonly timeout: number;
  readonly matcher?: string;
}

interface DraftJsonObject {
  [key: string]: Schema.Json;
}

export const TRUST_HASH_ALGORITHM = "sha256";

const MINIMUM_TIMEOUT = 1;

const decodeArray = Schema.decodeUnknownOption(Schema.Array(Schema.Json));

const decodeObject = Schema.decodeUnknownOption(Schema.JsonObject);

export function codexTrustHash(subject: CodexTrustSubject): string {
  const hooks = [
    {
      async: false,
      command: subject.command,
      timeout: Math.max(MINIMUM_TIMEOUT, subject.timeout),
      type: "command",
    },
  ];
  const payload =
    subject.matcher === undefined
      ? { event_name: subject.label, hooks }
      : { event_name: subject.label, hooks, matcher: subject.matcher };
  const digest = createHash(TRUST_HASH_ALGORITHM)
    .update(JSON.stringify(sortKeys(payload)))
    .digest("hex");

  return `${TRUST_HASH_ALGORITHM}:${digest}`;
}

export function trustKey(
  hooksPath: string,
  label: string,
  groupIndex: number,
  handlerIndex: number,
): string {
  return `${hooksPath}:${label}:${groupIndex}:${handlerIndex}`;
}

function sortKeys(value: Schema.Json): Schema.Json {
  const members = Option.getOrUndefined(decodeArray(value));

  if (members !== undefined) return members.map(sortKeys);

  const entries = Option.getOrUndefined(decodeObject(value));

  if (entries === undefined) return value;

  const sorted: DraftJsonObject = {};

  for (const key of Object.keys(entries).toSorted()) {
    const member = entries[key];

    if (member !== undefined) sorted[key] = sortKeys(member);
  }

  return sorted;
}
