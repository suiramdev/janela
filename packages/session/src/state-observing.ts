import type { Project, Session } from "@janela/core";

/**
 * How the brain announces change without knowing who is listening.
 *
 * `@janela/daemon` implements this and fans out to subscribers. A test implements
 * it with an array. Neither is visible from here, which is the point: this package
 * does not import `@janela/protocol` and cannot accidentally grow a dependency on
 * the wire format.
 *
 * That is also the test of whether the layering is right. `@janela/session` must
 * stay usable — and testable — with no socket at all, which is exactly how its
 * tests use it.
 */
export interface StateObserving {
  sessionsChanged(sessions: readonly Session[]): Promise<void>;
  projectsChanged(projects: readonly Project[]): Promise<void>;
}
