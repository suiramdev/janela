/**
 * Timing marks for the budgets in docs/performance.md.
 *
 * Every name here corresponds to a budget in that document. If you add a mark,
 * add its budget too, otherwise it is decoration rather than a test.
 *
 * These were platform signpost intervals read in a native profiler. The
 * replacement is a sink, mirroring `setLogSink`: the daemon can record intervals
 * into its log and a browser composition root can turn them into
 * `performance.measure` entries its own profiler shows. The budgets did not
 * change; how we watch them did.
 *
 * **Deliberately not `performance.mark`/`measure` in here.** Both keep a timeline
 * entry per call, and `repaint` runs once per frame per attached client for the
 * life of a daemon — an unbounded buffer by non-negotiable #9. A sink that wants
 * profiler entries may call `performance.measure` itself, and pay for the choice
 * where it is visible.
 */
export type SignpostName =
  /** Process start → interactive window. Client-side. */
  | "launch"
  /** Connect + handshake + first full state. */
  | "connect"
  /**
   * Attach → first painted frame (client), or attach → first full repaint
   * encoded (daemon).
   */
  | "attach"
  /** PTY spawn → first byte. Daemon-side. */
  | "terminal"
  /**
   * One encode: `repaintFor`/`fullRepaintFor` for one client. Daemon-side, hot.
   */
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

/**
 * What an interval carries besides its duration. Shapes only — a count, an id,
 * a byte total. Never terminal traffic, command output or environment values
 * (non-negotiable #11): a sink writes to the same system log the rest does.
 */
export type SignpostFields = Readonly<Record<string, string | number | boolean>>;

/** One completed interval. */
export interface SignpostRecord {
  readonly name: SignpostName;
  /** Which terminal, session or client the interval belonged to. */
  readonly id?: string;
  readonly durationMs: number;
  readonly fields?: SignpostFields;
}

/** Where records go. Injected, because the two processes answer this differently. */
export interface SignpostSink {
  record(record: SignpostRecord): void;
}

export interface Signpost {
  /**
   * False when no sink is installed: callers skip building `fields` then, which
   * is what keeps the repaint path allocation-free when nobody is measuring.
   */
  readonly observed: boolean;
  /** Ends the interval and records it. Idempotent. */
  end(fields?: SignpostFields): void;
}

/**
 * Installs the process's sink, or removes it with `undefined`. Called once, by a
 * composition root. Until it is called, intervals are not measured at all —
 * `begin` hands back a shared no-op.
 */
export function setSignpostSink(sink: SignpostSink | undefined): void {
  currentSink = sink;
}

/**
 * Begins an interval.
 *
 * With no sink this allocates nothing and reads no clock: it returns one shared
 * frozen object whose `end` does nothing. That is the production default, and it
 * is why `repaintFor` may call this per frame per client.
 *
 * The sink is read here rather than at `end`, so an interval never records into a
 * sink that was not installed when it started.
 */
export function begin(name: SignpostName, id?: string): Signpost {
  const sink = currentSink;
  if (sink === undefined) {
    return UNOBSERVED;
  }
  const started = performance.now();
  let ended = false;
  return {
    observed: true,
    end(fields?: SignpostFields): void {
      if (ended) {
        return;
      }
      ended = true;
      // `fields` and `id` are spread conditionally because
      // `exactOptionalPropertyTypes` makes `{ id: undefined }` a different type
      // from a record without the key.
      sink.record({
        name,
        durationMs: performance.now() - started,
        ...(id === undefined ? {} : { id }),
        ...(fields === undefined ? {} : { fields }),
      });
    },
  };
}

/**
 * The answer when nothing is measuring. Shared and frozen: `begin` on the
 * repaint path must not allocate, and an accidental write to it would be a bug
 * that only showed up under a profiler.
 */
const UNOBSERVED: Signpost = Object.freeze({
  observed: false,
  end(): void {
    // Deliberately nothing.
  },
});

/** The process's sink. See the note on `currentSink` in log.ts for why this exists. */
let currentSink: SignpostSink | undefined;
