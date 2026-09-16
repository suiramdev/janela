import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { dirname, join } from "node:path";

import { absolutePath, type Session, type TerminalID, type TerminalState } from "@janela/core";
import {
  decodeDaemonMessage,
  decodeOutput,
  encodeClientMessage,
  encodeFrame,
  encodeInput,
  frameDecoder,
  FrameKind,
  MINIMUM_SUPPORTED_VERSION,
  PROTOCOL_VERSION,
  type ClientMessage,
  type DaemonMessage,
  type Hello,
  type RequestID,
  type StateUpdate,
} from "@janela/protocol";
import { Option, Result, Schema } from "effect";

interface IsolatedHome extends AsyncDisposable {
  readonly path: string;
}

interface DaemonProcess {
  readonly socketPath: string;
  readonly pid: number;
  log(): string;
  children(): readonly number[];
  kill(signal: NodeJS.Signals): void;
  readonly exited: Promise<number | null>;
  stop(): Promise<void>;
}

interface Probe {
  readonly greeting: DaemonMessage;
  send(message: ClientMessage): void;
  ask(request: Request): Promise<DaemonMessage>;
  type(terminalID: TerminalID, text: string): void;
  nextControl(): Promise<DaemonMessage>;
  sessions(): readonly Session[];
  terminalState(terminalID: TerminalID): TerminalState | undefined;
  repaints(): readonly Uint8Array[];
  closed(): boolean;
  close(): void;
}

type Request = Extract<ClientMessage, { readonly id: RequestID }>;

const packageDirectory = dirname(import.meta.dir);

const STEP_TIMEOUT_MS = 90_000;

const REPLY_TIMEOUT_MS = 30_000;

const OBSERVE_INTERVAL_MS = 25;

const DETACHED_INTERVAL_MS = 1_000;

const VIEWPORT = { columns: 80, rows: 24 };

const EMITTER = String.raw`i=0; while :; do i=$((i+1)); printf 'tick-%04d\n' $i; sleep 0.1; done`;

const DEFAULT_HELLO: Hello = {
  protocolVersion: PROTOCOL_VERSION,
  minimumSupported: MINIMUM_SUPPORTED_VERSION,
  clientName: "survival-probe",
};

const CorrelatedReply = Schema.Struct({ id: Schema.Number });

const decodeCorrelation = Schema.decodeUnknownOption(CorrelatedReply);

const started = new Set<DaemonProcess>();

async function isolatedHome(): Promise<IsolatedHome> {
  const path = await mkdtemp("/tmp/jd-");

  return {
    path,
    [Symbol.asyncDispose]: async () => {
      await rm(path, { recursive: true, force: true });
    },
  };
}

async function waitFor<T>(
  what: string,
  observe: () => T | undefined | Promise<T | undefined>,
  context: () => string = () => "",
): Promise<T> {
  const deadline = Date.now() + REPLY_TIMEOUT_MS;

  for (;;) {
    // oxlint-disable-next-line no-await-in-loop
    const seen = await observe();

    if (seen !== undefined) return seen;

    if (Date.now() > deadline) throw new Error(`never became true: ${what}\n${context()}`);

    // oxlint-disable-next-line no-await-in-loop
    await Bun.sleep(OBSERVE_INTERVAL_MS);
  }
}

function accepts(path: string): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = connect(path);

  socket.once("connect", () => {
    socket.destroy();
    resolve(true);
  });
  socket.once("error", () => resolve(false));

  return promise;
}

function reap(pids: readonly number[]): void {
  for (const pid of pids) {
    Result.try(() => process.kill(pid, "SIGKILL"));
  }
}

async function startDaemon(home: string, alone = false): Promise<DaemonProcess> {
  const isolated = join(home, "isolated");

  await mkdir(isolated, { recursive: true });

  let binary = sidecarPath;

  if (alone) {
    binary = join(isolated, "janelad");

    await copyFile(sidecarPath, binary);
  }

  const spawned = Bun.spawn([binary, "--foreground"], {
    cwd: isolated,
    env: { HOME: home, PATH: process.env["PATH"] ?? "", TMPDIR: home },
    stdout: "ignore",
    stderr: "pipe",
  });
  const lines: string[] = [];
  const reader = spawned.stderr.getReader();

  void (async () => {
    const decoder = new TextDecoder();

    for (;;) {
      // oxlint-disable-next-line no-await-in-loop
      const chunk = await reader.read();

      if (chunk.done) return;

      lines.push(decoder.decode(chunk.value));
    }
  })();

  const daemon: DaemonProcess = {
    socketPath: join(home, ".janela", "run", "janelad.sock"),
    pid: spawned.pid,
    log: () => lines.join(""),

    children: () => {
      const found = Bun.spawnSync(["pgrep", "-P", String(spawned.pid)]);

      return new TextDecoder()
        .decode(found.stdout)
        .split("\n")
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
    },

    kill: (signal) => spawned.kill(signal),
    exited: spawned.exited,

    stop: async () => {
      started.delete(daemon);

      const orphans = daemon.children();

      spawned.kill("SIGKILL");

      await spawned.exited;

      reap(orphans);
    },
  };

  started.add(daemon);

  await waitFor(
    `the compiled sidecar accepts on ${daemon.socketPath}`,
    async () => ((await accepts(daemon.socketPath)) ? true : undefined),
    daemon.log,
  );

  return daemon;
}

async function probeClient(daemon: DaemonProcess, hello: Hello = DEFAULT_HELLO): Promise<Probe> {
  const connecting = Promise.withResolvers<Socket>();
  const opening = connect(daemon.socketPath);

  opening.once("connect", () => connecting.resolve(opening));
  opening.once("error", connecting.reject);

  const socket = await connecting.promise;
  const decoder = frameDecoder();
  const controls: DaemonMessage[] = [];
  const repaints: Uint8Array[] = [];
  const wakers: (() => void)[] = [];
  let sessions: readonly Session[] = [];
  let terminalStates: StateUpdate["terminalStates"] = {};
  let closed = false;

  const wake = (): void => {
    for (const waker of wakers.splice(0)) waker();
  };

  const absorb = (update: StateUpdate): void => {
    if (update.isFullSnapshot) {
      sessions = update.sessions;
      terminalStates = { ...update.terminalStates };

      return;
    }

    const merged = new Map(sessions.map((session) => [session.id, session]));

    for (const session of update.sessions) merged.set(session.id, session);

    sessions = [...merged.values()];
    terminalStates = { ...terminalStates, ...update.terminalStates };
  };

  socket.on("data", (chunk: Buffer) => {
    for (const frame of decoder.push(new Uint8Array(chunk))) {
      if (frame.kind === FrameKind.Control) {
        const message = decodeDaemonMessage(frame);

        if (message.type === "state") absorb(message.update);

        controls.push(message);
        continue;
      }

      repaints.push(new Uint8Array(decodeOutput(frame).bytes));
    }

    wake();
  });
  socket.once("close", () => {
    closed = true;
    wake();
  });
  socket.once("error", () => {
    closed = true;
    wake();
  });

  let awaiting = "the daemon's hello";

  const nextControl = async (): Promise<DaemonMessage> => {
    for (;;) {
      const message = controls.shift();

      if (message !== undefined) return message;

      if (closed) {
        throw new Error(`the daemon closed the connection, awaiting ${awaiting}\n${daemon.log()}`);
      }

      const woken = Promise.withResolvers<void>();

      wakers.push(woken.resolve);
      // oxlint-disable-next-line no-await-in-loop
      await Promise.race([
        woken.promise,
        Bun.sleep(REPLY_TIMEOUT_MS).then(() => {
          throw new Error(`no control frame arrived, awaiting ${awaiting}\n${daemon.log()}`);
        }),
      ]);
    }
  };

  const send = (message: ClientMessage): void =>
    void socket.write(encodeFrame(encodeClientMessage(message)));

  send({ type: "hello", hello });

  const greeting = await nextControl();

  return {
    greeting,
    send,

    ask: async (request) => {
      awaiting = `a reply to ${request.type} #${request.id}`;
      send(request);

      for (;;) {
        // oxlint-disable-next-line no-await-in-loop
        const message = await nextControl();
        const correlation = decodeCorrelation(message);

        if (Option.isSome(correlation) && correlation.value.id === request.id) return message;
      }
    },

    type: (terminalID, text) =>
      void socket.write(
        encodeFrame(encodeInput({ terminalID, bytes: new TextEncoder().encode(text) })),
      ),

    nextControl,
    sessions: () => sessions,
    terminalState: (terminalID) => terminalStates[terminalID],
    repaints: () => repaints,
    closed: () => closed,
    close: () => socket.destroy(),
  };
}

function repaintText(probe: Probe): string {
  const decoder = new TextDecoder();

  return probe
    .repaints()
    .map((bytes) => decoder.decode(bytes))
    .join("");
}

function requestID(): RequestID {
  lastRequestID += 1;

  return lastRequestID as RequestID;
}

async function snapshot(
  probe: Probe,
  terminalID: TerminalID,
  includeScrollback: boolean,
): Promise<string> {
  const reply = await probe.ask({
    type: "snapshotText",
    id: requestID(),
    terminalID,
    includeScrollback,
  });

  if (reply.type !== "text") throw new Error(`snapshotText answered ${reply.type}`);

  return reply.text;
}

function waitForText(
  probe: Probe,
  terminalID: TerminalID,
  needle: string,
  includeScrollback = true,
): Promise<string> {
  return waitFor(`${needle} appears in the terminal`, async () => {
    const text = await snapshot(probe, terminalID, includeScrollback);

    return text.includes(needle) ? text : undefined;
  });
}

async function sessionWithShell(
  probe: Probe,
  directory: string,
): Promise<{ session: Session; terminalID: TerminalID }> {
  expect(
    (await probe.ask({ type: "subscribe", id: requestID(), scope: { kind: "state" } })).type,
  ).toBe("acknowledged");
  expect(
    (
      await probe.ask({
        type: "createSession",
        id: requestID(),
        intent: { kind: "standalone", directory: absolutePath(directory) },
      })
    ).type,
  ).toBe("acknowledged");

  const session = await waitFor("the new session is announced with its terminal", () =>
    probe.sessions().find((candidate) => candidate.terminals.length > 0),
  );
  const terminalID = session.terminals[0]?.id;

  if (terminalID === undefined) throw new Error("a session was announced with no terminal");

  expect((await probe.ask({ type: "startTerminal", id: requestID(), terminalID })).type).toBe(
    "acknowledged",
  );

  return { session, terminalID };
}

function highestTick(text: string): number {
  let highest = -1;

  for (const match of text.matchAll(/tick-(\d{4})/g)) {
    const tick = Number.parseInt(match[1] ?? "", 10);

    if (tick > highest) highest = tick;
  }

  return highest;
}

function reportedSizes(text: string): readonly string[] {
  return [...text.matchAll(/^(\d+ \d+)$/gm)].map((match) => match[1] ?? "");
}

let lastRequestID = 0;

let sidecarPath = "";

beforeAll(async () => {
  const build = Bun.spawn(["bun", "run", "build"], {
    cwd: packageDirectory,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, failure] = await Promise.all([build.exited, new Response(build.stderr).text()]);

  if (status !== 0) throw new Error(`compiling the sidecar failed: ${failure}`);

  sidecarPath = join(packageDirectory, "janelad");
});

afterAll(async () => {
  await Promise.all([...started].map((daemon) => daemon.stop()));
});

describe("the compiled sidecar, as a daemon that outlives its clients", () => {
  test(
    "spawns a real PTY from a directory containing nothing but itself",
    async () => {
      await using fixture = await isolatedHome();
      const daemon = await startDaemon(fixture.path, true);
      const probe = await probeClient(daemon);

      expect(probe.greeting.type).toBe("hello");

      const work = join(fixture.path, "work");

      await mkdir(work, { recursive: true });

      const { terminalID } = await sessionWithShell(probe, work);
      const children = await waitFor(
        "the daemon has a child process",
        () => {
          const found = daemon.children();

          return found.length > 0 ? found : undefined;
        },
        daemon.log,
      );

      expect(children.length).toBeGreaterThan(0);

      probe.send({ type: "attach", id: requestID(), terminalID, viewport: VIEWPORT });
      probe.type(terminalID, "printf 'PTY-ALIVE-%s\\n' \"$$\"\n");

      const text = await waitForText(probe, terminalID, "PTY-ALIVE-");

      expect(/PTY-ALIVE-\d+/.test(text)).toBe(true);
      expect(await readdir(join(fixture.path, "isolated"))).toEqual(["janelad"]);
      expect(
        await Bun.file(
          join(fixture.path, "Library", "Application Support", "sh.janela.Janela", "janela.sqlite"),
        ).exists(),
      ).toBe(true);

      probe.close();
      await daemon.stop();
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "keeps a terminal running, and keeps draining it, with every client gone",
    async () => {
      await using fixture = await isolatedHome();
      const daemon = await startDaemon(fixture.path);
      const first = await probeClient(daemon);
      const work = join(fixture.path, "work");

      await mkdir(work, { recursive: true });

      const { terminalID } = await sessionWithShell(first, work);

      first.send({ type: "attach", id: requestID(), terminalID, viewport: VIEWPORT });
      first.type(terminalID, `${EMITTER}\n`);

      const before = highestTick(await waitForText(first, terminalID, "tick-0002"));
      const childrenBefore = daemon.children();

      expect(childrenBefore.length).toBeGreaterThan(0);

      first.close();
      await waitFor(
        "the daemon records the client leaving",
        () => (daemon.log().includes("client disconnected") ? true : undefined),
        daemon.log,
      );
      await Bun.sleep(DETACHED_INTERVAL_MS);

      const second = await probeClient(daemon);

      expect(second.greeting.type).toBe("hello");
      expect(
        (await second.ask({ type: "subscribe", id: requestID(), scope: { kind: "state" } })).type,
      ).toBe("acknowledged");

      const after = highestTick(await snapshot(second, terminalID, true));

      expect(after).toBeGreaterThan(before + 1);
      expect(daemon.children()).toEqual(childrenBefore);
      expect(second.terminalState(terminalID)?.kind).toBe("running");

      second.close();
      await daemon.stop();
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "sends a reattaching client the current screen of a quiet terminal, not a blank one",
    async () => {
      await using fixture = await isolatedHome();
      const daemon = await startDaemon(fixture.path);
      const first = await probeClient(daemon);
      const work = join(fixture.path, "work");

      await mkdir(work, { recursive: true });

      const { terminalID } = await sessionWithShell(first, work);

      first.send({ type: "attach", id: requestID(), terminalID, viewport: VIEWPORT });
      first.type(terminalID, "printf 'QUIET-MARKER\\n'\n");
      await waitForText(first, terminalID, "QUIET-MARKER");
      first.close();

      const second = await probeClient(daemon);

      expect(
        (await second.ask({ type: "attach", id: requestID(), terminalID, viewport: VIEWPORT }))
          .type,
      ).toBe("acknowledged");

      const repaint = await waitFor(
        "a repaint arrives for the reattaching client",
        () => second.repaints()[0],
        daemon.log,
      );

      expect([repaint[0], repaint[1]]).toEqual([0x1b, 0x63]);
      expect(repaintText(second)).toContain("QUIET-MARKER");

      second.close();
      await daemon.stop();
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "answers an attach with the screen, and keeps the history only in the scrollback",
    async () => {
      await using fixture = await isolatedHome();
      const daemon = await startDaemon(fixture.path);
      const probe = await probeClient(daemon);
      const work = join(fixture.path, "work");

      await mkdir(work, { recursive: true });

      const { terminalID } = await sessionWithShell(probe, work);

      probe.send({ type: "attach", id: requestID(), terminalID, viewport: VIEWPORT });
      probe.type(terminalID, "for i in $(seq -f '%02g' 1 60); do printf 'line-%s\\n' $i; done\n");
      await waitForText(probe, terminalID, "line-60");

      const arriving = await probeClient(daemon);

      expect(
        (await arriving.ask({ type: "attach", id: requestID(), terminalID, viewport: VIEWPORT }))
          .type,
      ).toBe("acknowledged");

      const repaint = await waitFor(
        "the arriving client is sent a repaint",
        () => (arriving.repaints().length > 0 ? repaintText(arriving) : undefined),
        daemon.log,
      );
      const history = await snapshot(arriving, terminalID, true);

      expect(repaint).toContain("line-60");
      expect(repaint).not.toContain("line-01");
      expect(history).toContain("line-01");

      arriving.close();
      probe.close();
      await daemon.stop();
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "sizes the pty to the minimum of two attached viewports, and grows it back",
    async () => {
      await using fixture = await isolatedHome();
      const daemon = await startDaemon(fixture.path);
      const small = await probeClient(daemon);
      const work = join(fixture.path, "work");

      await mkdir(work, { recursive: true });

      const { terminalID } = await sessionWithShell(small, work);

      expect(
        (
          await small.ask({
            type: "attach",
            id: requestID(),
            terminalID,
            viewport: { columns: 40, rows: 12 },
          })
        ).type,
      ).toBe("acknowledged");

      const large = await probeClient(daemon);

      expect(
        (
          await large.ask({
            type: "attach",
            id: requestID(),
            terminalID,
            viewport: { columns: 100, rows: 40 },
          })
        ).type,
      ).toBe("acknowledged");

      large.type(terminalID, "stty size\n");

      const shared = await waitFor("the child reports the negotiated size", async () => {
        const sizes = reportedSizes(await snapshot(large, terminalID, true));

        return sizes.length > 0 ? sizes : undefined;
      });

      expect(shared.at(-1)).toBe("12 40");
      expect(repaintText(large)).toContain("\u001b[8;12;40t");
      expect((await small.ask({ type: "detach", id: requestID(), terminalID })).type).toBe(
        "acknowledged",
      );

      large.type(terminalID, "stty size\n");

      const alone = await waitFor("the child reports the size it grew back to", async () => {
        const sizes = reportedSizes(await snapshot(large, terminalID, true));

        return sizes.at(-1) === "40 100" ? sizes : undefined;
      });

      expect(alone.at(-1)).toBe("40 100");

      small.close();
      large.close();
      await daemon.stop();
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "refuses a newer client without touching a single terminal",
    async () => {
      await using fixture = await isolatedHome();
      const daemon = await startDaemon(fixture.path);
      const probe = await probeClient(daemon);
      const work = join(fixture.path, "work");

      await mkdir(work, { recursive: true });

      const { terminalID } = await sessionWithShell(probe, work);

      probe.send({ type: "attach", id: requestID(), terminalID, viewport: VIEWPORT });
      probe.type(terminalID, `${EMITTER}\n`);

      const before = highestTick(await waitForText(probe, terminalID, "tick-0002"));
      const children = daemon.children();
      const newer = await probeClient(daemon, {
        protocolVersion: PROTOCOL_VERSION + 1,
        minimumSupported: PROTOCOL_VERSION + 1,
        clientName: "survival-probe-newer",
      });

      expect(newer.greeting).toEqual({
        type: "refused",
        refusal: {
          kind: "incompatibleVersion",
          daemonMinimum: MINIMUM_SUPPORTED_VERSION,
          daemonCurrent: PROTOCOL_VERSION,
        },
      });

      await waitFor("the refused connection is closed", () => (newer.closed() ? true : undefined));

      expect(daemon.log()).not.toContain("hung up every terminal");
      expect(daemon.children()).toEqual(children);
      expect(probe.terminalState(terminalID)?.kind).toBe("running");

      const after = await waitFor(
        "the terminal makes progress after the refusal",
        async () => {
          const tick = highestTick(await snapshot(probe, terminalID, true));

          return tick > before ? tick : undefined;
        },
        daemon.log,
      );

      expect(after).toBeGreaterThan(before);

      probe.type(terminalID, "\u0003printf 'ALIVE-AFTER-SKEW\\n'\n");
      await waitForText(probe, terminalID, "ALIVE-AFTER-SKEW");

      probe.close();
      await daemon.stop();
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "after SIGKILL its replacement rebinds the stale socket and restores every session as idle",
    async () => {
      await using fixture = await isolatedHome();
      const killed = await startDaemon(fixture.path);
      const probe = await probeClient(killed);
      const work = join(fixture.path, "work");

      await mkdir(work, { recursive: true });

      const { session, terminalID } = await sessionWithShell(probe, work);

      probe.send({ type: "attach", id: requestID(), terminalID, viewport: VIEWPORT });
      probe.type(terminalID, `${EMITTER}\n`);
      await waitForText(probe, terminalID, "tick-0002");

      const orphans = killed.children();

      expect(orphans.length).toBeGreaterThan(0);

      killed.kill("SIGKILL");

      expect(await killed.exited).not.toBe(0);

      probe.close();

      expect((await lstat(killed.socketPath)).isSocket()).toBe(true);

      const replacement = await startDaemon(fixture.path);
      const rejoined = await probeClient(replacement);

      expect(rejoined.greeting.type).toBe("hello");
      expect(
        (await rejoined.ask({ type: "subscribe", id: requestID(), scope: { kind: "state" } })).type,
      ).toBe("acknowledged");

      const restored = await waitFor("the session is restored from the database", () =>
        rejoined.sessions().find((candidate) => candidate.id === session.id),
      );

      expect(restored.terminals.map((descriptor) => descriptor.id)).toEqual([terminalID]);
      expect(rejoined.terminalState(terminalID)?.kind ?? "idle").toBe("idle");
      expect(replacement.children()).toEqual([]);
      expect(
        (await rejoined.ask({ type: "startTerminal", id: requestID(), terminalID })).type,
      ).toBe("acknowledged");

      rejoined.send({ type: "attach", id: requestID(), terminalID, viewport: VIEWPORT });
      rejoined.type(terminalID, "printf 'RECOVERED-%s\\n' \"$$\"\n");
      await waitForText(rejoined, terminalID, "RECOVERED-");

      rejoined.close();
      await replacement.stop();
      reap(orphans);
    },
    STEP_TIMEOUT_MS,
  );
});
