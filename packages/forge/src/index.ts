import type { Forge, ForgeItems, ForgeState, Project, Session } from "@janela/core";

export interface ForgeServing {
  isAvailable(host: Forge): Promise<boolean>;

  state(request: {
    readonly project: Project;
    readonly session: Session;
  }): Promise<ForgeState | undefined>;

  items(project: Project): Promise<ForgeItems | undefined>;

  pullRequestBranch(request: {
    readonly project: Project;
    readonly number: number;
  }): Promise<string | undefined>;
}

export * from "./forge-service.ts";
