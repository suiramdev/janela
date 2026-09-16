import { setLogSink } from "@janela/support";

export function installStderrLogSink(): void {
  setLogSink({
    write: (record) => {
      const fields = record.fields === undefined ? "" : ` ${JSON.stringify(record.fields)}`;

      process.stderr.write(`${record.level} ${record.category}: ${record.message}${fields}\n`);
    },
  });
}
