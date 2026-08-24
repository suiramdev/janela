/**
 * `PseudoTerminal` against real pseudo-terminals and real children.
 *
 * PTYs are the canonical thing this repository refuses to fake: controlling
 * terminals, job control, `SIGWINCH` and back-pressure are exactly what a fake
 * would paper over. So every test here spawns something.
 *
 * **On timers.** Everything below polls a real clock, and there is no version of
 * this file that does not: the thing under test is a child process writing into a
 * kernel PTY buffer, so there is no scheduler to fake — the daemon's own drain is
 * a timer too. What is avoided is the half of the problem that actually flakes:
 * nothing here sleeps for a guessed duration and then asserts. Every wait is
 * "drain until this marker appears, or fail at a deadline", and the one real
 * delay is setup for a buffer that has to fill, with assertions that do not
 * depend on how full it got.
 *
 * Nothing touches a fixed path either; the tests that need a directory make
 * their own under `os.tmpdir()` and remove it.
 *
 * Two checklist items are asserted in `native/src/lib.rs`'s `cargo test` module
 * instead, because they are only observable from the other side of the boundary:
 * `ws_xpixel`/`ws_ypixel` reaching the kernel, which no stock CLI reports, and
 * the child's close-every-descriptor loop, which needs a parent deliberately
 * holding a descriptor without `FD_CLOEXEC`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TERMINAL_WATER_MARKS } from "@janela/support";

import {
  CTRL_C,
  DEFAULT_TERMINAL_SIZE,
  DRAIN_BUFFER_SIZE,
  hangUpEveryPseudoTerminal,
  PseudoTerminalFailure,
  READ_SIZE,
  SIGNAL,
  spawnPseudoTerminal,
  type PseudoTerminal,
  type PseudoTerminalFailureDetail,
} from "./index.ts";

/** Generous on purpose: the failure it guards is a hang, not a slow pass. */
const DEADLINE_MS = 15_000;
/** Roughly one frame, which is how often the daemon itself drains. */
const POLL_MS = 4;
/** The ring's structural ceiling: its gate is tested before a read, not after. */
const RING_CEILING = TERMINAL_WATER_MARKS.highWater + READ_SIZE;

const started: PseudoTerminal[] = [];

afterEach(() => {
  let terminal = started.pop();
  while (terminal !== undefined) {
    terminal.close();
    terminal = started.pop();
  }
});

/** A hermetic environment: nothing here depends on the developer's profile. */
function spawn(
  executable: string,
  argumentVector: readonly string[],
  environment: Readonly<Record<string, string>> = { TERM: "xterm-256color", PATH: "/usr/bin:/bin" },
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

/** A `/bin/sh` script, which is how most of these children are expressed. */
function shell(script: string): PseudoTerminal {
  return spawn("/bin/sh", ["sh", "-c", script]);
}

/** Runs `step` once per frame until it reports done, or fails at a deadline. */
function poll(
  step: () => boolean,
  describeTimeout: () => string,
  timeoutMs = DEADLINE_MS,
): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const startedAt = Date.now();
  const timer = setInterval(() => {
    try {
      if (step()) {
        clearInterval(timer);
        resolve();
        return;
      }
    } catch (error) {
      clearInterval(timer);
      reject(error);
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

/** Everything the child produces, up to the moment the stream reports it gone. */
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

/** Collects raw bytes, for the cases where the point is byte fidelity. */
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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The detail of the failure `call` produces, or a failure of its own. */
function detailOf(call: () => unknown): PseudoTerminalFailureDetail {
  try {
    call();
  } catch (error) {
    if (error instanceof PseudoTerminalFailure) {
      return error.detail;
    }
    throw error;
  }
  throw new Error("expected a PseudoTerminalFailure, and nothing was thrown");
}

describe("spawning and reading", () => {
  test("output arrives and the exit status is 0", async () => {
    const terminal = spawn("/bin/echo", ["echo", "JANELA_ECHO_OK"]);
    expect(terminal.pid).toBeGreaterThan(0);
    await drainUntil(terminal, /JANELA_ECHO_OK/);
    await drainToEnd(terminal);
    // In the same tick, with no polling: the native side stores the exit code
    // before it closes the ring, so a stream that reports the child gone can
    // never leave the status unavailable.
    expect(terminal.exitCode()).toBe(0);
  });

  test("a signal death is reported as 128 + signo", async () => {
    const terminal = shell("kill -TERM $$");
    await drainToEnd(terminal);
    expect(terminal.exitCode()).toBe(128 + SIGNAL.SIGTERM);
  });

  test("arbitrary bytes survive a round trip through the tty", async () => {
    // Raw mode is the point: no echo and no ONLCR, so this asserts the byte
    // fidelity that disqualified a string-only PTY package (ADR 0021).
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

  test("closing returns immediately while a read is pending", async () => {
    // The historical failure is a hang, not a slow return: closing a descriptor
    // another thread is blocked reading blocks the closer indefinitely on
    // Darwin. `yes` guarantees a read is in flight, and the bound is loose
    // because it only has to separate 0.4 ms from forever.
    const terminal = spawn("/usr/bin/yes", ["yes"]);
    await drainUntil(terminal, /y/);

    const before = performance.now();
    terminal.close();
    expect(performance.now() - before).toBeLessThan(250);
  });
});

describe("the window size", () => {
  test("a resize delivers SIGWINCH with the new cell dimensions", async () => {
    const terminal = shell(
      'trap "stty size" WINCH; echo JANELA_WINCH_READY; while :; do sleep 0.1; done',
    );
    // The marker is what makes this deterministic. Resizing before the trap is
    // installed is a race, and a sleep instead of a marker is that race with a
    // longer fuse.
    await drainUntil(terminal, /JANELA_WINCH_READY/);
    terminal.resize({ columns: 120, rows: 40, pixelWidth: 1920, pixelHeight: 1080 });
    // `stty size` prints rows then columns. The pixel fields it cannot show are
    // asserted through TIOCGWINSZ in the cargo test module.
    await drainUntil(terminal, /40 120/);
  });

  test("a garbage size from a client cannot become a garbage ioctl", async () => {
    const terminal = shell(
      'trap "stty size" WINCH; echo JANELA_CLAMP_READY; while :; do sleep 0.1; done',
    );
    await drainUntil(terminal, /JANELA_CLAMP_READY/);
    // Pixel metrics are a client-supplied fact, and a client is allowed to be
    // wrong. Every field is clamped into `u16` at the boundary.
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
  test("Ctrl-C is the byte 0x03, interpreted by the line discipline", async () => {
    // Not `signal(SIGINT)`. Writing the byte is what a real terminal does, and
    // the only thing that is correct once a shell has put a pipeline in its own
    // process group. It doubles as a disposition test: a shell may not trap a
    // signal it inherited as ignored, and a JavaScript runtime ignores plenty.
    //
    // The foreground job is a loop of short sleeps rather than one long one, and
    // that is load-bearing rather than incidental. Writing the byte races the
    // shell's own `fork`: lose the race and SIGINT reaches only the shell, which
    // queues its trap behind whatever command it goes on to start. Queued behind
    // `sleep 300` the trap fires five minutes late, which is a hung test;
    // queued behind `sleep 0.1` it fires within a frame. Measured: 25 failures
    // in 150 runs with a single `sleep 300`, and 0 in 1000 with this.
    const terminal = shell(
      'trap "echo JANELA_INTERRUPTED" INT; echo JANELA_INT_READY; while :; do sleep 0.1; done',
    );
    await drainUntil(terminal, /JANELA_INT_READY/);
    terminal.write(new Uint8Array([CTRL_C]));
    await drainUntil(terminal, /JANELA_INTERRUPTED/);
  });

  test("hanging up reaches a grandchild, so killpg rather than kill", async () => {
    // `set +m` is load-bearing: with job control off the background job stays in
    // the shell's process group, which is exactly the case `killpg` reaches and
    // a `kill` on the direct child does not.
    const terminal = shell("set +m; sleep 300 & echo JANELA_GC=$!; wait");
    const seen = await drainUntil(terminal, /JANELA_GC=\d+/);
    const grandchild = Number(/JANELA_GC=(\d+)/.exec(seen)?.[1]);
    expect(grandchild).toBeGreaterThan(0);
    expect(isAlive(grandchild)).toBe(true);

    terminal.close();
    await poll(
      () => !isAlive(grandchild),
      () => `grandchild ${grandchild} survived the hangup`,
    );
  });

  test("signal dispositions are reset before exec", async () => {
    // A JavaScript runtime ignores SIGPIPE. Inherited, `yes` gets EPIPE forever
    // and the marker never arrives, so the deadline is the assertion.
    const terminal = shell("yes | head -1 >/dev/null; echo JANELA_SIGPIPE_OK");
    await drainUntil(terminal, /JANELA_SIGPIPE_OK/);
  });

  test("hanging up everything reaches every child", async () => {
    const first = shell("set +m; sleep 300 & echo JANELA_ALL_A=$!; wait");
    const second = shell("set +m; sleep 300 & echo JANELA_ALL_B=$!; wait");
    const pids = [
      Number(/JANELA_ALL_A=(\d+)/.exec(await drainUntil(first, /JANELA_ALL_A=\d+/))?.[1]),
      Number(/JANELA_ALL_B=(\d+)/.exec(await drainUntil(second, /JANELA_ALL_B=\d+/))?.[1]),
    ];

    expect(hangUpEveryPseudoTerminal()).toBeGreaterThanOrEqual(2);
    await poll(
      () => pids.every((pid) => !isAlive(pid)),
      () => `grandchildren ${pids.join(", ")} survived the sweep`,
    );
  });
});

describe("marshalling", () => {
  test("argv arrives verbatim, whatever is in it", async () => {
    // A use-after-free cannot be asserted absent, so this asserts the failure a
    // wrong or truncated pointer array produces instead: an empty element, an
    // embedded space, a tab and a multi-byte character, none of which survive a
    // command line that is parsed anywhere on this path.
    const terminal = spawn("/usr/bin/printf", ["printf", "[%s]\n", "", "a b", "a\tb", "héllo→"]);
    const seen = await drainToEnd(terminal);
    expect(seen).toContain("[]");
    expect(seen).toContain("[a b]");
    expect(seen).toContain("[a\tb]");
    expect(seen).toContain("[héllo→]");
    expect(terminal.exitCode()).toBe(0);
  });

  test("a large environment arrives whole", async () => {
    const large = "v".repeat(4096);
    const environment: Record<string, string> = { TERM: "xterm-256color", PATH: "/usr/bin:/bin" };
    for (let index = 0; index < 200; index += 1) {
      environment[`JANELA_VAR_${index}`] = index === 7 ? large : `value-${index}`;
    }

    // `env` rather than a shell, because a shell adds PWD, SHLVL and _ of its
    // own and the assertion is that nothing was lost, not roughly how much.
    const terminal = spawn("/usr/bin/env", ["env"], environment);
    const seen = await drainToEnd(terminal);

    expect(seen).toContain(`JANELA_VAR_7=${large}`);
    expect(seen).toContain("JANELA_VAR_199=value-199");
    expect(seen.split("\n").filter((line) => line.startsWith("JANELA_VAR_"))).toHaveLength(200);
  });
});

describe("failures", () => {
  test("a missing executable and an unexecutable one are different errnos", async () => {
    // Two errnos down one code path is what proves the child's errno is relayed
    // rather than classified from the parent's guess.
    const directory = await mkdtemp(join(tmpdir(), "janela-pty-"));
    try {
      const missing = join(directory, "not-here");
      expect(detailOf(() => spawn(missing, ["not-here"]))).toEqual({
        kind: "couldNotStart",
        path: missing,
        errno: 2,
      });

      const unexecutable = join(directory, "not-executable");
      await writeFile(unexecutable, "#!/bin/sh\n");
      await chmod(unexecutable, 0o644);
      expect(detailOf(() => spawn(unexecutable, ["not-executable"]))).toEqual({
        kind: "couldNotStart",
        path: unexecutable,
        errno: 13,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a working directory that no longer exists is fatal, not silent", async () => {
    // The bug this closes is an agent running a destructive command in the wrong
    // tree, which is what ignoring `chdir`'s result gets you.
    const directory = await mkdtemp(join(tmpdir(), "janela-pty-"));
    await rm(directory, { recursive: true, force: true });
    const detail = detailOf(() =>
      spawnPseudoTerminal({
        executable: "/bin/echo",
        arguments: ["echo", "unreachable"],
        workingDirectory: directory,
        environment: { PATH: "/usr/bin:/bin" },
        initialSize: DEFAULT_TERMINAL_SIZE,
      }),
    );
    expect(detail).toEqual({ kind: "couldNotStart", path: "/bin/echo", errno: 2 });
  });

  test("a hung-up terminal answers notRunning rather than crashing the process", async () => {
    const terminal = spawn("/usr/bin/yes", ["yes"]);
    await drainUntil(terminal, /y/);
    terminal.close();

    expect(terminal.drain()).toBeUndefined();
    expect(detailOf(() => terminal.write(new Uint8Array([CTRL_C])))).toEqual({
      kind: "notRunning",
    });
    expect(detailOf(() => terminal.resize(DEFAULT_TERMINAL_SIZE))).toEqual({ kind: "notRunning" });
    expect(detailOf(() => terminal.signal(SIGNAL.SIGTERM))).toEqual({ kind: "notRunning" });

    // The actual claim: a stale handle is an error, not a panic across the FFI
    // boundary. So the process is still here, and still able to spawn.
    const survivor = shell("echo JANELA_STILL_ALIVE");
    await drainUntil(survivor, /JANELA_STILL_ALIVE/);
  });

  test("close is idempotent and never throws", async () => {
    const terminal = shell("echo JANELA_IDEMPOTENT");
    await drainUntil(terminal, /JANELA_IDEMPOTENT/);
    terminal.close();
    terminal.close();
    expect(terminal.drain()).toBeUndefined();
    // The errno rides in the detail for a log; the headline stays a sentence.
    expect(new PseudoTerminalFailure({ kind: "notRunning" }).summary).toBe(
      "This terminal isn't running.",
    );
  });
});

describe("back-pressure", () => {
  test("an empty drain is an empty view, allocated once", () => {
    const terminal = shell("exec sleep 300");
    // Not `undefined`, and not a fresh object 120 times a second per terminal.
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
    // This is the test that kills a conditional wake. Notify only when a drain
    // crossed a mark, and a parked reader is never woken once the drain buffer
    // is smaller than the distance between the marks: one terminal goes silent
    // for good, with nothing logged and no CPU burned.
    const terminal = spawn("/usr/bin/yes", ["yes"]);
    await drainUntil(terminal, /y/);

    // Setup rather than a wait-for-an-assertion, and the one real delay in
    // this file: stop draining so the ring reaches its ceiling and the
    // back-pressure gate latches. Neither assertion below depends on how full
    // it actually got — only on bytes continuing to arrive afterwards.
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
        // Twice the ring's ceiling cannot come out of a ring that stopped
        // being filled, so this is the resume, not the backlog.
        return largest === DRAIN_BUFFER_SIZE && total > RING_CEILING * 2;
      },
      () =>
        `the reader stalled: ${total} bytes drained, largest ${largest} of ${DRAIN_BUFFER_SIZE}`,
      30_000,
    );

    expect(largest).toBe(DRAIN_BUFFER_SIZE);
    expect(total).toBeGreaterThan(RING_CEILING * 2);
  }, 45_000);

  test("a flooding terminal does not stall its neighbour", async () => {
    const flood = spawn("/usr/bin/yes", ["yes"]);
    const neighbour = shell('stty raw -echo; printf "JANELA_NEIGHBOUR_READY\\n"; exec cat');
    await drainUntil(neighbour, /JANELA_NEIGHBOUR_READY/);

    const keepFlooding = setInterval(() => flood.drain(), POLL_MS);
    try {
      neighbour.write(new TextEncoder().encode("JANELA_STILL_RESPONSIVE\n"));
      await drainUntil(neighbour, /JANELA_STILL_RESPONSIVE/);
    } finally {
      clearInterval(keepFlooding);
    }
  }, 30_000);
});
