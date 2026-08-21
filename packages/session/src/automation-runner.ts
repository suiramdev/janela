import type { AutomationCommand, AutomationEvent, Project, Session } from "@janela/core";

/**
 * Runs a project's automation commands.
 *
 * The one rule, and it is a product rule rather than an implementation choice:
 * **automation is visible.** Each command runs in a real terminal the user can
 * watch, scroll back through, and Ctrl-C — with `role: automation(event)`, in the
 * session's directory, with the session's environment. Nothing run on the user's
 * behalf happens in a hidden process, which is why this type creates terminals
 * rather than capturing output. See docs/decisions/0014-project-automation.md.
 *
 * What this is not: a task runner. There is no scheduling, no retry, no dependency
 * graph, and no conditional execution. Three events, a command each, in order.
 */
export interface AutomationRunning {
  /**
   * Runs every enabled command for `event`, in order, each in its own terminal.
   *
   * Returns once the terminals have been *created*, not once the commands have
   * finished — except for `sessionTeardown`, which is the one blocking event and is
   * bounded by each command's `timeoutSeconds`.
   *
   * A non-zero exit is visible and non-fatal: the terminal stays open showing why,
   * and the session is still usable.
   */
  run(request: {
    readonly event: AutomationEvent;
    readonly project: Project;
    readonly session: Session;
  }): Promise<AutomationReport>;
}

export interface AutomationReport {
  readonly event: AutomationEvent;
  /** One per command that ran, in order. */
  readonly commands: readonly {
    readonly command: AutomationCommand;
    /** Absent while still running, which is normal for everything but teardown. */
    readonly exitCode?: number;
    readonly timedOut: boolean;
  }[];
}

// TODO: Implement over @janela/terminal, creating one automation-role terminal per
// enabled command. This is a *new* file rather than a migrated seam — the automation
// ordering previously lived inside `SessionService.createSession`'s TODO, and
// splitting it out is the one structural change this migration makes to the brain,
// because "run these commands, visibly, in order, and block only for teardown" is a
// testable unit and the creation flow around it is not.
//
// Recorded in docs/MIGRATION_MAP.md so the split is not mistaken for a lost seam.
