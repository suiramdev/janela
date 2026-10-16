import type { Session } from "./session.ts";

export type SessionNameOrigin = "derived" | "automatic" | "user";

export const SESSION_NAME_ORIGINS: readonly SessionNameOrigin[] = ["derived", "automatic", "user"];

export const SESSION_NAMER_IDS = ["claude", "codex", "omp"] as const;

export type SessionNamerID = (typeof SESSION_NAMER_IDS)[number];

export type SessionNaming =
  | { readonly kind: "off" }
  | {
      readonly kind: "agent";
      readonly agent: SessionNamerID;
      readonly model?: string;
      readonly effort?: string;
    };

export interface SessionNamerReport {
  readonly id: SessionNamerID;
  readonly name: string;
  readonly executable: string;
  readonly isAvailable: boolean;
  readonly defaultModel?: string;
}

export interface SessionNamingOverview {
  readonly naming: SessionNaming;
  readonly namers: readonly SessionNamerReport[];
}

export interface SessionNamerModel {
  readonly id: string;
  readonly name: string;
  readonly efforts: readonly string[];
}

export interface SessionNamerCatalog {
  readonly agent: SessionNamerID;
  readonly models: readonly SessionNamerModel[];
}

export const SESSION_NAMING_OFF: SessionNaming = { kind: "off" };

export const MAX_SESSION_NAMER_MODEL_LENGTH = 128;

export const MAX_SESSION_NAMER_EFFORT_LENGTH = 32;

export const SESSION_NAMER_EFFORT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export const MAX_SESSION_NAMER_CATALOG_MODELS = 2048;

export function isSessionNamerID(value: string): value is SessionNamerID {
  return SESSION_NAMER_IDS.some((id) => id === value);
}

export function isSessionNameOrigin(value: string): value is SessionNameOrigin {
  return SESSION_NAME_ORIGINS.some((origin) => origin === value);
}

export function acceptsAutomaticName(session: Pick<Session, "nameOrigin">): boolean {
  return session.nameOrigin !== "user";
}
