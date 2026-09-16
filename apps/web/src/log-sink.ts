import type { LogRecord, LogSink } from "@janela/support";
import { Match } from "effect";

export function consoleLogSink(): LogSink {
  return {
    write(record: LogRecord): void {
      const fields = record.fields === undefined ? "" : ` ${JSON.stringify(record.fields)}`;
      const line = `${record.category}: ${record.message}${fields}`;

      Match.value(record.level).pipe(
        // oxlint-disable-next-line no-console
        Match.when("debug", () => console.debug(line)),
        // oxlint-disable-next-line no-console
        Match.whenOr("info", "notice", () => console.info(line)),
        // oxlint-disable-next-line no-console
        Match.when("warning", () => console.warn(line)),
        // oxlint-disable-next-line no-console
        Match.when("error", () => console.error(line)),
        Match.exhaustive,
      );
    },
  };
}
