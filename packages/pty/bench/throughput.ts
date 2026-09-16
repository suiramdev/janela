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

const THROUGHPUT_BUDGET_MB_PER_SECOND = 100;

const RING_CEILING_MB = 4.13;

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

async function measure(): Promise<void> {
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

  report(
    `throughput           ${(bytes / 1e6 / elapsedSeconds).toFixed(1)} MB/s (budget ${THROUGHPUT_BUDGET_MB_PER_SECOND})`,
  );
  report(`total read           ${(bytes / 1e6).toFixed(1)} MB in ${elapsedSeconds.toFixed(2)} s`);
  report(
    `drain calls          ${drains}, largest ${(largestDrain / 1e6).toFixed(2)} MB of ${(DRAIN_BUFFER_SIZE / 1e6).toFixed(2)} MB`,
  );
  report(`worst timer lag      ${worstLagMs.toFixed(1)} ms (window ${COALESCING_WINDOW_MS} ms)`);
  report(`neighbour echoed     ${respondedIn}`);
  report(`read failure         ${flood.readFailure?.summary ?? "none"}`);

  const rssBefore = process.memoryUsage.rss();

  await Bun.sleep(UNDRAINED_MS);

  const rssAfter = process.memoryUsage.rss();

  report(
    `RSS while undrained  +${((rssAfter - rssBefore) / 1e6).toFixed(1)} MB over ${UNDRAINED_MS} ms (ring ceiling ${RING_CEILING_MB} MB)`,
  );

  flood.signal(SIGNAL.SIGKILL);
  flood.close();
  neighbour.close();
}

await measure();

process.exit(0);
