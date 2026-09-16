import { Result, Schema } from "effect";

export interface RemovalSafety {
  readonly hasUncommittedChanges: boolean;
  readonly hasUntrackedFiles: boolean;
  readonly hasUnpushedCommits: boolean;
  readonly isLocked: boolean;
  readonly hasRunningSessions: boolean;
}

export interface SessionRemovalPreview {
  readonly liveTerminalCount: number;
  readonly canDeleteDirectory: boolean;
  readonly deletesDirectory: boolean;
  readonly includedPaths: readonly string[];
  readonly runsTeardownAutomation: boolean;
  readonly safety: RemovalSafety;
}

const RemovalSafetySchema = Schema.Struct({
  hasUncommittedChanges: Schema.Boolean,
  hasUntrackedFiles: Schema.Boolean,
  hasUnpushedCommits: Schema.Boolean,
  isLocked: Schema.Boolean,
  hasRunningSessions: Schema.Boolean,
});

const SessionRemovalPreviewSchema = Schema.Struct({
  liveTerminalCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  canDeleteDirectory: Schema.Boolean,
  deletesDirectory: Schema.Boolean,
  includedPaths: Schema.Array(Schema.String),
  runsTeardownAutomation: Schema.Boolean,
  safety: RemovalSafetySchema,
});

const decodeRemovalPlanText = Schema.decodeUnknownResult(
  Schema.fromJsonString(SessionRemovalPreviewSchema),
);

export function serializeRemovalPlan(plan: SessionRemovalPreview): string {
  return JSON.stringify({
    liveTerminalCount: plan.liveTerminalCount,
    canDeleteDirectory: plan.canDeleteDirectory,
    deletesDirectory: plan.deletesDirectory,
    includedPaths: [...plan.includedPaths],
    runsTeardownAutomation: plan.runsTeardownAutomation,
    safety: {
      hasUncommittedChanges: plan.safety.hasUncommittedChanges,
      hasUntrackedFiles: plan.safety.hasUntrackedFiles,
      hasUnpushedCommits: plan.safety.hasUnpushedCommits,
      isLocked: plan.safety.isLocked,
      hasRunningSessions: plan.safety.hasRunningSessions,
    },
  });
}

export function parseRemovalPlan(text: string): SessionRemovalPreview {
  const decoded = Result.mapError(
    decodeRemovalPlanText(text),
    (error) => new TypeError(`not a removal plan: ${error.message}`),
  );

  return Result.getOrThrowWith(decoded, (error) => error);
}
