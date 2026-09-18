import type { IntegrationID, IntegrationOverview, IntegrationStatus } from "@janela/core";

export interface IntegrationFiles {
  read(path: string): Promise<string | undefined>;
  write(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
  canonical(path: string): Promise<string>;
}

export interface IntegrationHome {
  readonly directory: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface Integration {
  readonly id: IntegrationID;
  readonly name: string;
  readonly executable: string;
  readonly reports: readonly string[];
  configPath(home: IntegrationHome): string;
  status(files: IntegrationFiles, home: IntegrationHome): Promise<IntegrationStatus>;
  install(files: IntegrationFiles, home: IntegrationHome): Promise<void>;
  remove(files: IntegrationFiles, home: IntegrationHome): Promise<void>;
}

export interface IntegrationService {
  overview(): Promise<IntegrationOverview>;
  install(id: IntegrationID): Promise<void>;
  remove(id: IntegrationID): Promise<void>;
}
