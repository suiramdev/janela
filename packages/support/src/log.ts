export type LogLevel = "debug" | "info" | "notice" | "warning" | "error";

export type LogCategory =
  | "app"
  | "session"
  | "automation"
  | "forge"
  | "pty"
  | "terminal"
  | "git"
  | "db"
  | "protocol";

export interface LogRecord {
  readonly level: LogLevel;
  readonly category: LogCategory;
  readonly message: string;
  readonly fields?: Readonly<Record<string, string | number | boolean>>;
}

export interface LogSink {
  write(record: LogRecord): void;
}

export interface Logger {
  debug(message: string, fields?: LogRecord["fields"]): void;
  info(message: string, fields?: LogRecord["fields"]): void;
  notice(message: string, fields?: LogRecord["fields"]): void;
  warning(message: string, fields?: LogRecord["fields"]): void;
  error(message: string, fields?: LogRecord["fields"]): void;
}

export const nullLogSink: LogSink = {
  write(): void {},
};

export function setLogSink(sink: LogSink): void {
  currentSink = sink;
}

export function log(category: LogCategory): Logger {
  const at =
    (level: LogLevel) =>
    (message: string, fields: LogRecord["fields"] | undefined = undefined): void => {
      currentSink.write(
        fields === undefined ? { level, category, message } : { level, category, message, fields },
      );
    };

  return {
    debug: at("debug"),
    info: at("info"),
    notice: at("notice"),
    warning: at("warning"),
    error: at("error"),
  };
}

let currentSink: LogSink = nullLogSink;
