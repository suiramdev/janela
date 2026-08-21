/**
 * Timing marks for the budgets in docs/performance.md.
 *
 * Every name here corresponds to a budget in that document. If you add a mark,
 * add its budget too, otherwise it is decoration rather than a test.
 *
 * These were platform signpost intervals read in a native profiler. The replacement
 * is deliberately plain: `performance.mark`/`measure`, which the daemon can log and
 * a client can read in the browser's own profiler. The budgets did not change; how
 * we watch them did.
 */
export type SignpostName =
  /** Process start → interactive window. Client-side. */
  | "launch"
  /** Connect + handshake + first full state. */
  | "connect"
  /** Attach → first painted frame of an existing terminal. */
  | "attach"
  /** PTY spawn → first byte. Daemon-side. */
  | "terminal"
  /** One coalesced drain → emulator fed → repaint encoded. Daemon-side, hot. */
  | "repaint"
  /** A single git invocation. */
  | "git"
  /**
   * Worktree add → `.worktreeinclude` copy → automation started. The one
   * user-initiated flow with real work in it.
   */
  | "sessionCreate"
  /** A forge CLI invocation. Never on a path anything waits for. */
  | "forge";

export interface Signpost {
  /** Ends the interval and records it. Idempotent. */
  end(fields?: Readonly<Record<string, string | number | boolean>>): void;
}

/** Begins an interval. Cheap enough for the repaint path; still prefer one per frame. */
export function begin(name: SignpostName, id?: string): Signpost {
  void name;
  void id;
  throw new Error(`not implemented: begin`);
}
