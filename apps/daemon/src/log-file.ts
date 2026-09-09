/**
 * The daemon's log: a file it owns, one JSON record per line.
 *
 * ## Why a file, and why the daemon opens it
 *
 * Before this (#45) the daemon wrote records to **stderr**, and on a real install
 * stderr is `/dev/null`: the LaunchAgent declares no `StandardErrorPath`, and it
 * cannot — launchd takes a literal path with no `~` expansion, and the plist is
 * sealed into the bundle and validated against its code signature, so the only
 * path it could name is one shared by every user of the machine. So the daemon's
 * log did not exist anywhere, and steps of the survival proof could not be
 * diagnosed at all.
 *
 * `os_log` is not the alternative: reaching it from Bun needs `bun:ffi`, which
 * `scripts/layers.ts` gates to `@janela/pty`, or a subprocess per record. A file
 * the daemon opens itself behaves identically under launchd and in
 * `--foreground`, derives from `homedir()` like the socket and the database (so
 * `HOME=/tmp/…` isolates all three together), and lands where macOS already keeps
 * this app's logs — beside the `Janela.log` that Tauri's log plugin writes.
 *
 * ## The bound
 *
 * A log file is the classic place where "no unbounded buffers" (AGENTS.md
 * non-negotiable 9) is forgotten, because the accumulation is on disk rather than
 * in memory. Rotation at `LOG_FILE_LIMIT_BYTES` with exactly one previous file
 * kept caps it at twice that — 8 MiB — for a daemon that may run for months.
 *
 * ## What may not reach it
 *
 * Non-negotiable 11: terminal traffic, command output, file contents,
 * notification bodies and environment values are the user's private data, and
 * this file is the first place in the daemon that makes a record easy to read
 * back. No daemon-side `log(...)` call passes content today — the survey behind
 * #45 found only ids, counts, exit statuses, error names, a truncated client name,
 * a shell path and a forge CLI name — so `elide` is a backstop, not a filter: it
 * replaces any value with the *shape* of a body (a control character, or longer
 * than `FIELD_VALUE_LIMIT`) with its length, so a leak lands as
 * `<4096 characters elided>` rather than as the first paragraph of the user's
 * output. It also means a log file can be `tail`ed safely: an escape sequence from
 * a terminal cannot reach a reader's own terminal through it.
 */

import { closeSync, fstatSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { setLogSink, type LogRecord } from "@janela/support";

/** Rotate at this size; one previous file is kept, so the bound on disk is twice this. */
export const LOG_FILE_LIMIT_BYTES = 4 * 1024 * 1024;

/**
 * The longest a single string may be on disk, and the threshold above which it is
 * replaced by its length. Generous enough for every field the daemon logs — the
 * longest is a path — and far shorter than any body worth leaking.
 */
export const FIELD_VALUE_LIMIT = 120;

/**
 * `~/Library/Logs/sh.janela.Janela/janelad.log`.
 *
 * Beside the app's `Janela.log`, which Tauri's log plugin writes to the same
 * directory. The bundle identifier is spelled here, in `@janela/db`'s
 * `defaultDatabasePath()` and in `tauri.conf.json`; all three must agree.
 */
export function defaultLogPath(): string {
  return join(homedir(), "Library", "Logs", "sh.janela.Janela", "janelad.log");
}

export interface LogFile {
  readonly path: string;
  /**
   * Appends one line synchronously, so the record is on the descriptor when this
   * returns — a daemon that crashes must not take its last records with it.
   * Rotates first when the line would push the file past its limit. Never throws:
   * a log is not worth a daemon.
   */
  write(line: string): void;
  close(): void;
}

/**
 * Opens the file, creating its directory.
 *
 * Throws if it cannot: the caller decides what a daemon without a log file does,
 * and that decision is `installDaemonLogSink`'s, not this function's.
 */
export function openLogFile(path: string, limitBytes = LOG_FILE_LIMIT_BYTES): LogFile {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let descriptor = openSync(path, "a", 0o600);
  // An existing file counts: a daemon restarted every hour must not append past
  // the bound one restart at a time.
  let written = fstatSync(descriptor).size;
  let open = true;

  return {
    path,
    write(line: string): void {
      if (!open) return;
      try {
        const bytes = Buffer.byteLength(line);
        // `written > 0` so a line larger than the whole limit still lands rather
        // than rotating an empty file forever.
        if (written + bytes > limitBytes && written > 0) {
          closeSync(descriptor);
          renameSync(path, `${path}.1`);
          descriptor = openSync(path, "a", 0o600);
          written = 0;
        }
        writeSync(descriptor, line);
        written += bytes;
      } catch {
        // A full disk, a revoked directory, a descriptor someone closed. None of
        // them is a reason to stop owning the user's terminals.
      }
    },
    close(): void {
      if (!open) return;
      open = false;
      try {
        closeSync(descriptor);
      } catch {
        // Already gone.
      }
    },
  };
}

export interface DaemonLogSinkOptions {
  readonly path: string;
  /** `--foreground`: every line also goes to stderr, for a developer's pipe. */
  readonly mirrorToStderr: boolean;
  /** Test hooks. Production takes `LOG_FILE_LIMIT_BYTES` and `writeSync(2, line)`. */
  readonly limitBytes?: number;
  readonly writeStderr?: (line: string) => void;
}

/**
 * Installs the daemon's sink with `setLogSink`. Returns the handle `main` closes
 * on the way out.
 */
export function installDaemonLogSink(options: DaemonLogSinkOptions): { close(): void } {
  const stderr =
    options.writeStderr ??
    ((line: string): void => {
      try {
        // Synchronous, unlike `process.stderr.write`, which queues once the pipe
        // fills and flushes only when the event loop turns — measured at 1.5 s
        // behind a busy loop, which is exactly when a developer is reading.
        writeSync(2, line);
      } catch {
        // EPIPE with SIGPIPE ignored, or a reader that closed.
      }
    });

  let file: LogFile | undefined;
  try {
    file = openLogFile(options.path, options.limitBytes ?? LOG_FILE_LIMIT_BYTES);
  } catch (error: unknown) {
    file = undefined;
    // The shape, never a message: `ENOTDIR` when the directory is a file,
    // `EACCES` when it is not ours. A message would quote the path.
    let cause = error instanceof Error ? error.name : "unknown";
    if (error !== null && typeof error === "object" && "code" in error) {
      const code: unknown = error.code;
      if (typeof code === "string") cause = code;
    }
    stderr(
      formatRecord({
        level: "warning",
        category: "app",
        message: "log file unavailable",
        fields: { error: cause },
      }),
    );
  }

  setLogSink({
    write: (record) => {
      const line = formatRecord(record);
      file?.write(line);
      // With no file, stderr is all there is. Under launchd that is `/dev/null`,
      // but a daemon must still start, and in `--foreground` it is the terminal.
      if (options.mirrorToStderr || file === undefined) stderr(line);
    },
  });

  return { close: () => file?.close() };
}

/**
 * One line, `time` first.
 *
 * The timestamp is added here rather than in `LogRecord`, which stays
 * isomorphic — a browser client's console adds its own, and the app's log plugin
 * already has one.
 */
function formatRecord(record: LogRecord): string {
  return `${JSON.stringify({
    time: new Date().toISOString(),
    level: record.level,
    category: record.category,
    message: elide(record.message),
    ...(record.fields === undefined ? {} : { fields: elideFields(record.fields) }),
  })}\n`;
}

/**
 * A value shaped like a body becomes its length. See the module comment.
 *
 * A scan rather than a regular expression: `no-control-regex` is right that a
 * literal control character in a pattern is usually a mistake, and a loop over
 * code units says what "shaped like a body" means — a newline, a carriage return,
 * a tab, an `ESC`, a `DEL`, or anything in the C1 range.
 */
function elide(value: string): string {
  if (value.length > FIELD_VALUE_LIMIT) return `<${value.length} characters elided>`;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return `<${value.length} characters elided>`;
    }
  }
  return value;
}

function elideFields(
  fields: Readonly<Record<string, string | number | boolean>>,
): Readonly<Record<string, string | number | boolean>> {
  // The original object when nothing needs eliding, which is every record the
  // daemon writes today: no copy on the logging path.
  let elided: Record<string, string | number | boolean> | undefined;
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value !== "string") continue;
    const kept = elide(value);
    if (kept === value) continue;
    elided ??= { ...fields };
    elided[key] = kept;
  }
  return elided ?? fields;
}
