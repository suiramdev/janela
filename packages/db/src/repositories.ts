import type { Project, ProjectID, Session, SessionID } from "@janela/core";

export interface ProjectRepository {
  all(): Promise<readonly Project[]>;
  find(id: ProjectID): Promise<Project | undefined>;
  save(project: Project): Promise<void>;
  remove(id: ProjectID): Promise<void>;
}

export interface SessionRepository {
  all(): Promise<readonly Session[]>;
  find(id: SessionID): Promise<Session | undefined>;
  inProject(id: ProjectID): Promise<readonly Session[]>;
  standalone(): Promise<readonly Session[]>;
  save(session: Session): Promise<void>;
  remove(id: SessionID): Promise<void>;
  touch(id: SessionID): Promise<void>;
}
