export type SignpostName =
  | "launch"
  | "connect"
  | "attach"
  | "terminal"
  | "repaint"
  | "git"
  | "sessionCreate"
  | "forge";

export type SignpostFields = Readonly<Record<string, string | number | boolean>>;

export interface SignpostRecord {
  readonly name: SignpostName;
  readonly id?: string;
  readonly durationMs: number;
  readonly fields?: SignpostFields;
}

export interface SignpostSink {
  record(record: SignpostRecord): void;
}

export interface Signpost {
  readonly observed: boolean;
  end(fields: SignpostFields | undefined): void;
}

type PendingRecord = { -readonly [Key in keyof SignpostRecord]: SignpostRecord[Key] };

const UNOBSERVED: Signpost = Object.freeze({
  observed: false,
  end(): void {},
});

export function setSignpostSink(sink: SignpostSink | undefined): void {
  currentSink = sink;
}

export function begin(name: SignpostName, id: string | undefined = undefined): Signpost {
  const sink = currentSink;

  if (sink === undefined) {
    return UNOBSERVED;
  }

  const started = performance.now();
  let ended = false;

  return {
    observed: true,
    end(fields: SignpostFields | undefined = undefined): void {
      if (ended) {
        return;
      }

      ended = true;

      const record: PendingRecord = { name, durationMs: performance.now() - started };

      if (id !== undefined) {
        record.id = id;
      }

      if (fields !== undefined) {
        record.fields = fields;
      }

      sink.record(record);
    },
  };
}

let currentSink: SignpostSink | undefined;
