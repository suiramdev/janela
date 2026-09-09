/**
 * The survival proof (#31), across two real processes.
 *
 * Every other test in this repository proves a piece. This one proves the bet in
 * ADR 0015: that a daemon can own terminals and a client can be nothing but a
 * renderer. It is the only test that runs the **compiled sidecar** — the artifact
 * `apps/desktop/scripts/sidecar.ts` puts in the bundle — as a separate process,
 * from a directory containing nothing but the binary, and talks to it over a real
 * Unix socket with real frames.
 *
 * CI already proves that binary *runs* from an empty directory (`./janelad
 * --version`, which deliberately touches nothing else). This proves it *works*
 * from one: it binds its socket, migrates its database, spawns a real PTY through
 * a dylib that exists only inside the executable, and keeps that child alive with
 * every client gone.
 *
 * ## Isolation, and why `HOME`
 *
 * `defaultSocketPath()` and `defaultDatabasePath()` are both derived from
 * `homedir()`, and there is no `--socket` flag — `main.ts` parses `--version` and
 * `--foreground`, nothing else. Spawning the sidecar with `HOME` pointing at a
 * temporary directory therefore moves *both* its socket and its database, so a
 * test run cannot touch, or be disturbed by, the daemon holding the developer's
 * own terminals. That property is what makes this proof safe to automate; without
 * it, `bun test` would fight a resident `janelad` for one socket path.
 *
 * ## What this file deliberately does not claim
 *
 * - **launchd.** Steps 3, 6 and 7 of the written procedure have a launchd half — a
 *   registered LaunchAgent, `KeepAlive` restarting a killed daemon — that only a
 *   bundled `Janela.app` can exercise, because `agent.rs` reports `unsupported`
 *   for any executable outside `Contents/MacOS`. Automated here is the daemon's
 *   half: a killed daemon's replacement rebinds and restores. `docs/survival-proof.md`
 *   records which rung of that ladder was actually reached, and by whom.
 * - **Deltas.** `repaintSince` is still a placeholder that answers any revision
 *   mismatch with a whole grid, so nothing below asserts that a second repaint is
 *   incremental. That is #32's to earn.
 * - **What the window looks like.** Letterboxing is a rendering claim and lives in
 *   the manual procedure. The negotiated size is asserted here through the one
 *   observer that cannot be wrong about it: the child's own `stty size`.
 */

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
  type RequestID,
  type StateUpdate,
} from "@janela/protocol";

/** `apps/daemon`, whose `build` script is the one that ships. */
const packageDirectory = dirname(import.meta.dir);

/**
 * An isolated `HOME` for one daemon, and deliberately not
 * `temporaryDirectory()` from `@janela/test-support`.
 *
 * The daemon derives its socket path from `homedir()` and refuses one longer
 * than `sockaddr_un.sun_path` — 104 bytes on macOS, which
 * `packages/daemon/src/endpoint.ts` measures rather than truncates. A macOS
 * per-user `TMPDIR` is already about 50 of those bytes before any label or
 * random suffix, so a fixture under it makes
 * `<home>/.janela/run/janelad.sock` 109 bytes and the daemon correctly declines
 * to start. `/tmp` is what leaves room. Each home is still unique, so files run
 * in parallel without collision.
 */
async function isolatedHome(): Promise<{ readonly path: string } & AsyncDisposable> {
  const path = await mkdtemp("/tmp/jd-");
  return {
    path,
    [Symbol.asyncDispose]: async () => {
      await rm(path, { recursive: true, force: true });
    },
  };
}

/**
 * Long enough for a database migration, a login-shell capture, a PTY spawn and a
 * shell prompt, on a machine also running the rest of the suite in parallel.
 * Generous on purpose: a survival test that flakes teaches people to ignore it.
 */
const STEP_TIMEOUT_MS = 90_000;

/**
 * How long one reply, state announcement or observable condition is waited for.
 *
 * A backstop, not a wait: every step below returns as soon as the other process
 * has answered. It is this generous because the first execution of a freshly
 * copied 71 MB binary can spend seconds inside macOS's signature evaluation
 * before `main` runs at all, and because a heavy `~/.zshrc` is on the daemon's
 * start-up path through its login-shell capture.
 */
const REPLY_TIMEOUT_MS = 30_000;

/**
 * The compiled sidecar, built once for the file rather than once per test.
 *
 * `bun build --compile` takes about 200 ms, so this is not a performance
 * concession: building once means every test below runs the same bytes, which is
 * what "the compiled sidecar is what was tested" has to mean.
 */
let sidecarPath = "";

beforeAll(async () => {
  // The package's own `build` script, not a copy of its flags. The point is to
  // test the artifact the bundle ships, and a second copy of
  // `--compile --minify --sourcemap --target=…` here would be free to drift.
  const build = Bun.spawn(["bun", "run", "build"], {
    cwd: packageDirectory,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, failure] = await Promise.all([build.exited, new Response(build.stderr).text()]);
  if (status !== 0) throw new Error(`compiling the sidecar failed: ${failure}`);
  sidecarPath = join(packageDirectory, "janelad");
});

/** Every daemon a test started, so that nothing outlives the file. */
const started = new Set<DaemonProcess>();

afterAll(async () => {
  await Promise.all([...started].map((daemon) => daemon.stop()));
});

/**
 * Waits for something only the other process can tell us.
 *
 * Deliberately a real-time poll rather than a fake clock: the condition lives in
 * a separate operating-system process with its own timers, so there is no clock
 * here to advance. The predicate is the assertion — a failure names the condition
 * that never came true rather than a timeout.
 */
async function waitFor<T>(
  what: string,
  observe: () => T | undefined | Promise<T | undefined>,
  context: () => string = () => "",
): Promise<T> {
  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  for (;;) {
    // Sequential by nature: each look asks the other process what is true *now*,
    // and there is nothing to run in parallel with the answer.
    // oxlint-disable-next-line no-await-in-loop
    const seen = await observe();
    if (seen !== undefined) return seen;
    if (Date.now() > deadline) throw new Error(`never became true: ${what}\n${context()}`);
    // oxlint-disable-next-line no-await-in-loop
    await Bun.sleep(25);
  }
}

interface DaemonProcess {
  /** Inside the isolated `HOME`, so it can never be the developer's. */
  readonly socketPath: string;
  readonly pid: number;
  /** Everything the daemon logged, for a failure message worth reading. */
  readonly log: () => string;
  /** Its direct children — the shells it spawned. */
  readonly children: () => readonly number[];
  readonly kill: (signal: NodeJS.Signals) => void;
  readonly exited: Promise<number | null>;
  readonly stop: () => Promise<void>;
}

/** Whether the daemon's socket accepts a connection right now. */
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

/** `SIGKILL` to processes that should already be gone. */
function reap(pids: readonly number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone, which is the common case: a graceful shutdown hung it up.
    }
  }
}

/**
 * Starts the compiled sidecar in its own world: an isolated `HOME`, and a working
 * directory it does not share with this repository.
 *
 * `alone` copies the binary into that directory first, so it runs with nothing
 * beside it. Only one test needs that — it is what proves self-containment — and
 * it costs 71 MB of I/O, which is enough to slow the rest of the suite down and
 * push a neighbouring test's RAM-disk fixture past its timeout. So it is opt-in
 * rather than free.
 *
 * Readiness is the socket accepting: since #43 a connection accepted before the
 * accept loop runs is queued, not dropped, so `probeClient`'s zero-delay hello is
 * the proof.
 */
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
    // A deliberately tiny environment. `HOME` moves the socket and the database,
    // `TMPDIR` keeps the dylib the binary unpacks inside the fixture, and `PATH`
    // is what the daemon's login-shell capture needs to find anything at all.
    env: { HOME: home, PATH: process.env["PATH"] ?? "", TMPDIR: home },
    stdout: "ignore",
    stderr: "pipe",
  });

  const lines: string[] = [];
  void (async () => {
    const decoder = new TextDecoder();
    // The daemon writes one JSON record per line to stderr. Read it continuously
    // so a full pipe can never be what stalls the process under test.
    for await (const chunk of spawned.stderr as unknown as AsyncIterable<Uint8Array>) {
      lines.push(decoder.decode(chunk));
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
      // The children by hand: a `SIGKILL`ed daemon never runs `hangUpAll()`, so
      // its shells are reparented and would outlive the suite. See
      // docs/survival-proof.md § Step 7.
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

/** The client messages that carry a request id, so a reply can be correlated. */
type Request = Extract<ClientMessage, { readonly id: RequestID }>;

interface Probe {
  readonly greeting: DaemonMessage;
  readonly send: (message: ClientMessage) => void;
  /** Sends a request and returns its reply, ignoring announcements in between. */
  readonly ask: (request: Request) => Promise<DaemonMessage>;
  readonly type: (terminalID: TerminalID, text: string) => void;
  readonly nextControl: () => Promise<DaemonMessage>;
  readonly sessions: () => readonly Session[];
  readonly terminalState: (terminalID: TerminalID) => TerminalState | undefined;
  /** Every repaint received, in order, already copied out of the decoder. */
  readonly repaints: () => readonly Uint8Array[];
  readonly closed: () => boolean;
  readonly close: () => void;
}

/**
 * A client, as a CLI would be one: a socket, the framing, and nothing else.
 *
 * Everything the app's client does on top of this — the mirror, reconnection,
 * request bookkeeping — is `@janela/client`'s and is tested there against an
 * in-memory transport. What is under test here is the two processes.
 */
async function probeClient(
  daemon: DaemonProcess,
  hello: { protocolVersion: number; minimumSupported: number; clientName: string } = {
    protocolVersion: PROTOCOL_VERSION,
    minimumSupported: MINIMUM_SUPPORTED_VERSION,
    clientName: "survival-probe",
  },
): Promise<Probe> {
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
  let terminalStates: Record<string, TerminalState> = {};
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
      // A decoded payload is a view valid only until the next `push`, so the copy
      // is not defensive politeness — it is the difference between reading this
      // repaint and reading the next one.
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
      // Woken by a frame or by the close; the deadline is only a backstop, so a
      // hung daemon fails with a message instead of hanging the suite.
      const woken = Promise.withResolvers<void>();
      wakers.push(woken.resolve);
      // Parking until the next frame arrives is the whole job here.
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
        // Announcements arrive between a request and its reply, so this drains
        // them one at a time until the correlation id matches.
        // oxlint-disable-next-line no-await-in-loop
        const message = await nextControl();
        if ("id" in message && message.id === request.id) return message;
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

/** The text of every repaint so far, concatenated. */
function repaintText(probe: Probe): string {
  const decoder = new TextDecoder();
  return probe
    .repaints()
    .map((bytes) => decoder.decode(bytes))
    .join("");
}

/** What is on screen, or in the whole history, as the CLI would ask for it. */
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

/** Waits until the terminal's screen or history contains `needle`. */
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

let lastRequestID = 0;
function requestID(): RequestID {
  lastRequestID += 1;
  return lastRequestID as RequestID;
}

/**
 * A subscribed client, a session on a real directory, and its shell started.
 *
 * `createSession` configures a terminal; nothing spawns until `startTerminal`,
 * which is the laziness non-negotiable and the reason this helper has two steps.
 */
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

/**
 * A long-lived process that emits output, typed into the shell the way a person
 * would. `yes` is the issue's example; a counter with a pause is the same shape
 * and lets an assertion say *how much* progress was made while nobody watched.
 */
const EMITTER = String.raw`i=0; while :; do i=$((i+1)); printf 'tick-%04d\n' $i; sleep 0.1; done`;

/** The highest `tick-NNNN` in some terminal text, or -1 if there is none. */
function highestTick(text: string): number {
  let highest = -1;
  for (const match of text.matchAll(/tick-(\d{4})/g)) {
    const tick = Number.parseInt(match[1] ?? "", 10);
    if (tick > highest) highest = tick;
  }
  return highest;
}

/** Every `stty size` line the child printed, as `rows columns`. */
function reportedSizes(text: string): readonly string[] {
  return [...text.matchAll(/^(\d+ \d+)$/gm)].map((match) => match[1] ?? "");
}

describe("the compiled sidecar, as a daemon that outlives its clients", () => {
  test(
    "spawns a real PTY from a directory containing nothing but itself",
    async () => {
      await using fixture = await isolatedHome();
      // The one test that runs the binary from a directory containing nothing
      // else, which is the claim CI's `--version` check cannot make.
      const daemon = await startDaemon(fixture.path, true);
      const probe = await probeClient(daemon);
      expect(probe.greeting.type).toBe("hello");

      const work = join(fixture.path, "work");
      await mkdir(work, { recursive: true });
      const { terminalID } = await sessionWithShell(probe, work);

      // The child is the daemon's, not this test's. That is the whole ownership
      // claim, and `pgrep -P` is the operating system agreeing with it.
      const children = await waitFor(
        "the daemon has a child process",
        () => {
          const found = daemon.children();
          return found.length > 0 ? found : undefined;
        },
        daemon.log,
      );
      expect(children.length).toBeGreaterThan(0);

      probe.send({
        type: "attach",
        id: requestID(),
        terminalID,
        viewport: { columns: 80, rows: 24 },
      });
      probe.type(terminalID, "printf 'PTY-ALIVE-%s\\n' \"$$\"\n");
      const text = await waitForText(probe, terminalID, "PTY-ALIVE-");
      // The shell's own pid, echoed back through a PTY the binary opened with a
      // dylib that exists only inside itself.
      expect(/PTY-ALIVE-\d+/.test(text)).toBe(true);

      // Two facts about self-containment, which CI's `--version` cannot show:
      // the working directory held only the executable, and the database it
      // migrated is the one inside the fixture.
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

      first.send({
        type: "attach",
        id: requestID(),
        terminalID,
        viewport: { columns: 80, rows: 24 },
      });
      first.type(terminalID, `${EMITTER}\n`);
      const before = highestTick(await waitForText(first, terminalID, "tick-0002"));
      const childrenBefore = daemon.children();
      expect(childrenBefore.length).toBeGreaterThan(0);

      // Every client gone. This is "quit the app entirely", reduced to the only
      // thing the daemon can observe about it.
      first.close();
      await waitFor(
        "the daemon records the client leaving",
        () => (daemon.log().includes("client disconnected") ? true : undefined),
        daemon.log,
      );

      // A real interval with nobody watching, because that is the scenario: there
      // is no clock to advance in another process, and no observer to ask.
      await Bun.sleep(1_000);

      const second = await probeClient(daemon);
      expect(second.greeting.type).toBe("hello");
      expect(
        (await second.ask({ type: "subscribe", id: requestID(), scope: { kind: "state" } })).type,
      ).toBe("acknowledged");

      // Asserted on the first snapshot after reconnecting, before this client
      // does anything else: the progress can only have happened while detached.
      const after = highestTick(await snapshot(second, terminalID, true));
      expect(after).toBeGreaterThan(before + 1);

      // Same child, still the daemon's. Not a replacement started on reattach.
      expect(daemon.children()).toEqual(childrenBefore);
      expect(second.terminalState(terminalID)?.kind).toBe("running");

      second.close();
      await daemon.stop();
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "sends a reattaching client the current screen, not a blank one",
    async () => {
      await using fixture = await isolatedHome();
      const daemon = await startDaemon(fixture.path);
      const first = await probeClient(daemon);
      const work = join(fixture.path, "work");
      await mkdir(work, { recursive: true });
      const { terminalID } = await sessionWithShell(first, work);

      first.send({
        type: "attach",
        id: requestID(),
        terminalID,
        viewport: { columns: 80, rows: 24 },
      });
      first.type(terminalID, "printf 'QUIET-MARKER\\n'\n");
      await waitForText(first, terminalID, "QUIET-MARKER");
      first.close();

      // **A quiet terminal, deliberately.** A terminal that is still producing
      // output would be repainted by the next frame whatever attaching did, so it
      // cannot tell a correct attach from a broken one. Nothing is running here
      // but a shell at its prompt, so the only thing that can put the screen on a
      // reattaching client is the full repaint the frame loop owes a fresh
      // attachment — and a client's revision starts level with the emulator
      // (`LiveTerminal.attach`), so "send what changed" would send nothing.
      const second = await probeClient(daemon);
      expect(
        (
          await second.ask({
            type: "attach",
            id: requestID(),
            terminalID,
            // The same viewport as the departed client, on purpose: a different
            // one would resize the emulator, bump its revision, and produce a
            // repaint for the wrong reason.
            viewport: { columns: 80, rows: 24 },
          })
        ).type,
      ).toBe("acknowledged");

      // The repaint is owed by the frame loop, not carried by the reply, so it
      // arrives just after the acknowledgement rather than in it.
      const repaint = await waitFor(
        "a repaint arrives for the reattaching client",
        () => second.repaints()[0],
        daemon.log,
      );

      // Every repaint opens with RIS, which is what makes replaying one onto an
      // already-populated receiver correct rather than lucky.
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

      probe.send({
        type: "attach",
        id: requestID(),
        terminalID,
        viewport: { columns: 80, rows: 24 },
      });
      probe.type(terminalID, "for i in $(seq -f '%02g' 1 60); do printf 'line-%s\\n' $i; done\n");
      await waitForText(probe, terminalID, "line-60");

      // A client arriving after all sixty lines were printed, so its first
      // repaint is the whole grid and nothing else.
      const arriving = await probeClient(daemon);
      expect(
        (
          await arriving.ask({
            type: "attach",
            id: requestID(),
            terminalID,
            viewport: { columns: 80, rows: 24 },
          })
        ).type,
      ).toBe("acknowledged");
      const repaint = await waitFor(
        "the arriving client is sent a repaint",
        () => (arriving.repaints().length > 0 ? repaintText(arriving) : undefined),
        daemon.log,
      );
      const history = await snapshot(arriving, terminalID, true);

      // "Attach is a screen, not a history" (ADR 0015): sixty lines through a
      // 24-row viewport means the repaint carries the tail and the first line
      // exists only in the scrollback. This is exactly why step 4 of the
      // procedure proves detached progress with `snapshotText` and not with a
      // repaint — and why serialising 10 000 lines on every attach would be the
      // wrong fix if someone ever "improves" this.
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

      // Asked of the child, because the child is the only party that cannot be
      // wrong about its own window size — and because nothing on the wire tells a
      // client what the negotiated size is.
      large.type(terminalID, "stty size\n");
      const shared = await waitFor("the child reports the negotiated size", async () => {
        const sizes = reportedSizes(await snapshot(large, terminalID, true));
        return sizes.length > 0 ? sizes : undefined;
      });
      expect(shared.at(-1)).toBe("12 40");

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

      probe.send({
        type: "attach",
        id: requestID(),
        terminalID,
        viewport: { columns: 80, rows: 24 },
      });
      probe.type(terminalID, `${EMITTER}\n`);
      const before = highestTick(await waitForText(probe, terminalID, "tick-0002"));
      const children = daemon.children();

      // An app one wire version ahead of this daemon, which is what an update
      // that has not restarted the background service looks like.
      const newer = await probeClient(daemon, {
        protocolVersion: PROTOCOL_VERSION + 1,
        minimumSupported: MINIMUM_SUPPORTED_VERSION + 1,
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

      // The cost of the refusal, measured on the things a user would lose.
      expect(daemon.log()).not.toContain("hung up every terminal");
      expect(daemon.children()).toEqual(children);
      expect(probe.terminalState(terminalID)?.kind).toBe("running");
      // Awaited rather than sampled: the emitter's next line is a hundred
      // milliseconds away and the refusal took one, so a sample proves nothing
      // either way. What matters is that progress resumes at all.
      const after = await waitFor(
        "the terminal makes progress after the refusal",
        async () => {
          const tick = highestTick(await snapshot(probe, terminalID, true));
          return tick > before ? tick : undefined;
        },
        daemon.log,
      );
      expect(after).toBeGreaterThan(before);

      // And the compatible client can still work, which is the other half of "a
      // refusal is never fatal to the daemon".
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

      probe.send({
        type: "attach",
        id: requestID(),
        terminalID,
        viewport: { columns: 80, rows: 24 },
      });
      probe.type(terminalID, `${EMITTER}\n`);
      await waitForText(probe, terminalID, "tick-0002");

      // Captured before the kill: `SIGKILL` skips `hangUpAll()`, so these shells
      // are reparented and nothing else will ever come for them.
      const orphans = killed.children();
      expect(orphans.length).toBeGreaterThan(0);

      killed.kill("SIGKILL");
      expect(await killed.exited).not.toBe(0);
      probe.close();

      // The socket file outlives the process. launchd's `KeepAlive` would start
      // the replacement; here the test is the replacement, and what matters is
      // that it can start at all — a daemon that refused to rebind would need a
      // human with `rm` before the user got their sessions back.
      //
      // `lstat`, not `Bun.file(...).exists()`: that answers false for anything
      // that is not a regular file, and this is a socket.
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
      // Idle by construction: `load()` reads the database and starts nothing, so
      // no session comes back claiming a process that died with the daemon.
      expect(rejoined.terminalState(terminalID)?.kind ?? "idle").toBe("idle");
      expect(replacement.children()).toEqual([]);

      // And recovery costs nothing but a start — no removal, no repair, no
      // terminal killed to make it work.
      expect(
        (await rejoined.ask({ type: "startTerminal", id: requestID(), terminalID })).type,
      ).toBe("acknowledged");
      rejoined.send({
        type: "attach",
        id: requestID(),
        terminalID,
        viewport: { columns: 80, rows: 24 },
      });
      rejoined.type(terminalID, "printf 'RECOVERED-%s\\n' \"$$\"\n");
      await waitForText(rejoined, terminalID, "RECOVERED-");

      rejoined.close();
      await replacement.stop();
      reap(orphans);
    },
    STEP_TIMEOUT_MS,
  );
});
