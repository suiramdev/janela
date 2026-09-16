import type { GridSize } from "@janela/core";

import { HeadlessEmulator } from "./headless-emulator.ts";

interface Scenario {
  readonly name: string;
  setup?(size: GridSize): string;
  frames(size: GridSize): readonly string[];
  readonly feedRate?: "report";
}

interface Measurement {
  readonly scenario: string;
  readonly size: GridSize;
  readonly bytesPerFramePerClient: number;
  readonly encodeMicroseconds: number;
  readonly feedMicroseconds: number;
  readonly feedMegabytesPerSecond: number | undefined;
  readonly feedRate: "report" | undefined;
  readonly sharedBuffer: boolean;
}

const FRAME_MS = 8;

const FRAMES_PER_SECOND = 120;

const FRAMES = 600;
const WARMUP_FRAMES = 60;

const CLIENTS = 3;

const SOCKET_BUDGET_BYTES_PER_SECOND = 2e6;

const FLOOD_BYTES_PER_SECOND = 100e6;

const WIRE_BUDGET_BYTES_PER_FRAME = Math.floor(SOCKET_BUDGET_BYTES_PER_SECOND / FRAMES_PER_SECOND);

const FLOOD_BYTES_PER_FRAME = Math.floor(FLOOD_BYTES_PER_SECOND / FRAMES_PER_SECOND);

const SCROLLBACK = 10_000;

const GRIDS: readonly GridSize[] = [
  { columns: 80, rows: 24 },
  { columns: 120, rows: 40 },
];

const SCENARIOS: readonly Scenario[] = [
  {
    name: "yes flood",
    feedRate: "report",
    frames: () => ["y\r\n".repeat(Math.floor(FLOOD_BYTES_PER_FRAME / 3))],
  },
  {
    name: "line flood",
    feedRate: "report",
    frames: (size) => {
      const line = `${"y".repeat(size.columns - 2)}\r\n`;

      return [line.repeat(Math.floor(FLOOD_BYTES_PER_FRAME / line.length))];
    },
  },
  {
    name: "build log",
    frames: (size) => {
      const batches: string[] = [];

      for (let batch = 0; batch < 60; batch += 1) {
        let payload = "";

        for (let line = 0; line < 5; line += 1) {
          const text = `[build] compiling module-${batch * 5 + line}.ts … ok`;
          payload += `${text.padEnd(Math.min(60, size.columns))}\r\n`;
        }

        batches.push(payload);
      }

      return batches;
    },
  },
  {
    name: "TUI cursor move",
    setup: (size) => {
      let payload = "\x1b[?1049h\x1b[2J\x1b[H";
      const rows = Math.min(30, size.rows);

      for (let row = 1; row <= rows; row += 1) {
        payload += `\x1b[${row};1H\x1b[4${row % 8}m row ${String(row).padStart(2)} \x1b[0m${"·".repeat(
          Math.max(0, Math.min(40, size.columns - 10)),
        )}`;
      }

      return payload;
    },
    frames: (size) => {
      const payloads: string[] = [];

      for (let step = 0; step < 120; step += 1) {
        const row = 1 + (step % (size.rows - 1));
        const column = 1 + (step % (size.columns - 12));
        payloads.push(
          `\x1b[${size.rows};1H\x1b[7m -- INSERT -- ${String(step).padStart(4)} \x1b[0m` +
            `\x1b[${row};${column}H`,
        );
      }

      return payloads;
    },
  },
  {
    name: "quiet",
    frames: () => [],
  },
  {
    name: "SGR-heavy redraw",
    frames: (size) => {
      let payload = "";

      for (let row = 1; row <= size.rows; row += 1) {
        payload += `\x1b[${row};1H\x1b[3${row % 8};4${(row + 3) % 8}m${"▒".repeat(size.columns)}\x1b[0m`;
      }

      return [payload];
    },
  },
];

const COLUMNS = [
  ["scenario", 18],
  ["grid", 8],
  ["bytes/frame", 12],
  ["MB/s @120", 10],
  ["encode µs", 10],
  ["feed µs", 10],
  ["CPU %", 7],
  ["shared buf", 11],
] as const;

const textEncoder = new TextEncoder();

const measurements: Measurement[] = [];

const failures: string[] = [];

function report(line: string): void {
  process.stdout.write(`${line}\n`);
}

function measure(scenario: Scenario, size: GridSize): Measurement {
  const emulator = new HeadlessEmulator(size, SCROLLBACK, { rowHints: true });
  const setup = scenario.setup?.(size);

  if (setup !== undefined) {
    emulator.feed(textEncoder.encode(setup));
  }

  const payloads = scenario.frames(size).map((frame) => textEncoder.encode(frame));
  const revisions: number[] = Array.from({ length: CLIENTS }, () => 0);

  let feedNanoseconds = 0;
  let encodeNanoseconds = 0;
  let fedBytes = 0;
  let deltaBytes = 0;
  let sharedBuffer = true;
  let previousBuffer: ArrayBufferLike | undefined;

  for (let frame = 0; frame < WARMUP_FRAMES + FRAMES; frame += 1) {
    const measured = frame >= WARMUP_FRAMES;
    const payload = payloads.length === 0 ? undefined : payloads[frame % payloads.length];
    const beforeFeed = Bun.nanoseconds();

    if (payload !== undefined) {
      emulator.feed(payload);
    }

    const afterFeed = Bun.nanoseconds();
    let frameDeltaBytes = 0;

    for (let client = 0; client < CLIENTS; client += 1) {
      const delta = emulator.repaintSince(revisions[client] ?? 0);
      frameDeltaBytes += delta.length;
      revisions[client] = emulator.revision;

      if (measured && client === 0 && delta.length > 0) {
        if (previousBuffer !== undefined && previousBuffer !== delta.buffer) {
          sharedBuffer = false;
        }

        previousBuffer = delta.buffer;
      }
    }

    const afterEncode = Bun.nanoseconds();

    if (measured) {
      feedNanoseconds += afterFeed - beforeFeed;
      encodeNanoseconds += afterEncode - afterFeed;
      fedBytes += payload?.length ?? 0;
      deltaBytes += frameDeltaBytes;
    }
  }

  emulator.dispose();

  const feedSeconds = feedNanoseconds / 1e9;

  return {
    scenario: scenario.name,
    size,
    bytesPerFramePerClient: deltaBytes / FRAMES / CLIENTS,
    encodeMicroseconds: encodeNanoseconds / 1000 / FRAMES,
    feedMicroseconds: feedNanoseconds / 1000 / FRAMES,
    feedMegabytesPerSecond:
      scenario.feedRate === undefined || feedSeconds === 0
        ? undefined
        : fedBytes / 1e6 / feedSeconds,
    feedRate: scenario.feedRate,
    sharedBuffer,
  };
}

function tableRow(cells: readonly string[]): string {
  return cells.map((cell, index) => cell.padStart(COLUMNS[index]?.[1] ?? 10)).join("  ");
}

for (const scenario of SCENARIOS) {
  for (const size of GRIDS) {
    measurements.push(measure(scenario, size));
  }
}

report(tableRow(COLUMNS.map(([label]) => label)));

for (const result of measurements) {
  const cpuPercent =
    ((result.feedMicroseconds + result.encodeMicroseconds) / (FRAME_MS * 1000)) * 100;

  report(
    tableRow([
      result.scenario,
      `${result.size.columns}×${result.size.rows}`,
      result.bytesPerFramePerClient.toFixed(0),
      ((result.bytesPerFramePerClient * FRAMES_PER_SECOND) / 1e6).toFixed(3),
      result.encodeMicroseconds.toFixed(1),
      result.feedMicroseconds.toFixed(1),
      cpuPercent.toFixed(1),
      result.sharedBuffer ? "yes" : "no",
    ]),
  );
}

for (const result of measurements) {
  if (result.feedMegabytesPerSecond !== undefined) {
    report(
      `feed rate, ${result.scenario} at ${result.size.columns}×${result.size.rows}: ${result.feedMegabytesPerSecond.toFixed(1)} MB/s`,
    );
  }
}

for (const result of measurements) {
  if (
    result.feedMegabytesPerSecond !== undefined &&
    result.bytesPerFramePerClient > WIRE_BUDGET_BYTES_PER_FRAME
  ) {
    failures.push(
      `${result.bytesPerFramePerClient.toFixed(0)} bytes/frame/client exceeds the ${WIRE_BUDGET_BYTES_PER_FRAME}-byte wire budget (${result.scenario}, ${result.size.columns}×${result.size.rows})`,
    );
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    report(`OVER BUDGET: ${failure}`);
  }

  process.exit(1);
}

report("all budget rows within docs/performance.md");
