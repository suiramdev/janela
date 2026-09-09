/**
 * `LiveTerminal` against real pseudo-terminals and real children.
 *
 * Same rule as `@janela/pty`'s own suite: PTYs are not faked, because job
 * control, `SIGWINCH` and a child's idea of its own window size are exactly what a
 * fake would paper over. Everything below spawns something.
 *
 * **On timers.** `poll` below runs on a real clock and there is no version of this
 * file that does not: the thing under test is a child process writing into a
 * kernel PTY buffer, and `drain()` — the method under test — is what the daemon's
 * frame loop calls once per frame. What is avoided is the half that actually
 * flakes: nothing sleeps for a guessed duration and then asserts. Every wait is
 * "drain until this appears, or fail at a deadline", and the two negative claims
 * ("no second child", "no second close") are made against injected seams instead,
 * where they are decidable rather than merely unobserved.
 *
 * The one scripted `PseudoTerminal` here is for a read *failure*, which a real
 * terminal cannot produce on Darwin at all — a child exiting and `revoke(2)` on
 * the replica both make `read` return 0, which is EOF. `@janela/pty` proves the
 * native half against a descriptor `read` rejects; this file proves what a live
 * terminal does when it is handed one.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";

import type { GridSize, Instant, SessionID, TerminalDescriptor, TerminalID } from "@janela/core";
import {
  PseudoTerminalFailure,
  SIGNAL,
  spawnPseudoTerminal,
  type PseudoTerminal,
  type PseudoTerminalConfiguration,
  type TerminalBytes,
} from "@janela/pty";
import type { Logger, LogRecord } from "@janela/support";
import { temporaryDirectory } from "@janela/test-support";

import {
  createLiveTerminal,
  negotiatedSize,
  type LiveTerminal,
  type TerminalLaunch,
} from "./live-terminal.ts";
import type {
  PromptMark,
  TerminalEmulating,
  TerminalEventSink,
  TerminalNotification,
} from "./terminal-emulating.ts";

/** Generous on purpose: the failure it guards is a hang, not a slow pass. */
const DEADLINE_MS = 15_000;
/** Roughly one frame, which is how often the daemon itself drains. */
const POLL_MS = 4;

/** Nothing here depends on the developer's profile. */
const ENVIRONMENT = { TERM: "xterm-256color", PATH: "/usr/bin:/bin" };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const started: LiveTerminal[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0, started.length).map((terminal) => terminal.stop()));
});

function descriptor(id: string): TerminalDescriptor {
  return {
    id: id as TerminalID,
    title: "Shell",
    startsAutomatically: false,
    role: { kind: "user" },
    createdAt: "2025-01-01T00:00:00.000Z" as Instant,
  };
}

function shellLaunch(
  script: string,
  initialSize: GridSize = { columns: 80, rows: 24 },
): TerminalLaunch {
  return {
    executable: "/bin/sh",
    arguments: ["sh", "-c", script],
    workingDirectory: tmpdir(),
    environment: ENVIRONMENT,
    initialSize,
  };
}

function live(
  id: string,
  launch: TerminalLaunch,
  extra: {
    readonly log?: Logger;
    readonly spawn?: (configuration: PseudoTerminalConfiguration) => PseudoTerminal;
    readonly createEmulator?: (options: {
      readonly size: GridSize;
      readonly scrollback: number;
    }) => TerminalEmulating;
  } = {},
): LiveTerminal {
  const terminal = createLiveTerminal({
    descriptor: descriptor(id),
    sessionID: "session-1" as SessionID,
    launch,
    ...extra,
  });
  started.push(terminal);
  return terminal;
}

/** Runs `step` once per frame until it reports done, or fails at a deadline. */
function poll(step: () => boolean, describeTimeout: () => string): Promise<void> {
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
    if (Date.now() - startedAt > DEADLINE_MS) {
      clearInterval(timer);
      reject(new Error(describeTimeout()));
    }
  }, POLL_MS);
  return promise;
}

/** Drives the frame loop until `done` is satisfied. */
function drainUntil(terminal: LiveTerminal, done: () => boolean, what: string): Promise<void> {
  return poll(
    () => {
      terminal.drain();
      return done();
    },
    () =>
      `timed out waiting for ${what}; screen was ${JSON.stringify(
        terminal.snapshotText({ includeScrollback: true }),
      )}`,
  );
}

function recordingSink(): TerminalEventSink & {
  readonly titles: string[];
  readonly directories: string[];
  readonly notifications: TerminalNotification[];
  readonly marks: PromptMark[];
  readonly exits: number[];
} {
  const titles: string[] = [];
  const directories: string[] = [];
  const notifications: TerminalNotification[] = [];
  const marks: PromptMark[] = [];
  const exits: number[] = [];
  return {
    titles,
    directories,
    notifications,
    marks,
    exits,
    onTitle: (title) => titles.push(title),
    onWorkingDirectory: (path) => directories.push(path),
    onAttention: (notification) => notifications.push(notification),
    onPromptMark: (mark) => marks.push(mark),
    onExit: (code) => exits.push(code),
  };
}

function recordingLogger(): Logger & { readonly records: LogRecord[] } {
  const records: LogRecord[] = [];
  const at =
    (level: LogRecord["level"]) =>
    (message: string, fields?: LogRecord["fields"]): void => {
      records.push({
        level,
        category: "terminal",
        message,
        ...(fields === undefined ? {} : { fields }),
      });
    };
  return {
    records,
    debug: at("debug"),
    info: at("info"),
    notice: at("notice"),
    warning: at("warning"),
    error: at("error"),
  };
}

describe("before start", () => {
  test("costs nothing and holds the descriptor's title", () => {
    const terminal = live("t-idle", shellLaunch("exec cat"));

    expect(terminal.state).toEqual({ kind: "idle" });
    expect(terminal.displayTitle).toBe("Shell");
    expect(terminal.snapshotText({ includeScrollback: true })).toBe("");
    expect(terminal.reportedWorkingDirectory).toBeUndefined();
    // No PTY to observe directly; this is the observable consequence of not
    // having one.
    expect(() => terminal.send(new Uint8Array([0x0a]))).toThrow(PseudoTerminalFailure);
  });

  test("draining an unstarted terminal does nothing", () => {
    const terminal = live("t-idle-drain", shellLaunch("exec cat"));
    const sink = recordingSink();
    terminal.events = sink;

    terminal.drain();
    terminal.drain();

    expect(terminal.state).toEqual({ kind: "idle" });
    expect(sink.exits).toEqual([]);
  });
});

describe("lifecycle", () => {
  test("a child that finishes reaches exited with its status, once", async () => {
    const terminal = live("t-echo", {
      executable: "/bin/echo",
      arguments: ["echo", "JANELA_T21"],
      workingDirectory: tmpdir(),
      environment: ENVIRONMENT,
      initialSize: { columns: 80, rows: 24 },
    });
    const sink = recordingSink();
    terminal.events = sink;

    await terminal.start();

    expect(terminal.state).toEqual({ kind: "running" });

    await drainUntil(terminal, () => sink.exits.length > 0, "the child to exit");

    expect(sink.exits).toEqual([0]);
    expect(terminal.state).toEqual({ kind: "exited", code: 0 });
    // The last screen stays readable after the process is gone.
    expect(terminal.snapshotText({ includeScrollback: true })).toContain("JANELA_T21");

    terminal.drain();
    terminal.drain();

    expect(sink.exits).toEqual([0]);
    expect(terminal.state).toEqual({ kind: "exited", code: 0 });
  });

  test("start is idempotent: a second call does not spawn a second child", async () => {
    let spawns = 0;
    const terminal = live("t-twice", shellLaunch("exec cat"), {
      spawn: (configuration) => {
        spawns += 1;
        return spawnPseudoTerminal(configuration);
      },
    });

    await terminal.start();
    await terminal.start();

    expect(spawns).toBe(1);
    expect(terminal.state).toEqual({ kind: "running" });
  });

  test("stop hangs up and the frame loop reports the signal death", async () => {
    const terminal = live("t-stop", shellLaunch("stty raw -echo; printf READY; exec cat"));
    const sink = recordingSink();
    terminal.events = sink;
    await terminal.start();
    await drainUntil(
      terminal,
      () => terminal.snapshotText({ includeScrollback: false }).includes("READY"),
      "the shell to be ready",
    );

    await terminal.stop();
    await drainUntil(terminal, () => terminal.state.kind === "exited", "the child to be reaped");

    // A shell reports a signal death as 128 + signo, and so do we — the code is
    // observed, never fabricated.
    expect(terminal.state).toEqual({ kind: "exited", code: 128 + SIGNAL.SIGHUP });
    expect(sink.exits).toEqual([128 + SIGNAL.SIGHUP]);
  });

  test("restart keeps the terminal's identity and starts a different process", async () => {
    const terminal = live("t-restart", shellLaunch("echo JANELA_PID_$$; exec cat"));
    await terminal.start();
    await drainUntil(
      terminal,
      () => /JANELA_PID_\d+/.test(terminal.snapshotText({ includeScrollback: true })),
      "the first pid",
    );
    const first = terminal.snapshotText({ includeScrollback: true }).match(/JANELA_PID_(\d+)/)?.[1];

    await terminal.restart();
    await drainUntil(
      terminal,
      () => {
        const seen = terminal
          .snapshotText({ includeScrollback: true })
          .match(/JANELA_PID_(\d+)/)?.[1];
        return seen !== undefined && seen !== first;
      },
      "a different pid",
    );

    expect(terminal.id).toBe("t-restart" as TerminalID);
    expect(terminal.state).toEqual({ kind: "running" });
    // A fresh emulator: the previous run's screen is gone, not appended to.
    expect(terminal.snapshotText({ includeScrollback: true })).not.toContain(`JANELA_PID_${first}`);
  });

  test("a spawn that fails is shown, and may be retried", async () => {
    await using directory = await temporaryDirectory("live-terminal");
    const missing = directory.join("missing");
    const terminal = live("t-missing", {
      executable: missing,
      arguments: ["missing"],
      workingDirectory: directory.path,
      environment: ENVIRONMENT,
      initialSize: { columns: 80, rows: 24 },
    });

    await expect(terminal.start()).rejects.toBeInstanceOf(PseudoTerminalFailure);

    expect(terminal.state).toEqual({ kind: "failed", message: `Couldn't start ${missing}.` });

    await expect(terminal.start()).rejects.toBeInstanceOf(PseudoTerminalFailure);
  });
});

describe("attention", () => {
  test("BEL raises it and user input clears it", async () => {
    const terminal = live("t-bell", shellLaunch("stty raw -echo; printf '\\a'; exec cat"));
    const sink = recordingSink();
    terminal.events = sink;
    await terminal.start();

    await drainUntil(terminal, () => sink.notifications.length > 0, "the bell");

    expect(terminal.state).toEqual({ kind: "needsAttention" });

    terminal.send(new Uint8Array([0x0a]));

    expect(terminal.state).toEqual({ kind: "running" });
  });

  test("OSC 0 and OSC 7 reach the title and the reported directory", async () => {
    const terminal = live(
      "t-osc",
      shellLaunch("printf '\\033]0;Hello\\007\\033]7;file://localhost/tmp/dir\\007'; exec cat"),
    );
    const sink = recordingSink();
    terminal.events = sink;
    await terminal.start();

    await drainUntil(terminal, () => sink.directories.length > 0, "the working directory");

    expect(terminal.displayTitle).toBe("Hello");
    expect(terminal.reportedWorkingDirectory).toBe("/tmp/dir");
    expect(sink.titles).toEqual(["Hello"]);
  });
});

describe("size negotiation", () => {
  test("is the minimum of every attached viewport", () => {
    expect(
      negotiatedSize([
        { columns: 120, rows: 10 },
        { columns: 80, rows: 40 },
      ]),
    ).toEqual({ columns: 80, rows: 10 });
    expect(negotiatedSize([{ columns: 100, rows: 40 }])).toEqual({ columns: 100, rows: 40 });
  });

  test("refuses to invent a size for nobody", () => {
    // "Nobody is attached" is `detach()` returning undefined, not a made-up 80×24.
    expect(() => negotiatedSize([])).toThrow();
  });

  test("attach and detach renegotiate", () => {
    const terminal = live("t-negotiate", shellLaunch("exec cat"));

    expect(terminal.attach("a", { columns: 100, rows: 40 })).toEqual({ columns: 100, rows: 40 });
    expect(terminal.attach("b", { columns: 80, rows: 24 })).toEqual({ columns: 80, rows: 24 });
    expect(terminal.detach("b")).toEqual({ columns: 100, rows: 40 });
    expect(terminal.detach("a")).toBeUndefined();
  });

  test("a second attach from the same client is how a resize arrives", () => {
    const terminal = live("t-resize-client", shellLaunch("exec cat"));
    terminal.attach("a", { columns: 100, rows: 40 });

    expect(terminal.attach("a", { columns: 60, rows: 20 })).toEqual({ columns: 60, rows: 20 });
  });

  test("the child sees the negotiated size", async () => {
    const terminal = live(
      "t-winch",
      shellLaunch('trap "stty size" WINCH; echo JANELA_WINCH_READY; while :; do sleep 0.1; done', {
        columns: 80,
        rows: 24,
      }),
    );
    await terminal.start();
    await drainUntil(
      terminal,
      () => terminal.snapshotText({ includeScrollback: true }).includes("JANELA_WINCH_READY"),
      "the shell to install its trap",
    );

    expect(terminal.attach("a", { columns: 100, rows: 40 })).toEqual({ columns: 100, rows: 40 });

    await drainUntil(
      terminal,
      () => terminal.snapshotText({ includeScrollback: true }).includes("40 100"),
      "the child to report its new window size",
    );
  });

  test("the emulator grid follows too", async () => {
    const terminal = live(
      "t-grid",
      shellLaunch("stty raw -echo; printf 'READY\\r\\n'; exec cat", { columns: 80, rows: 24 }),
    );
    await terminal.start();
    terminal.attach("a", { columns: 100, rows: 40 });
    // Input sent before `stty raw` lands goes through the default line
    // discipline and comes back echoed and translated, which is a different test.
    await drainUntil(
      terminal,
      () => terminal.snapshotText({ includeScrollback: false }).includes("READY"),
      "the shell to put the terminal in raw mode",
    );

    for (let line = 1; line <= 30; line += 1) {
      terminal.send(encoder.encode(`L${line}\r\n`));
    }
    await drainUntil(
      terminal,
      () => terminal.snapshotText({ includeScrollback: false }).includes("L30"),
      "the last line",
    );

    // 31 rows of output fit on screen at 40 rows, and would have scrolled off at 24.
    expect(terminal.snapshotText({ includeScrollback: false })).toContain("READY\nL1\n");
  });

  test("a client attached before start decides the initial size", async () => {
    const terminal = live("t-early", shellLaunch("stty size; exec cat", { columns: 80, rows: 24 }));
    terminal.attach("a", { columns: 50, rows: 12 });

    await terminal.start();
    await drainUntil(
      terminal,
      () => /\d+ \d+/.test(terminal.snapshotText({ includeScrollback: true })),
      "the child to report its window size",
    );

    expect(terminal.snapshotText({ includeScrollback: true })).toContain("12 50");
  });
});

/**
 * The half of the negotiation that reaches a client (protocol 5).
 *
 * The size is not on any control message: it rides the repaint as
 * `CSI 8 ; rows ; cols t`, because it describes the very bytes it travels with.
 * These assert the exact sequence each client receives, against a real PTY and a
 * real emulator — without them, `letterboxMargins` in `@janela/terminal-ui` is
 * only ever handed the client's own grid and can absorb rounding and nothing
 * else, which is `docs/survival-proof.md` § D2.
 */
describe("the negotiated size on the wire", () => {
  /** A started terminal with `client` attached and already told its size. */
  async function attached(id: string, client: string, viewport: GridSize): Promise<LiveTerminal> {
    const terminal = live(id, shellLaunch("exec cat", viewport));
    terminal.attach(client, viewport);
    await terminal.start();
    // Discharges the debt every fresh attachment carries, so what the tests
    // observe afterwards is caused by the second client and nothing else.
    terminal.fullRepaintFor(client);
    expect(terminal.repaintFor(client)).toHaveLength(0);
    return terminal;
  }

  test("a smaller client joining is announced to the client already attached", async () => {
    const terminal = await attached("t-announce-join", "big", { columns: 127, rows: 45 });

    terminal.attach("small", { columns: 40, rows: 12 });

    // The larger client is the one that has to letterbox, and this is the only
    // thing that tells it to.
    expect(decoder.decode(terminal.repaintFor("big"))).toContain("\x1b[8;12;40t");
  });

  test("an overruled viewport is answered with the negotiated size, not silence", async () => {
    // The window-resized-while-a-smaller-client-holds case. The negotiation does
    // not move — the minimum is still the other client's — so an announcement
    // keyed on "the size changed" would say nothing, and this client would render
    // at its own width against a grid a third of it, with nothing to correct it.
    const terminal = await attached("t-announce-overruled", "big", { columns: 127, rows: 45 });
    terminal.attach("small", { columns: 40, rows: 12 });
    expect(terminal.repaintFor("big").length).toBeGreaterThan(0);

    expect(terminal.attach("big", { columns: 120, rows: 44 })).toEqual({ columns: 40, rows: 12 });

    expect(decoder.decode(terminal.repaintFor("big"))).toContain("\x1b[8;12;40t");
  });

  test("growing back when the smaller client detaches is announced too", async () => {
    const terminal = await attached("t-announce-grow", "big", { columns: 127, rows: 45 });
    terminal.attach("small", { columns: 40, rows: 12 });
    expect(terminal.repaintFor("big").length).toBeGreaterThan(0);

    expect(terminal.detach("small")).toEqual({ columns: 127, rows: 45 });

    expect(decoder.decode(terminal.repaintFor("big"))).toContain("\x1b[8;45;127t");
  });

  test("a client told its size is owed nothing on the next frame", async () => {
    // The announcement is a debt, not a per-frame prefix: 120 Hz of `CSI 8 t`
    // would be a resize storm on a client that already agrees.
    const terminal = await attached("t-announce-once", "big", { columns: 127, rows: 45 });
    terminal.attach("small", { columns: 40, rows: 12 });

    expect(terminal.repaintFor("big").length).toBeGreaterThan(0);
    expect(terminal.repaintFor("big")).toHaveLength(0);
  });

  test("reaches every attached client even when the encoder only sends deltas", async () => {
    // The constraint #32's damage encoder has to keep passing, and the reason
    // `owesSize` exists rather than the resize being left to bump a revision:
    // today's `repaintSince` answers any mismatch with the whole grid, so this
    // would pass by accident with nothing tracking who has been told. This
    // emulator sends nothing at all unless it was fed, which is what a real
    // damage encoder does for a quiet screen.
    const terminal = live("t-announce-delta", shellLaunch("exec cat"), {
      createEmulator: (options) => deltaOnlyEmulator(options.size),
    });
    terminal.attach("big", { columns: 127, rows: 45 });
    await terminal.start();
    terminal.fullRepaintFor("big");
    expect(terminal.repaintFor("big")).toHaveLength(0);

    terminal.attach("small", { columns: 40, rows: 12 });

    expect(decoder.decode(terminal.repaintFor("big"))).toContain("\x1b[8;12;40t");
  });
});

describe("repaints", () => {
  test("are per client, and a full repaint always resets the receiver first", async () => {
    const terminal = live("t-repaint", shellLaunch("stty raw -echo; printf READY; exec cat"));
    await terminal.start();
    terminal.attach("a", { columns: 80, rows: 24 });
    await drainUntil(
      terminal,
      () => terminal.snapshotText({ includeScrollback: false }).includes("READY"),
      "the shell to be ready",
    );

    const full = terminal.fullRepaintFor("a");

    // RIS. Without it a repaint is only correct onto a blank renderer.
    expect(full.slice(0, 2)).toEqual(new Uint8Array([0x1b, 0x63]));
    expect(decoder.decode(full)).toContain("READY");
    // A client that has just been given the whole grid is owed nothing.
    expect(terminal.repaintFor("a")).toHaveLength(0);

    terminal.send(encoder.encode("more\r\n"));
    await drainUntil(
      terminal,
      () => terminal.snapshotText({ includeScrollback: false }).includes("more"),
      "the echoed input",
    );

    expect(terminal.repaintFor("a").length).toBeGreaterThan(0);
    expect(terminal.repaintFor("a")).toHaveLength(0);
  });

  test("a client that is not attached is a programming error", () => {
    const terminal = live("t-unattached", shellLaunch("exec cat"));

    expect(() => terminal.repaintFor("nobody")).toThrow();
    expect(() => terminal.fullRepaintFor("nobody")).toThrow();
  });
});

/**
 * An emulator whose repaint really is a delta: nothing at all unless it was fed
 * since the revision the client claims.
 *
 * It obeys the one thing `TerminalEmulating` requires of a full repaint — the
 * grid announces its own size — and does the bare minimum everywhere else, which
 * is what makes "who has been told" observable. The production encoder answers
 * every revision mismatch with a whole grid, so it hides that question until #32
 * replaces it.
 */
function deltaOnlyEmulator(initial: GridSize): TerminalEmulating {
  let size = initial;
  let revision = 0;
  let text = "";
  return {
    feed(bytes: TerminalBytes): void {
      text += decoder.decode(bytes);
      revision += 1;
    },
    get size(): GridSize {
      return size;
    },
    resize(next: GridSize): void {
      size = next;
    },
    get revision(): number {
      return revision;
    },
    repaintSince(seen: number): Uint8Array {
      return seen === revision ? new Uint8Array(0) : encoder.encode(text);
    },
    fullRepaint(): Uint8Array {
      return encoder.encode(`\x1bc\x1b[8;${size.rows};${size.columns}t${text}`);
    },
    snapshotText(): string {
      return text;
    },
    clearScrollback(): void {
      text = "";
    },
    events: undefined,
    dispose(): void {
      // Nothing to release: there is no grid, only the string above.
    },
  };
}

/** Returns `undefined` from `drain()` after failing once, as the native side does. */
function scriptedTerminal(): PseudoTerminal & { closes: number } {
  let failed = false;
  return {
    pid: 4242,
    closes: 0,
    drain(): TerminalBytes | undefined {
      if (failed) {
        return undefined;
      }
      failed = true;
      throw new PseudoTerminalFailure({ kind: "readFailed", errno: 5 });
    },
    write(): void {},
    resize(): void {},
    signal(): void {},
    exitCode(): number | undefined {
      return 129;
    },
    close(): void {
      this.closes += 1;
    },
  };
}

describe("a lost descriptor", () => {
  test("fails the terminal without pretending the child finished", async () => {
    const scripted = scriptedTerminal();
    const logger = recordingLogger();
    const terminal = live("t-lost", shellLaunch("exec cat"), {
      log: logger,
      spawn: () => scripted,
    });
    const sink = recordingSink();
    terminal.events = sink;

    await terminal.start();
    terminal.drain();

    expect(terminal.state).toEqual({
      kind: "failed",
      message: "Couldn't read from this terminal.",
    });
    // Lost is not finished: a client that hears `onExit` would show an exit code
    // for a process whose fate we do not know.
    expect(sink.exits).toEqual([]);
    expect(scripted.closes).toBe(1);

    terminal.drain();

    expect(scripted.closes).toBe(1);
    expect(logger.records).toHaveLength(1);
    expect(logger.records[0]?.level).toBe("warning");
    // Shapes only: an id, an errno, a status. Never a byte of what was on screen.
    expect(logger.records[0]?.fields).toEqual({ terminal: "t-lost", errno: 5, code: 129 });
  });
});
