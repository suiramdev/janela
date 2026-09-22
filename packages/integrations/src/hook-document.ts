import type { IntegrationStatus } from "@janela/core";
import { Option, Schema } from "effect";

import { isJanelaHookCommand } from "./report-command.ts";

export interface HookHandler {
  readonly type: "command";
  readonly command: string;
  readonly timeout?: number;
}

export interface HookEntry {
  readonly matcher?: string;
  readonly hooks: readonly HookHandler[];
}

export interface HookPlan {
  readonly event: string;
  readonly entry: HookEntry;
}

export interface HookGroups {
  readonly [event: string]: readonly Schema.Json[];
}

export interface HookDocument {
  readonly root: Schema.JsonObject;
  readonly groups: HookGroups;
}

interface StoredHandler {
  readonly type: string;
  readonly command: string;
  readonly timeout?: number;
}

export interface StoredEntry {
  readonly matcher?: string;
  readonly hooks: readonly StoredHandler[];
}

interface DraftJsonObject {
  [key: string]: Schema.Json;
}

interface DraftHookGroups {
  [event: string]: Schema.Json[];
}

export const HOOKS_KEY = "hooks";

const decodeRoot = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.JsonObject));

const decodeGroups = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.Array(Schema.Json)),
);

const decodeEntry = Schema.decodeUnknownOption(
  Schema.Struct({
    matcher: Schema.optionalKey(Schema.String),
    hooks: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        command: Schema.String,
        timeout: Schema.optionalKey(Schema.Number),
      }),
    ),
  }),
);

export function parseHookDocument(text: string): HookDocument | undefined {
  const root = Option.getOrUndefined(decodeRoot(text));

  if (root === undefined) return undefined;

  const stored = root[HOOKS_KEY];

  if (stored === undefined) return { root, groups: {} };

  const groups = Option.getOrUndefined(decodeGroups(stored));

  return groups === undefined ? undefined : { root, groups };
}

export function janelaEntry(value: Schema.Json): StoredEntry | undefined {
  const entry = Option.getOrUndefined(decodeEntry(value));

  if (entry === undefined || entry.hooks.length === 0) return undefined;

  return entry.hooks.every((handler) => isJanelaHookCommand(handler.command)) ? entry : undefined;
}

export function withJanelaHooks(document: HookDocument, plans: readonly HookPlan[]): HookDocument {
  const groups = strippedGroups(document);

  for (const plan of plans) {
    const existing = groups[plan.event];
    const entry = entryValue(plan.entry);

    if (existing === undefined) groups[plan.event] = [entry];
    else existing.push(entry);
  }

  return { root: { ...document.root, [HOOKS_KEY]: groups }, groups };
}

export function withoutJanelaHooks(document: HookDocument): Schema.JsonObject {
  const groups = strippedGroups(document);
  const remaining = Object.fromEntries(
    Object.entries(groups).filter(([, entries]) => entries.length > 0),
  );

  const root: DraftJsonObject = {};

  for (const [key, value] of Object.entries(document.root)) {
    if (key !== HOOKS_KEY) root[key] = value;
    else if (Object.keys(remaining).length > 0) root[HOOKS_KEY] = remaining;
  }

  return root;
}

export function hookStatus(document: HookDocument, plans: readonly HookPlan[]): IntegrationStatus {
  let planned = 0;
  let matched = 0;

  for (const plan of plans) {
    const mine = (document.groups[plan.event] ?? [])
      .map(janelaEntry)
      .filter((entry) => entry !== undefined);

    const only = mine.length === 1 ? mine[0] : undefined;

    planned += mine.length;

    if (only !== undefined && isSameEntry(only, plan.entry)) matched += 1;
  }

  const stray = Object.entries(document.groups)
    .filter(([event]) => !plans.some((plan) => plan.event === event))
    .reduce(
      (total, [, entries]) =>
        total + entries.filter((entry) => janelaEntry(entry) !== undefined).length,
      0,
    );

  if (planned === 0 && stray === 0) return { kind: "absent" };

  return matched === plans.length && planned === plans.length && stray === 0
    ? { kind: "installed" }
    : { kind: "outdated" };
}

export function serializeHookDocument(root: Schema.JsonObject): string {
  return `${JSON.stringify(root, undefined, 2)}\n`;
}

function entryValue(entry: HookEntry): Schema.JsonObject {
  const hooks = entry.hooks.map(handlerValue);

  return entry.matcher === undefined ? { hooks } : { matcher: entry.matcher, hooks };
}

function handlerValue(handler: HookHandler): Schema.JsonObject {
  return handler.timeout === undefined
    ? { type: handler.type, command: handler.command }
    : { type: handler.type, command: handler.command, timeout: handler.timeout };
}

function strippedGroups(document: HookDocument): DraftHookGroups {
  const groups: DraftHookGroups = {};

  for (const [event, entries] of Object.entries(document.groups)) {
    groups[event] = entries.filter((entry) => janelaEntry(entry) === undefined);
  }

  return groups;
}

function isSameEntry(stored: StoredEntry, expected: HookEntry): boolean {
  if (stored.matcher !== expected.matcher) return false;

  if (stored.hooks.length !== expected.hooks.length) return false;

  return stored.hooks.every((handler, index) => {
    const wanted = expected.hooks[index];

    return (
      wanted !== undefined &&
      handler.type === wanted.type &&
      handler.command === wanted.command &&
      handler.timeout === wanted.timeout
    );
  });
}
