/**
 * An error that is safe and useful to put in front of a person.
 *
 * Janela's rule: an error either conforms to this and is shown, or it does not
 * and is logged. We never surface a raw error message or a git stderr dump in a
 * dialog headline — those become a bug report, not a recovery path.
 *
 * This is a class rather than an interface because it must survive an
 * `instanceof` across the daemon/client boundary decision: the daemon decides
 * what is user-facing, and the wire form is `UserFacingFailure` in
 * `@janela/protocol`, which is deliberately lossy.
 */
export abstract class UserFacingError extends Error {
  /**
   * One short sentence. No error codes, no jargon.
   * "Couldn't create the worktree."
   */
  abstract readonly summary: string;

  /** Optional second sentence explaining *why*, in the user's terms. */
  readonly reason: string | undefined;

  /** What the user can actually do next, if anything. */
  readonly recoverySuggestion: string | undefined;

  /**
   * `message` is for the log; `summary`, `reason` and `recoverySuggestion` are for
   * the person. Keeping them separate is the whole point of this type — see the
   * class comment.
   */
  constructor(
    message: string,
    presentation?: { readonly reason?: string; readonly recoverySuggestion?: string },
  ) {
    super(message);
    this.name = new.target.name;
    this.reason = presentation?.reason;
    this.recoverySuggestion = presentation?.recoverySuggestion;
  }
}

/** Whether an unknown thrown value is safe to show. */
export function isUserFacing(error: unknown): error is UserFacingError {
  return error instanceof UserFacingError;
}

/**
 * Wraps an arbitrary error for logging without ever showing it verbatim.
 *
 * The `underlying` value stays in the log. Only `summary` and the recovery
 * suggestion reach a person.
 */
export class UnexpectedFailure extends UserFacingError {
  override readonly summary: string;
  readonly underlying: unknown;

  constructor(summary: string, underlying: unknown) {
    super(summary, {
      recoverySuggestion: "If this keeps happening, please file an issue with the log.",
    });
    this.summary = summary;
    this.underlying = underlying;
  }
}
