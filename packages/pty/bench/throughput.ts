/**
 * The terminal-throughput budget, measured rather than asserted.
 *
 * Run by hand — `bun run bench` in `packages/pty` — and deliberately **not** a
 * test. The budget is ≥ 100 MB/s sustained with bounded memory
 * (docs/performance.md § Terminal throughput), and a three-second flood inside a
 * parallel `bun test` run measures the machine's load rather than this code. Until
 * a benchmark harness lands, the numbers belong in the pull request
 * (docs/testing.md § Performance tests).
 *
 * Four numbers, and each one guards a different failure:
 *
 * - **MB/s** off the PTY. The budget.
 * - **Worst timer lag.** How late an 8 ms drain actually fired. This is the
 *   event-loop-health number: a blocking call on the JavaScript thread shows up
 *   here before it shows up anywhere else.
 * - **Neighbour responsiveness.** One flooding terminal's effect on others must
 *   be none measurable.
 * - **RSS plateau with nobody draining.** Back-pressure is either real or it is
 *   an unbounded buffer, and this is the difference.
 */

import {
  COALESCING_WINDOW_MS,
  DEFAULT_TERMINAL_SIZE,
  DRAIN_BUFFER_SIZE,
  SIGNAL,
  spawnPseudoTerminal,
  type PseudoTerminal,
} from "../src/index.ts";

const FLOOD_MS = 3000;
const SETTLE_MS = 300;
const UNDRAINED_MS = 1500;

const ENVIRONMENT = { TERM: "xterm-256color", PATH: "/usr/bin:/bin", PS1: "" } as const;

function report(line: string): void {
  void Bun.write(Bun.stdout, `${line}\n`);
}

function start(executable: string, argumentVector: readonly string[]): PseudoTerminal {
  return spawnPseudoTerminal({
    executable,
    arguments: argumentVector,
    workingDirectory: "/tmp",
    environment: ENVIRONMENT,
    initialSize: DEFAULT_TERMINAL_SIZE,
  });
}

const flood = start("/usr/bin/yes", ["yes"]);
const neighbour = start("/bin/sh", ["sh", "-c", 'stty raw -echo; printf "READY\\n"; exec cat']);

const decoder = new TextDecoder();
let bytes = 0;
let drains = 0;
let largestDrain = 0;
let worstLagMs = 0;
let neighbourText = "";
let respondedAt: number | undefined;
let lastTick = performance.now();

const pump = setInterval(() => {
  const now = performance.now();
  worstLagMs = Math.max(worstLagMs, now - lastTick - COALESCING_WINDOW_MS);
  lastTick = now;

  const chunk = flood.drain();
  if (chunk !== undefined && chunk.length > 0) {
    bytes += chunk.length;
    drains += 1;
    largestDrain = Math.max(largestDrain, chunk.length);
  }
  const echoed = neighbour.drain();
  if (echoed !== undefined && echoed.length > 0) {
    neighbourText += decoder.decode(echoed, { stream: true });
    if (respondedAt === undefined && neighbourText.includes("RESPONSIVE")) {
      respondedAt = now;
    }
  }
}, COALESCING_WINDOW_MS);

const startedAt = performance.now();
await Bun.sleep(SETTLE_MS);
const askedAt = performance.now();
neighbour.write(new TextEncoder().encode("RESPONSIVE\n"));
await Bun.sleep(FLOOD_MS - SETTLE_MS);
const elapsedSeconds = (performance.now() - startedAt) / 1000;
clearInterval(pump);

const respondedIn =
  respondedAt === undefined
    ? "NEVER — a flood starved its neighbour"
    : `${(respondedAt - askedAt).toFixed(1)} ms`;

report(`throughput           ${(bytes / 1e6 / elapsedSeconds).toFixed(1)} MB/s (budget 100)`);
report(`total read           ${(bytes / 1e6).toFixed(1)} MB in ${elapsedSeconds.toFixed(2)} s`);
report(
  `drain calls          ${drains}, largest ${(largestDrain / 1e6).toFixed(2)} MB of ${(DRAIN_BUFFER_SIZE / 1e6).toFixed(2)} MB`,
);
report(`worst timer lag      ${worstLagMs.toFixed(1)} ms (window ${COALESCING_WINDOW_MS} ms)`);
report(`neighbour echoed     ${respondedIn}`);

// Nobody draining at all: the ring must stop growing rather than keep swallowing
// a 133 MB/s flood. The ceiling is the 4 MB high-water mark plus one 128 KB read.
const rssBefore = process.memoryUsage.rss();
await Bun.sleep(UNDRAINED_MS);
const rssAfter = process.memoryUsage.rss();
report(
  `RSS while undrained  +${((rssAfter - rssBefore) / 1e6).toFixed(1)} MB over ${UNDRAINED_MS} ms (ring ceiling 4.13 MB)`,
);

flood.signal(SIGNAL.SIGKILL);
flood.close();
neighbour.close();
process.exit(0);
