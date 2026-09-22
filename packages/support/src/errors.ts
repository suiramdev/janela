export interface Presentation {
  readonly reason?: string;
  readonly recoverySuggestion?: string;
}

export abstract class UserFacingError extends Error {
  abstract readonly summary: string;

  readonly reason: string | undefined;

  readonly recoverySuggestion: string | undefined;

  constructor(message: string, presentation: Presentation = {}) {
    super(message);
    this.name = new.target.name;
    this.reason = presentation.reason;
    this.recoverySuggestion = presentation.recoverySuggestion;
  }
}

export function isUserFacing(cause: unknown): cause is UserFacingError {
  return cause instanceof UserFacingError;
}

export class UnexpectedFailure extends UserFacingError {
  override readonly summary: string;

  readonly underlying: unknown;

  constructor(summary: string, cause: unknown) {
    super(summary, {
      recoverySuggestion: "If this keeps happening, please file an issue with the log.",
    });

    this.summary = summary;
    this.underlying = cause;
  }
}
