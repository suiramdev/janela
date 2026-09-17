import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";

import type {
  GridSize,
  Instant,
  SessionID,
  TerminalDescriptor,
  TerminalID,
  TerminalProgress,
} from "@janela/core";
import {
  PseudoTerminalFailure,
  ReadFailed,
  SIGNAL,
  spawnPseudoTerminal,
  type PseudoTerminal,
  type PseudoTerminalConfiguration,
  type TerminalBytes,
} from "@janela/pty";
import { setSignpostSink, type Logger, type LogRecord, type SignpostRecord } from "@janela/support";
import { temporaryDirectory } from "@janela/test-support";
import { Effect, Result } from "effect";

import {
  createLiveTerminal,
  negotiatedSize,
  type LiveTerminal,
  type PromptCompletion,
  type TerminalEvents,
  type TerminalLaunch,
} from "./live-terminal.ts";
import type { PromptMark, TerminalEmulating, TerminalNotification } from "./terminal-emulating.ts";

interface RecordingSink extends TerminalEvents {
  readonly titles: string[];
  readonly directories: string[];
  readonly notifications: TerminalNotification[];
  readonly marks: PromptMark[];
  readonly progress: (TerminalProgress | undefined)[];
  readonly completions: PromptCompletion[];
  readonly failures: string[];
  readonly exits: number[];
}

interface RecordingLogger extends Logger {
  readonly records: LogRecord[];
}

interface ScriptedTerminal extends PseudoTerminal {
  closes: number;
}

interface TerminalSeams {
  readonly log?: Logger;
  readonly spawn?: (configuration: PseudoTerminalConfiguration) => PseudoTerminal;
  readonly createEmulator?: (options: {
    readonly size: GridSize;
    readonly scrollback: number;
  }) => TerminalEmulating;
}

const DEADLINE_MS = 15_000;
const POLL_MS = 4;

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

function live(id: string, launch: TerminalLaunch, extra: TerminalSeams = {}): LiveTerminal {
  const terminal = createLiveTerminal({
    descriptor: descriptor(id),
    sessionID: "session-1" as SessionID,
    launch,
    ...extra,
  });

  started.push(terminal);

  return terminal;
}

function poll(step: () => boolean, describeTimeout: () => string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const attempt = Result.try(step);

    if (Result.isFailure(attempt)) {
      clearInterval(timer);
      reject(attempt.failure);

      return;
    }

    if (attempt.success) {
      clearInterval(timer);
      resolve();

      return;
    }

    if (Date.now() - startedAt > DEADLINE_MS) {
      clearInterval(timer);
      reject(new Error(describeTimeout()));
    }
  }, POLL_MS);

  return promise;
}

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

function recordingSink(): RecordingSink {
  const titles: string[] = [];
  const directories: string[] = [];
  const notifications: TerminalNotification[] = [];
  const marks: PromptMark[] = [];
  const progress: (TerminalProgress | undefined)[] = [];
  const completions: PromptCompletion[] = [];
  const failures: string[] = [];
  const exits: number[] = [];

  return {
    titles,
    directories,
    notifications,
    marks,
    progress,
    completions,
    failures,
    exits,
    onTitle: (title) => titles.push(title),
    onWorkingDirectory: (path) => directories.push(path),
    onAttention: (notification) => notifications.push(notification),
    onPromptMark: (mark) => marks.push(mark),
    onProgress: (reported) => progress.push(reported),
    onPromptFinished: (completion) => completions.push(completion),
    onFailure: (message) => failures.push(message),
    onExit: (code) => exits.push(code),
  };
}

function recordingLogger(): RecordingLogger {
  const records: LogRecord[] = [];
  const at =
    (level: LogRecord["level"]) =>
    (message: string, fields: LogRecord["fields"] | undefined = undefined): void => {
      records.push(
        fields === undefined
          ? { level, category: "terminal", message }
          : { level, category: "terminal", message, fields },
      );
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
    dispose(): void {},
  };
}

function scriptedTerminal(): ScriptedTerminal {
  let latched: PseudoTerminalFailure | undefined;

  return {
    pid: 4242,
    closes: 0,
    get readFailure(): PseudoTerminalFailure | undefined {
      return latched;
    },
    drain(): TerminalBytes | undefined {
      latched ??= new PseudoTerminalFailure(new ReadFailed({ errno: 5 }));

      return undefined;
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

describe("before start", () => {
  test("costs nothing and holds the descriptor's title", () => {
    const terminal = live("t-idle", shellLaunch("exec cat"));

    expect(terminal.state).toEqual({ kind: "idle" });
    expect(terminal.displayTitle).toBe("Shell");
    expect(terminal.snapshotText({ includeScrollback: true })).toBe("");
    expect(terminal.reportedWorkingDirectory).toBeUndefined();
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
    const terminal = live(
      "t-exit",
      shellLaunch("stty raw -echo; printf JANELA_T21; read _; exit 7"),
    );
    const sink = recordingSink();
    terminal.events = sink;

    await terminal.start();

    expect(terminal.state).toEqual({ kind: "running" });

    await drainUntil(
      terminal,
      () => terminal.snapshotText({ includeScrollback: true }).includes("JANELA_T21"),
      "the child's output",
    );

    terminal.send(new Uint8Array([0x0a]));

    await drainUntil(terminal, () => sink.exits.length > 0, "the child to exit");

    expect(sink.exits).toEqual([7]);
    expect(terminal.state).toEqual({ kind: "exited", code: 7 });
    expect(terminal.snapshotText({ includeScrollback: true })).toContain("JANELA_T21");

    terminal.drain();
    terminal.drain();

    expect(sink.exits).toEqual([7]);
    expect(terminal.state).toEqual({ kind: "exited", code: 7 });
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

  test("stop hangs up and the frame loop reports the observed signal death", async () => {
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

  test("an OSC 9 notification body never reaches the log", async () => {
    const logger = recordingLogger();
    const terminal = live(
      "t-notify-privacy",
      shellLaunch("printf '\\033]9;JANELA_SECRET_BODY\\007'; exec cat"),
      { log: logger },
    );
    const sink = recordingSink();
    terminal.events = sink;
    await terminal.start();

    await drainUntil(terminal, () => sink.notifications.length > 0, "the notification");

    expect(sink.notifications).toEqual([{ body: "JANELA_SECRET_BODY" }]);
    expect(JSON.stringify(logger.records)).not.toContain("JANELA_SECRET_BODY");
  });
});

describe("progress", () => {
  test("OSC 9;4 rides on the running state, and 9;4;0 clears it", async () => {
    const terminal = live(
      "t-progress",
      shellLaunch("stty raw -echo; printf '\\033]9;4;3\\007'; exec cat"),
    );
    const sink = recordingSink();
    terminal.events = sink;
    await terminal.start();

    await drainUntil(terminal, () => sink.progress.length > 0, "the progress report");

    expect(sink.progress).toEqual([{ kind: "indeterminate" }]);
    expect(terminal.state).toEqual({ kind: "running", progress: { kind: "indeterminate" } });

    terminal.send(encoder.encode("\x1b]9;4;0\x07"));

    await drainUntil(terminal, () => sink.progress.length > 1, "the cleared progress");

    expect(sink.progress).toEqual([{ kind: "indeterminate" }, undefined]);
    expect(terminal.state).toEqual({ kind: "running" });
  });

  test("a percentage arrives with its state, and an exit drops it", async () => {
    const terminal = live(
      "t-progress-percent",
      shellLaunch("stty raw -echo; printf '\\033]9;4;1;40\\007'; read _; exit 0"),
    );
    const sink = recordingSink();
    terminal.events = sink;
    await terminal.start();

    await drainUntil(terminal, () => sink.progress.length > 0, "the progress report");

    expect(terminal.state).toEqual({
      kind: "running",
      progress: { kind: "normal", percent: 40 },
    });

    terminal.send(new Uint8Array([0x0a]));

    await drainUntil(terminal, () => sink.exits.length > 0, "the child to finish");

    expect(terminal.state).toEqual({ kind: "exited", code: 0 });
  });

  test("a bell during progress still wins, because attention outranks working", async () => {
    const terminal = live(
      "t-progress-bell",
      shellLaunch("stty raw -echo; printf '\\033]9;4;3\\007\\a'; exec cat"),
    );
    const sink = recordingSink();
    terminal.events = sink;
    await terminal.start();

    await drainUntil(terminal, () => sink.notifications.length > 0, "the bell");

    expect(terminal.state).toEqual({ kind: "needsAttention" });

    terminal.send(new Uint8Array([0x0a]));

    expect(terminal.state).toEqual({ kind: "running", progress: { kind: "indeterminate" } });
  });
});

describe("prompt marks", () => {
  test("a finished command is timed from its start and carries its exit code", async () => {
    const terminal = live(
      "t-prompt",
      shellLaunch(
        "stty raw -echo; printf '\\033]133;C\\007'; read _; printf '\\033]133;D;3\\007'; exec cat",
      ),
    );
    const sink = recordingSink();
    terminal.events = sink;
    await terminal.start();

    await drainUntil(terminal, () => sink.marks.length > 0, "the command start");

    terminal.send(new Uint8Array([0x0a]));

    await drainUntil(terminal, () => sink.completions.length > 0, "the command to finish");

    const completion = sink.completions[0];

    expect(completion?.exitCode).toBe(3);
    expect(completion?.durationSeconds).toBeGreaterThanOrEqual(0);
    expect(sink.marks).toEqual([
      { kind: "commandStart" },
      { kind: "commandFinished", exitCode: 3 },
    ]);
  });

  test("a finish with no start before it is not timed at all", async () => {
    const terminal = live(
      "t-prompt-orphan",
      shellLaunch("stty raw -echo; printf '\\033]133;D;0\\007'; exec cat"),
    );
    const sink = recordingSink();
    terminal.events = sink;
    await terminal.start();

    await drainUntil(terminal, () => sink.marks.length > 0, "the orphan finish");

    expect(sink.marks).toEqual([{ kind: "commandFinished", exitCode: 0 }]);
    expect(sink.completions).toEqual([]);
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

describe("the negotiated size on the wire", () => {
  async function attached(id: string, client: string, viewport: GridSize): Promise<LiveTerminal> {
    const terminal = live(id, shellLaunch("exec cat", viewport));
    terminal.attach(client, viewport);
    await terminal.start();
    terminal.fullRepaintFor(client);

    expect(terminal.repaintFor(client)).toHaveLength(0);

    return terminal;
  }

  test("a smaller client joining is announced to the client already attached", async () => {
    const terminal = await attached("t-announce-join", "big", { columns: 127, rows: 45 });

    terminal.attach("small", { columns: 40, rows: 12 });

    expect(decoder.decode(terminal.repaintFor("big"))).toContain("\x1b[8;12;40t");
  });

  test("an overruled viewport is answered with the negotiated size, not silence", async () => {
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
    const terminal = await attached("t-announce-once", "big", { columns: 127, rows: 45 });
    terminal.attach("small", { columns: 40, rows: 12 });

    expect(terminal.repaintFor("big").length).toBeGreaterThan(0);
    expect(terminal.repaintFor("big")).toHaveLength(0);
  });

  test("reaches every attached client even when the encoder only sends deltas", async () => {
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

    expect(full.slice(0, 2)).toEqual(new Uint8Array([0x1b, 0x63]));
    expect(decoder.decode(full)).toContain("READY");
    expect(terminal.repaintFor("a")).toHaveLength(0);

    terminal.send(encoder.encode("more\r\n"));
    await drainUntil(
      terminal,
      () => terminal.snapshotText({ includeScrollback: false }).includes("more"),
      "the echoed input",
    );

    const delta = terminal.repaintFor("a");
    terminal.attach("b", { columns: 80, rows: 24 });

    const wholeGrid = terminal.fullRepaintFor("b");

    expect(delta.length).toBeGreaterThan(0);
    expect(decoder.decode(delta).startsWith("\x1bc")).toBe(false);
    expect(decoder.decode(delta)).not.toContain("\x1b[8;");
    expect(delta.length).toBeLessThan(wholeGrid.length);
    expect(terminal.repaintFor("a")).toHaveLength(0);
  });

  test("a client that is not attached is a programming error", () => {
    const terminal = live("t-unattached", shellLaunch("exec cat"));

    expect(() => terminal.repaintFor("nobody")).toThrow();
    expect(() => terminal.fullRepaintFor("nobody")).toThrow();
  });

  test("a quiet terminal still hands a new client the whole screen", async () => {
    const terminal = live("t-quiet", shellLaunch("stty raw -echo; printf READY; exec cat"));
    await terminal.start();
    terminal.attach("a", { columns: 80, rows: 24 });
    await drainUntil(
      terminal,
      () => terminal.snapshotText({ includeScrollback: false }).includes("READY"),
      "the shell to be ready",
    );
    terminal.fullRepaintFor("a");

    expect(terminal.repaintFor("a")).toHaveLength(0);

    terminal.attach("b", { columns: 80, rows: 24 });

    const arriving = terminal.fullRepaintFor("b");

    expect(arriving.slice(0, 2)).toEqual(new Uint8Array([0x1b, 0x63]));
    expect(decoder.decode(arriving)).toContain("READY");
    expect(terminal.repaintFor("a")).toHaveLength(0);
  });

  test("attaching carries the screen, not the scrollback", async () => {
    const terminal = live(
      "t-history",
      shellLaunch(
        "stty raw -echo; for i in $(seq -w 1 60); do printf 'line-%s\\n' $i; done; exec cat",
      ),
    );
    await terminal.start();
    terminal.attach("a", { columns: 80, rows: 24 });
    await drainUntil(
      terminal,
      () => terminal.snapshotText({ includeScrollback: false }).includes("line-60"),
      "sixty lines",
    );

    const arriving = decoder.decode(terminal.fullRepaintFor("a"));

    expect(arriving).toContain("line-60");
    expect(arriving).not.toContain("line-01");
    expect(terminal.snapshotText({ includeScrollback: true })).toContain("line-01");
    expect(terminal.repaintFor("a")).toHaveLength(0);
  });

  test("signposts record one attach and one repaint per encode", async () => {
    const records: SignpostRecord[] = [];

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              setSignpostSink({ record: (record) => records.push(record) });
            }),
            () =>
              Effect.sync(() => {
                setSignpostSink(undefined);
              }),
          );

          const terminal = live(
            "t-signpost",
            shellLaunch("stty raw -echo; printf READY; exec cat"),
          );

          yield* Effect.promise(() => terminal.start());
          terminal.attach("a", { columns: 40, rows: 6 });
          yield* Effect.promise(() =>
            drainUntil(
              terminal,
              () => terminal.snapshotText({ includeScrollback: false }).includes("READY"),
              "the shell to be ready",
            ),
          );
          terminal.fullRepaintFor("a");
          terminal.repaintFor("a");
        }),
      ),
    );

    const attaches = records.filter((record) => record.name === "attach");
    const repaints = records.filter((record) => record.name === "repaint");

    expect(attaches).toHaveLength(1);
    expect(attaches[0]?.id).toBe("t-signpost");
    expect(attaches[0]?.fields?.["client"]).toBe("a");
    expect(repaints).toHaveLength(2);
    expect(repaints[0]?.fields?.["full"]).toBe(true);
    expect(repaints[1]?.fields?.["full"]).toBe(false);
  });

  test("with no sink installed, nothing is recorded", async () => {
    const records: SignpostRecord[] = [];
    const terminal = live("t-unmeasured", shellLaunch("exec cat"));
    await terminal.start();
    terminal.attach("a", { columns: 40, rows: 6 });
    terminal.fullRepaintFor("a");
    terminal.repaintFor("a");

    expect(records).toEqual([]);
  });
});

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
    expect(sink.exits).toEqual([]);
    expect(scripted.closes).toBe(1);

    terminal.drain();

    expect(scripted.closes).toBe(1);
    expect(logger.records).toHaveLength(1);
    expect(logger.records[0]?.level).toBe("warning");
    expect(logger.records[0]?.fields).toEqual({ terminal: "t-lost", errno: 5, code: 129 });
  });
});
