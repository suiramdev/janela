export type IntegrationID = (typeof INTEGRATION_IDS)[number];

export type IntegrationStatus =
  | { readonly kind: "installed" }
  | { readonly kind: "outdated" }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly reason: string };

export interface IntegrationReport {
  readonly id: IntegrationID;
  readonly name: string;
  readonly executable: string;
  readonly isAvailable: boolean;
  readonly configPath: string;
  readonly reports: readonly string[];
  readonly status: IntegrationStatus;
}

export interface IntegrationOverview {
  readonly integrations: readonly IntegrationReport[];
}

export const INTEGRATION_IDS = ["claude", "codex", "opencode", "omp"] as const;

export function isIntegrationID(value: string): value is IntegrationID {
  return INTEGRATION_IDS.some((id) => id === value);
}
