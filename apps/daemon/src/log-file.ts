import { closeSync, fstatSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { setLogSink, type LogRecord } from "@janela/support";
import { Option, Predicate, Result, Schema } from "effect";

export interface LogFile {
  readonly path: string;
  write(line: string): void;
  close(): void;
}

export interface DaemonLogSinkOptions {
  readonly path: string;
  readonly mirrorToStderr: boolean;
  readonly limitBytes?: number;
  readonly writeStderr?: (line: string) => void;
}

export interface DaemonLogSink {
  close(): void;
}

type LogFields = NonNullable<LogRecord["fields"]>;

interface LogLine {
  readonly time: string;
  readonly level: LogRecord["level"];
  readonly category: LogRecord["category"];
  readonly message: string;
  fields?: LogFields;
}

export const LOG_FILE_LIMIT_BYTES = 4 * 1024 * 1024;

export const FIELD_VALUE_LIMIT = 120;

const LAST_C0_CODE = 0x1f;

const DELETE_CODE = 0x7f;

const LAST_C1_CODE = 0x9f;

const LOG_DIRECTORY_MODE = 0o700;

const LOG_FILE_MODE = 0o600;

const STDERR_DESCRIPTOR = 2;

const ErrnoCode = Schema.Struct({ code: Schema.String });

const decodeErrnoCode = Schema.decodeUnknownOption(ErrnoCode);

export function defaultLogPath(): string {
  return join(homedir(), "Library", "Logs", "sh.janela.Janela", "janelad.log");
}

export function openLogFile(path: string, limitBytes = LOG_FILE_LIMIT_BYTES): LogFile {
  mkdirSync(dirname(path), { recursive: true, mode: LOG_DIRECTORY_MODE });

  let descriptor = openSync(path, "a", LOG_FILE_MODE);
  let written = fstatSync(descriptor).size;
  let open = true;

  const append = (line: string): void => {
    const bytes = Buffer.byteLength(line);

    if (written + bytes > limitBytes && written > 0) {
      closeSync(descriptor);
      renameSync(path, `${path}.1`);
      descriptor = openSync(path, "a", LOG_FILE_MODE);
      written = 0;
    }

    writeSync(descriptor, line);
    written += bytes;
  };

  return {
    path,

    write(line: string): void {
      if (!open) return;

      Result.try(() => append(line));
    },

    close(): void {
      if (!open) return;

      open = false;

      Result.try(() => closeSync(descriptor));
    },
  };
}

export function installDaemonLogSink(options: DaemonLogSinkOptions): DaemonLogSink {
  const stderr =
    options.writeStderr ??
    ((line: string): void => {
      Result.try(() => writeSync(STDERR_DESCRIPTOR, line));
    });

  const opening = Result.try(() =>
    openLogFile(options.path, options.limitBytes ?? LOG_FILE_LIMIT_BYTES),
  );

  if (Result.isFailure(opening)) {
    stderr(
      formatRecord({
        level: "warning",
        category: "app",
        message: "log file unavailable",
        fields: { error: failureCode(opening.failure) },
      }),
    );
  }

  const file = Result.getOrUndefined(opening);

  setLogSink({
    write: (record) => {
      const line = formatRecord(record);

      file?.write(line);

      if (options.mirrorToStderr || file === undefined) stderr(line);
    },
  });

  return { close: () => file?.close() };
}

function failureCode(cause: unknown): string {
  const errno = decodeErrnoCode(cause);

  if (Option.isSome(errno)) return errno.value.code;

  return cause instanceof Error ? cause.name : "unknown";
}

function formatRecord(record: LogRecord): string {
  const line: LogLine = {
    time: new Date().toISOString(),
    level: record.level,
    category: record.category,
    message: elide(record.message),
  };

  if (record.fields !== undefined) line.fields = elideFields(record.fields);

  return `${JSON.stringify(line)}\n`;
}

function elide(value: string): string {
  if (value.length > FIELD_VALUE_LIMIT) return `<${value.length} characters elided>`;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code <= LAST_C0_CODE || (code >= DELETE_CODE && code <= LAST_C1_CODE)) {
      return `<${value.length} characters elided>`;
    }
  }

  return value;
}

function elideFields(fields: LogFields): LogFields {
  let elided: Record<string, string | number | boolean> | undefined;

  for (const [key, value] of Object.entries(fields)) {
    if (!Predicate.isString(value)) continue;

    const kept = elide(value);

    if (kept === value) continue;

    elided ??= { ...fields };
    elided[key] = kept;
  }

  return elided ?? fields;
}
