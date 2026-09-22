import { afterEach, describe, expect, test } from "bun:test";
import { chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { TERMINAL_WATER_MARKS } from "@janela/support";
import { temporaryDirectory } from "@janela/test-support";
import { Effect, Option, Result } from "effect";

import type { NativePtyLibrary } from "./bindings.ts";
import {
  CouldNotAllocateTerminal,
  CouldNotStart,
  CTRL_C,
  DEFAULT_TERMINAL_SIZE,
  DRAIN_BUFFER_SIZE,
  hangUpEveryPseudoTerminal,
  NotRunning,
  PseudoTerminalFailure,
  pseudoTerminalFailureLabel,
  READ_SIZE,
  ReadFailed,
  SIGNAL,
  spawnPseudoTerminal,
  type PseudoTerminal,
  type PseudoTerminalFailureDetail,
} from "./index.ts";

interface Repeating extends Disposable {
  readonly ticks: number;
}

const DEADLINE_MS = 15_000;

const POLL_MS = 4;

const RING_CEILING = TERMINAL_WATER_MARKS.highWater + READ_SIZE;

const HERMETIC_ENVIRONMENT = { TERM: "xterm-256color", PATH: "/usr/bin:/bin" };

const NEWLINE = new Uint8Array([0x0a]);

const started: PseudoTerminal[] = [];

const probeProcess = Option.liftThrowable((pid: number) => process.kill(pid, 0));

afterEach(() => {
  let terminal = started.pop();

  while (terminal !== undefined) {
    terminal.close();
    terminal = started.pop();
  }
});

function spawn(
  executable: string,
  argumentVector: readonly string[],
  environment: Readonly<Record<string, string>> = HERMETIC_ENVIRONMENT,
): PseudoTerminal {
  const terminal = spawnPseudoTerminal({
    executable,
    arguments: argumentVector,
    workingDirectory: tmpdir(),
    environment,
    initialSize: DEFAULT_TERMINAL_SIZE,
  });

  started.push(terminal);

  return terminal;
}

function shell(script: string): PseudoTerminal {
  return spawn("/bin/sh", ["sh", "-c", script]);
}

function shellExporting(script: string, replicaPathVariable: string): PseudoTerminal {
  const terminal = spawnPseudoTerminal({
    executable: "/bin/sh",
    arguments: ["sh", "-c", script],
    workingDirectory: tmpdir(),
    environment: HERMETIC_ENVIRONMENT,
    initialSize: DEFAULT_TERMINAL_SIZE,
    replicaPathVariable,
  });

  started.push(terminal);

  return terminal;
}

function poll(
  step: () => boolean,
  describeTimeout: () => string,
  timeoutMs = DEADLINE_MS,
): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const stepped = Effect.runSync(
      Effect.result(Effect.try({ try: step, catch: (cause) => cause })),
    );

    if (Result.isFailure(stepped)) {
      clearInterval(timer);
      reject(stepped.failure);

      return;
    }

    if (stepped.success) {
      clearInterval(timer);
      resolve();

      return;
    }

    if (Date.now() - startedAt > timeoutMs) {
      clearInterval(timer);
      reject(new Error(describeTimeout()));
    }
  }, POLL_MS);

  return promise;
}

async function drainUntil(
  terminal: PseudoTerminal,
  pattern: RegExp,
  timeoutMs = DEADLINE_MS,
): Promise<string> {
  const decoder = new TextDecoder();
  let seen = "";

  await poll(
    () => {
      const chunk = terminal.drain();

      if (chunk === undefined) {
        if (pattern.test(seen)) {
          return true;
        }

        throw new Error(`the child exited before ${pattern} appeared in ${JSON.stringify(seen)}`);
      }

      if (chunk.length > 0) {
        seen += decoder.decode(chunk, { stream: true });
      }

      return pattern.test(seen);
    },
    () => `timed out waiting for ${pattern} in ${JSON.stringify(seen)}`,
    timeoutMs,
  );

  return seen;
}

async function drainToEnd(terminal: PseudoTerminal, timeoutMs = DEADLINE_MS): Promise<string> {
  const decoder = new TextDecoder();
  let seen = "";

  await poll(
    () => {
      const chunk = terminal.drain();

      if (chunk === undefined) {
        return true;
      }

      if (chunk.length > 0) {
        seen += decoder.decode(chunk, { stream: true });
      }

      return false;
    },
    () => `timed out waiting for the child to exit after ${JSON.stringify(seen)}`,
    timeoutMs,
  );

  return seen;
}

async function drainBytes(
  terminal: PseudoTerminal,
  count: number,
  timeoutMs = DEADLINE_MS,
): Promise<Uint8Array> {
  const collected = new Uint8Array(count);
  let filled = 0;

  await poll(
    () => {
      const chunk = terminal.drain();

      if (chunk === undefined) {
        throw new Error(`the child exited after ${filled} of ${count} bytes`);
      }

      if (chunk.length > 0) {
        const taken = Math.min(chunk.length, count - filled);

        collected.set(chunk.subarray(0, taken), filled);
        filled += taken;
      }

      return filled === count;
    },
    () => `timed out after ${filled} of ${count} bytes`,
    timeoutMs,
  );

  return collected;
}

function repeating(action: () => void, everyMs: number): Repeating {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
    action();
  }, everyMs);

  return {
    get ticks(): number {
      return ticks;
    },
    [Symbol.dispose](): void {
      clearInterval(timer);
    },
  };
}

function detailOf(run: () => void): PseudoTerminalFailureDetail {
  const outcome = Effect.runSync(Effect.result(Effect.try({ try: run, catch: (cause) => cause })));
  const failure = Result.getFailure(outcome);

  if (Option.isNone(failure)) throw new Error("expected a PseudoTerminalFailure");

  const error = failure.value;

  if (!(error instanceof PseudoTerminalFailure)) throw error;

  return error.detail;
}

function scriptedTerminal(read: bigint, exitCode: number): PseudoTerminal {
  const library: NativePtyLibrary = {
    jpty_spawn: () => 4097,
    jpty_read: () => read,
    jpty_write: () => 0n,
    jpty_resize: () => 0,
    jpty_signal: () => 0,
    jpty_exit_code: () => exitCode,
    jpty_close: () => undefined,
    jpty_drop_all: () => 0,
    jpty_peer_credential: () => -1n,
  };

  return spawnPseudoTerminal(
    {
      executable: "/bin/cat",
      arguments: ["cat"],
      workingDirectory: tmpdir(),
      environment: { PATH: "/usr/bin:/bin" },
      initialSize: DEFAULT_TERMINAL_SIZE,
    },
    library,
  );
}

describe("spawning and reading", () => {
  test("output arrives, and the exit status is readable in the tick the stream ended", async () => {
    const terminal = shell('stty raw -echo; printf "JANELA_ECHO_OK\\n"; read _');

    expect(terminal.pid).toBeGreaterThan(0);

    await drainUntil(terminal, /JANELA_ECHO_OK/);
    terminal.write(NEWLINE);
    await drainToEnd(terminal);

    expect(terminal.exitCode()).toBe(0);
  });

  test("a signal death is reported as 128 + signo, matching a shell", async () => {
    const terminal = shell("kill -TERM $$");

    await drainToEnd(terminal);

    expect(terminal.exitCode()).toBe(128 + SIGNAL.SIGTERM);
  });

  test("every byte survives a round trip through a raw tty, with no echo and no ONLCR", async () => {
    const terminal = shell('stty raw -echo; printf "JANELA_RAW_READY\\n"; exec cat');

    await drainUntil(terminal, /JANELA_RAW_READY/);

    const payload = new Uint8Array(256);

    for (let value = 0; value < payload.length; value += 1) {
      payload[value] = value;
    }

    terminal.write(payload);

    expect(await drainBytes(terminal, payload.length)).toEqual(payload);
  });

  test("hanging up reaches the child, which reports 128 + SIGHUP", async () => {
    const terminal = shell('stty raw -echo; printf "JANELA_HUP_READY\\n"; exec cat');

    await drainUntil(terminal, /JANELA_HUP_READY/);
    terminal.close();
    await poll(
      () => terminal.exitCode() !== undefined,
      () => "the hung-up child never reported an exit status",
    );

    expect(terminal.exitCode()).toBe(128 + SIGNAL.SIGHUP);
  });

  test("closing returns immediately while a read is pending, rather than hanging", async () => {
    const terminal = spawn("/usr/bin/yes", ["yes"]);

    await drainUntil(terminal, /y/);

    const before = performance.now();

    terminal.close();

    expect(performance.now() - before).toBeLessThan(250);
  });
});

describe("the replica path variable", () => {
  test("a child writing to the named variable reaches its own terminal", async () => {
    const terminal = shellExporting('printf marker > "$JANELA_TTY"', "JANELA_TTY");

    expect(await drainUntil(terminal, /marker/)).toContain("marker");
  });

  test("no variable is exported when the configuration does not name one", async () => {
    const terminal = shell('printf "[%s]" "$JANELA_TTY"');

    expect(await drainUntil(terminal, /\[]/)).toContain("[]");
  });
});

describe("the window size", () => {
  test("a resize delivers SIGWINCH, and the child reads the new cell dimensions", async () => {
    const terminal = shell(
      'trap "stty size" WINCH; echo JANELA_WINCH_READY; while :; do sleep 0.1; done',
    );

    await drainUntil(terminal, /JANELA_WINCH_READY/);
    terminal.resize({ columns: 120, rows: 40, pixelWidth: 1920, pixelHeight: 1080 });
    await drainUntil(terminal, /40 120/);
  });

  test("a garbage size from a client is clamped into u16, never passed to the ioctl", async () => {
    const terminal = shell(
      'trap "stty size" WINCH; echo JANELA_CLAMP_READY; while :; do sleep 0.1; done',
    );

    await drainUntil(terminal, /JANELA_CLAMP_READY/);
    terminal.resize({
      columns: 999_999,
      rows: -4,
      pixelWidth: Number.NaN,
      pixelHeight: Number.POSITIVE_INFINITY,
    });

    await drainUntil(terminal, /0 65535/);
  });
});

describe("signals and job control", () => {
  test("Ctrl-C is the byte 0x03, and the line discipline signals the foreground group", async () => {
    const terminal = shell(
      'trap "echo JANELA_INTERRUPTED" INT; echo JANELA_INT_READY; while :; do sleep 0.1; done',
    );

    await drainUntil(terminal, /JANELA_INT_READY/);
    terminal.write(new Uint8Array([CTRL_C]));
    await drainUntil(terminal, /JANELA_INTERRUPTED/);
  });

  test("hanging up reaches a grandchild, so the signal goes to the process group", async () => {
    const terminal = shell("set +m; sleep 300 & echo JANELA_GC=$!; wait");
    const seen = await drainUntil(terminal, /JANELA_GC=\d+/);
    const grandchild = Number(/JANELA_GC=(\d+)/.exec(seen)?.[1]);

    expect(grandchild).toBeGreaterThan(0);
    expect(Option.isSome(probeProcess(grandchild))).toBe(true);

    terminal.close();
    await poll(
      () => Option.isNone(probeProcess(grandchild)),
      () => `grandchild ${grandchild} survived the hangup`,
    );
  });

  test("signal dispositions are reset before exec, so an inherited ignored SIGPIPE cannot stick", async () => {
    const terminal = shell("yes | head -1 >/dev/null; echo JANELA_SIGPIPE_OK");

    await drainUntil(terminal, /JANELA_SIGPIPE_OK/);
  });

  test("hanging up everything reaches every child of every terminal", async () => {
    const first = shell("set +m; sleep 300 & echo JANELA_ALL_A=$!; wait");
    const second = shell("set +m; sleep 300 & echo JANELA_ALL_B=$!; wait");
    const pids = [
      Number(/JANELA_ALL_A=(\d+)/.exec(await drainUntil(first, /JANELA_ALL_A=\d+/))?.[1]),
      Number(/JANELA_ALL_B=(\d+)/.exec(await drainUntil(second, /JANELA_ALL_B=\d+/))?.[1]),
    ];

    expect(hangUpEveryPseudoTerminal()).toBeGreaterThanOrEqual(2);

    await poll(
      () => pids.every((pid) => Option.isNone(probeProcess(pid))),
      () => `grandchildren ${pids.join(", ")} survived the sweep`,
    );
  });
});

describe("marshalling", () => {
  test("argv arrives verbatim: an empty element, a space, a tab and a multi-byte character", async () => {
    const terminal = spawn("/bin/sh", [
      "sh",
      "-c",
      'stty raw -echo; printf "[%s]\\n" "$@"; printf "JANELA_ARGV_DONE\\n"; read _',
      "sh",
      "",
      "a b",
      "a\tb",
      "héllo→",
    ]);

    const seen = await drainUntil(terminal, /JANELA_ARGV_DONE/);

    terminal.write(NEWLINE);
    await drainToEnd(terminal);

    expect(seen).toContain("[]");
    expect(seen).toContain("[a b]");
    expect(seen).toContain("[a\tb]");
    expect(seen).toContain("[héllo→]");
    expect(terminal.exitCode()).toBe(0);
  });

  test("a large environment arrives whole: 200 variables, one of them 4 KB", async () => {
    const large = "v".repeat(4096);
    const many = Array.from({ length: 200 }, (_, index): readonly [string, string] => [
      `JANELA_VAR_${index}`,
      index === 7 ? large : `value-${index}`,
    ]);

    const environment = { ...HERMETIC_ENVIRONMENT, ...Object.fromEntries(many) };
    const terminal = spawn(
      "/bin/sh",
      ["sh", "-c", 'stty raw -echo; env; printf "JANELA_ENV_DONE\\n"; read _'],
      environment,
    );

    const seen = await drainUntil(terminal, /JANELA_ENV_DONE/);

    terminal.write(NEWLINE);
    await drainToEnd(terminal);

    expect(seen).toContain(`JANELA_VAR_7=${large}`);
    expect(seen).toContain("JANELA_VAR_199=value-199");
    expect(seen.split("\n").filter((line) => line.startsWith("JANELA_VAR_"))).toHaveLength(200);
  });
});

describe("failures", () => {
  test("a missing executable and an unexecutable one relay the child's own errno", async () => {
    await using directory = await temporaryDirectory("pty-exec");

    const missing = directory.join("not-here");

    expect(detailOf(() => spawn(missing, ["not-here"]))).toEqual(
      new CouldNotStart({ path: missing, errno: 2 }),
    );

    const unexecutable = directory.join("not-executable");

    await writeFile(unexecutable, "#!/bin/sh\n");
    await chmod(unexecutable, 0o644);

    expect(detailOf(() => spawn(unexecutable, ["not-executable"]))).toEqual(
      new CouldNotStart({ path: unexecutable, errno: 13 }),
    );
  });

  test("a working directory that no longer exists fails the spawn rather than running elsewhere", async () => {
    const directory = await temporaryDirectory("pty-cwd");

    await directory[Symbol.asyncDispose]();

    const detail = detailOf(() =>
      spawnPseudoTerminal({
        executable: "/bin/echo",
        arguments: ["echo", "unreachable"],
        workingDirectory: directory.path,
        environment: { PATH: "/usr/bin:/bin" },
        initialSize: DEFAULT_TERMINAL_SIZE,
      }),
    );

    expect(detail).toEqual(new CouldNotStart({ path: "/bin/echo", errno: 2 }));
  });

  test("a stale handle answers notRunning without panicking across the FFI boundary", async () => {
    const terminal = spawn("/usr/bin/yes", ["yes"]);

    await drainUntil(terminal, /y/);
    terminal.close();

    expect(terminal.drain()).toBeUndefined();
    expect(detailOf(() => terminal.write(new Uint8Array([CTRL_C])))).toEqual(new NotRunning());
    expect(detailOf(() => terminal.resize(DEFAULT_TERMINAL_SIZE))).toEqual(new NotRunning());
    expect(detailOf(() => terminal.signal(SIGNAL.SIGTERM))).toEqual(new NotRunning());

    const survivor = shell("echo JANELA_STILL_ALIVE");

    await drainUntil(survivor, /JANELA_STILL_ALIVE/);
  });

  test("close is idempotent and never throws", async () => {
    const terminal = shell("echo JANELA_IDEMPOTENT");

    await drainUntil(terminal, /JANELA_IDEMPOTENT/);
    terminal.close();
    terminal.close();

    expect(terminal.drain()).toBeUndefined();
  });

  test("the headline stays a sentence and the errno rides in the detail", () => {
    const failure = new PseudoTerminalFailure(new ReadFailed({ errno: 5 }));

    expect(failure.summary).toBe("Couldn't read from this terminal.");
    expect(new PseudoTerminalFailure(new NotRunning()).summary).toBe(
      "This terminal isn't running.",
    );

    expect(
      new PseudoTerminalFailure(new CouldNotStart({ path: "/bin/sh", errno: 2 })).summary,
    ).toBe("Couldn't start /bin/sh.");

    expect(new PseudoTerminalFailure(new CouldNotAllocateTerminal({ errno: 24 })).summary).toBe(
      "Couldn't open a terminal.",
    );

    expect(pseudoTerminalFailureLabel(failure.detail)).toBe("readFailed");
  });
});

describe("read failure", () => {
  const READ_FAILED_EIO = -3005n;

  test("a lost descriptor latches readFailure, and the exit status is not lost", () => {
    const terminal = scriptedTerminal(READ_FAILED_EIO, 129);

    expect(terminal.drain()).toBeUndefined();
    expect(terminal.readFailure?.detail).toEqual(new ReadFailed({ errno: 5 }));
    expect(terminal.readFailure?.summary).toBe("Couldn't read from this terminal.");
    expect(terminal.exitCode()).toBe(129);
  });

  test("draining again reports the same latched failure, never a second object", () => {
    const terminal = scriptedTerminal(READ_FAILED_EIO, 129);
    const first = terminal.drain();
    const latched = terminal.readFailure;

    expect(first).toBeUndefined();
    expect(terminal.drain()).toBeUndefined();
    expect(terminal.readFailure).toBe(latched);
  });

  test("EOF is one above the failure band and leaves readFailure unset", () => {
    const terminal = scriptedTerminal(-1n, 0);

    expect(terminal.drain()).toBeUndefined();
    expect(terminal.readFailure).toBeUndefined();
    expect(terminal.exitCode()).toBe(0);
  });

  test("a child that simply finished is an end of stream, not a lost descriptor", async () => {
    const terminal = spawn("/bin/echo", ["echo", "JANELA_EOF_OK"]);

    await drainToEnd(terminal);

    expect(terminal.readFailure).toBeUndefined();
    expect(terminal.exitCode()).toBe(0);
  });
});

describe("back-pressure", () => {
  test("an empty drain is an empty view, allocated once per terminal", () => {
    const terminal = shell("exec sleep 300");

    expect(terminal.drain()).toEqual(new Uint8Array(0));
    expect(terminal.drain()).toBe(terminal.drain());
  });

  test("a drain is a view into a reusable buffer, never a copy", async () => {
    const terminal = spawn("/usr/bin/yes", ["yes"]);
    const first = terminal.drain();

    await drainUntil(terminal, /y/);

    const second = terminal.drain();

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second?.buffer).toBe(first?.buffer);
    expect(second?.byteLength).toBeLessThanOrEqual(DRAIN_BUFFER_SIZE);
  });

  test("reading resumes after a backlog drains, and one drain never exceeds its bound", async () => {
    const terminal = spawn("/usr/bin/yes", ["yes"]);

    await drainUntil(terminal, /y/);
    await Bun.sleep(500);

    let total = 0;
    let largest = 0;

    await poll(
      () => {
        const chunk = terminal.drain();

        if (chunk === undefined) {
          throw new Error("`yes` exited, which it does not do");
        }

        largest = Math.max(largest, chunk.byteLength);
        total += chunk.byteLength;

        return total > RING_CEILING * 2;
      },
      () => `the reader stalled: ${total} bytes drained, largest ${largest}`,
      30_000,
    );

    expect(total).toBeGreaterThan(RING_CEILING * 2);
    expect(largest).toBeLessThanOrEqual(DRAIN_BUFFER_SIZE);
  }, 45_000);

  test("a backlog larger than the ring hands back every byte, in order", async () => {
    const expected = new TextEncoder().encode(
      `${Array.from({ length: 800_000 }, (_, index) => String(index + 1)).join("\n")}\n`,
    );

    expect(expected.byteLength).toBeGreaterThan(RING_CEILING);

    await using directory = await temporaryDirectory("pty-backlog");

    const payload = directory.join("payload");

    await writeFile(payload, expected);

    const terminal = spawn("/bin/sh", [
      "sh",
      "-c",
      'stty raw -echo; exec cat "$1"',
      "janela-payload",
      payload,
    ]);

    await Bun.sleep(500);

    const collected = new Uint8Array(expected.byteLength);
    let filled = 0;
    let largest = 0;

    await poll(
      () => {
        const chunk = terminal.drain();

        if (chunk === undefined) {
          return true;
        }

        if (chunk.byteLength === 0) {
          return false;
        }

        if (filled + chunk.byteLength > collected.length) {
          throw new Error(`more bytes than the payload holds: ${filled + chunk.byteLength}`);
        }

        collected.set(chunk, filled);
        filled += chunk.byteLength;
        largest = Math.max(largest, chunk.byteLength);

        return false;
      },
      () => `timed out after ${filled} of ${collected.length} bytes`,
      30_000,
    );

    expect(filled).toBe(expected.byteLength);
    expect(largest).toBeLessThanOrEqual(DRAIN_BUFFER_SIZE);

    let mismatch = -1;

    for (let index = 0; index < expected.length; index += 1) {
      if (collected[index] !== expected[index]) {
        mismatch = index;

        break;
      }
    }

    expect(mismatch).toBe(-1);
  }, 45_000);

  test("a flooding terminal does not stall its neighbour", async () => {
    const flood = spawn("/usr/bin/yes", ["yes"]);
    const neighbour = shell('stty raw -echo; printf "JANELA_NEIGHBOUR_READY\\n"; exec cat');

    await drainUntil(neighbour, /JANELA_NEIGHBOUR_READY/);

    using flooding = repeating(() => void flood.drain(), POLL_MS);

    neighbour.write(new TextEncoder().encode("JANELA_STILL_RESPONSIVE\n"));
    await drainUntil(neighbour, /JANELA_STILL_RESPONSIVE/);

    expect(flooding.ticks).toBeGreaterThan(0);
  }, 30_000);
});
