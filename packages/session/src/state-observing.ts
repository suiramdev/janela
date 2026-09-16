import type { Project, Session } from "@janela/core";

export interface StateObserving {
  sessionsChanged(sessions: readonly Session[]): Promise<void>;
  projectsChanged(projects: readonly Project[]): Promise<void>;
}
