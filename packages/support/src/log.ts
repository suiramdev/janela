/**
 * Janela's logging.
 *
 * Rules of the road (see docs/conventions.md):
 * - Never `console.log`. It is unsearchable, it is not levelled, and in the
 *   daemon it goes somewhere nobody reads. The lint rule `no-console` enforces
 *   this; these categories are the alternative.
 * - Never log file contents, command output, environment values, notification
 *   bodies, or the paths `.worktreeinclude` copied. Terminal traffic and
 *   everything adjacent to it is the user's private data and must not leak into
 *   a log file. Log the *shape*: a subcommand and its exit status, a terminal id
 *   and its state transition, a file count and a total size.
 * - Prefer `debug` for anything on a hot path.
 *
 * Both processes log through this. The daemon installs a sink that writes one JSON
 * record per line to a file it rotates under `~/Library/Logs/sh.janela.Janela/`
 * (`apps/daemon/src/log-file.ts`), and mirrors the same lines to stderr when it
 * runs `--foreground`; a client writes through the Tauri log plugin, and a future
 * browser client to the console — which is why the sink is injected rather than
 * chosen here. This module stays isomorphic so `@janela/support` can link into a
 * WebView.
 */

export type LogLevel = "debug" | "info" | "notice" | "warning" | "error";

/** One record, already reduced to something safe to persist. */
export interface LogRecord {
  readonly level: LogLevel;
  readonly category: LogCategory;
  readonly message: string;
  /**
   * Structured fields. Values must be *shapes*, never content: an id, a count, a
   * duration, an exit status. A reviewer's test for a new field is "would I mind
   * finding this in a bug report I did not write?".
   */
  readonly fields?: Readonly<Record<string, string | number | boolean>>;
}

/** Where records go. Injected, because the two processes answer this differently. */
export interface LogSink {
  write(record: LogRecord): void;
}

/**
 * The categories. One per subsystem, and the same set in both processes so a
 * daemon log and a client log can be read side by side.
 */
export type LogCategory =
  /** App lifecycle, window and scene management. */
  | "app"
  /** Project and session creation, opening, closing, deletion. */
  | "session"
  /**
   * Project automation: which event fired, which command index, and its exit
   * status. Never the command's output — that belongs in its terminal, where the
   * user can see it.
   */
  | "automation"
  /** Forge CLI invocations: the subcommand and the failure class, never the JSON. */
  | "forge"
  /** PTY and child-process plumbing. Hot path — use `debug`. */
  | "pty"
  /** Terminal emulation and rendering. */
  | "terminal"
  /** Git invocations: the subcommand and exit status, never full output. */
  | "git"
  /** Database open, migration, and query failures. */
  | "db"
  /** The socket: connections, handshakes, subscription churn. Never payloads. */
  | "protocol";

export interface Logger {
  debug(message: string, fields?: LogRecord["fields"]): void;
  info(message: string, fields?: LogRecord["fields"]): void;
  notice(message: string, fields?: LogRecord["fields"]): void;
  warning(message: string, fields?: LogRecord["fields"]): void;
  error(message: string, fields?: LogRecord["fields"]): void;
}

/**
 * Installs the process's sink. Called once, by a composition root — the daemon's
 * `main`, or the desktop app's environment. Until it is called, records are
 * dropped rather than printed, so a library that logs during import cannot
 * decide the format for everyone.
 */
export function setLogSink(sink: LogSink): void {
  currentSink = sink;
}

/** The logger for one category. Cheap; hold it in a module constant. */
export function log(category: LogCategory): Logger {
  // One closure per level rather than five near-identical methods. `fields` is
  // spread conditionally because `exactOptionalPropertyTypes` makes
  // `{ fields: undefined }` a different type from a record without the key —
  // and a sink that writes `"fields": null` for every record is noise.
  const at =
    (level: LogLevel) =>
    (message: string, fields?: LogRecord["fields"]): void => {
      currentSink.write({
        level,
        category,
        message,
        ...(fields === undefined ? {} : { fields }),
      });
    };

  return {
    debug: at("debug"),
    info: at("info"),
    notice: at("notice"),
    warning: at("warning"),
    error: at("error"),
  };
}

/**
 * A sink that discards everything. The default, and what tests use when they do
 * not care — `@janela/test-support` has a recording one for when they do.
 */
export const nullLogSink: LogSink = {
  write(): void {
    // Deliberately nothing. Dropping is the correct default: a library that logs
    // during import must not decide the format for the whole process.
  },
};

/**
 * The process's sink. Module-level mutable state, and the only such state in the
 * repository — a logger is the one dependency it would be absurd to thread through
 * every constructor, and `setLogSink` is called once by a composition root before
 * anything logs. Declared after `nullLogSink` because a `const` is not initialised
 * until its statement runs.
 */
let currentSink: LogSink = nullLogSink;
