import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { join } from "node:path";

import {
  absolutePath,
  BUILT_IN_PROFILES,
  newProjectID,
  newSessionID,
  newTerminalID,
  now,
  type Project,
  type Session,
  type SessionLayout,
  type TerminalDescriptor,
  type TerminalID,
} from "@janela/core";
import { openDatabase } from "@janela/db";
import {
  decodeDaemonMessage,
  encodeClientMessage,
  encodeFrame,
  frameDecoder,
  MINIMUM_SUPPORTED_VERSION,
  PROTOCOL_VERSION,
  type Frame,
} from "@janela/protocol";
import type { ShellEnvironment } from "@janela/session";
import { nullLogSink, setLogSink } from "@janela/support";
import { temporaryDirectory } from "@janela/test-support";

import { daemonEnvironment } from "./environment.ts";

setLogSink(nullLogSink);
afterEach(() => setLogSink(nullLogSink));

/**
 * A fixed environment instead of one `zsh -lc` per test.
 *
 * The capture is real production behaviour and is tested where it lives; reading
 * the developer's dotfiles here would make this suite slow and non-hermetic.
 */
const shell: ShellEnvironment = {
  loginShell: "/bin/zsh",
  resolved: { PATH: "/usr/bin:/bin" },
  loginShellArguments: () => ["-zsh", "-l"],
};

function terminal(): TerminalDescriptor {
  return {
    id: newTerminalID(),
    title: "zsh",
    startsAutomatically: true,
    role: { kind: "user" },
    createdAt: now(),
  };
}

function oneTab(id: TerminalID): SessionLayout {
  return { tabs: [{ root: { kind: "terminal", id }, focusedTerminalID: id }], focusedTabIndex: 0 };
}

function persistedProject(): Project {
  return {
    id: newProjectID(),
    name: "janela",
    directory: absolutePath(`/tmp/janela-${crypto.randomUUID()}`),
    settings: { worktreeRoot: { kind: "siblingDirectory" }, automation: [], isForgeEnabled: true },
    accent: "none",
    isExpanded: true,
    addedAt: now(),
  };
}

function persistedSession(name: string): Session {
  const first = terminal();
  return {
    id: newSessionID(),
    name,
    directory: absolutePath(`/tmp/janela-session-${crypto.randomUUID()}`),
    backing: { kind: "folder" },
    terminals: [first],
    layout: oneTab(first.id),
    accent: "none",
    createdAt: now(),
    lastActiveAt: now(),
    isPinned: false,
  };
}

/** The first frame to arrive, or `undefined` if the socket ends without one. */
function firstFrame(socket: Socket): Promise<Frame | undefined> {
  const decoder = frameDecoder();
  const { promise, resolve } = Promise.withResolvers<Frame | undefined>();
  socket.on("data", (chunk: Buffer) => {
    const [frame] = decoder.push(new Uint8Array(chunk));
    // Copied: a decoded payload is a view valid only until the next `push`.
    if (frame !== undefined) resolve({ kind: frame.kind, payload: new Uint8Array(frame.payload) });
  });
  socket.once("close", () => resolve(undefined));
  socket.once("error", () => resolve(undefined));
  return promise;
}

function connected(path: string): Promise<Socket> {
  const socket = connect(path);
  const { promise, resolve, reject } = Promise.withResolvers<Socket>();
  socket.once("connect", () => resolve(socket));
  socket.once("error", reject);
  return promise;
}

/**
 * Connects the instant the kernel accepts, with no readiness signal at all —
 * the shape of the app's retry after `launchctl kickstart`.
 */
function connectedEventually(path: string): Promise<Socket> {
  const { promise, resolve } = Promise.withResolvers<Socket>();
  const attempt = (): void => {
    const socket = connect(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", () => {
      socket.destroy();
      // Yield between attempts: a synchronous retry starves the loop it is racing.
      setImmediate(attempt);
    });
  };
  attempt();
  return promise;
}

/**
 * Resolves when the daemon reports that it is listening.
 *
 * `serve()` resolves when serving *ends*, so a test needs a readiness signal —
 * and the daemon already emits one. Waiting on the log record rather than
 * sleeping until the socket file appears keeps this deterministic and adds no
 * production API that exists only for tests.
 */
function listening(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setLogSink({
    write: (record) => {
      if (record.message === "listening") resolve();
    },
  });
  return promise;
}

const HELLO = encodeFrame(
  encodeClientMessage({
    type: "hello",
    hello: {
      protocolVersion: PROTOCOL_VERSION,
      minimumSupported: MINIMUM_SUPPORTED_VERSION,
      clientName: "test",
    },
  }),
);

describe("daemonEnvironment", () => {
  test("restores persisted sessions as idle, spawning nothing", async () => {
    await using directory = await temporaryDirectory("environment");
    const databasePath = join(directory.path, "janela.sqlite");

    const seed = await openDatabase({ path: absolutePath(databasePath) });
    await seed.migrate();
    const project = persistedProject();
    await seed.projects.save(project);
    await seed.sessions.save({
      ...persistedSession("one"),
      projectID: project.id,
      backing: { kind: "projectDirectory" },
    });
    await seed.sessions.save(persistedSession("two"));
    await seed.close();

    const environment = await daemonEnvironment({ databasePath, foreground: true, shell });
    try {
      expect(environment.sessions.sessions).toHaveLength(2);
      expect(environment.projects.projects).toHaveLength(1);
      // The whole of "sessions restore as idle": a configured terminal that has
      // not been started costs nothing, so startup spawns no process at all.
      expect(environment.terminals.liveCount).toBe(0);
    } finally {
      await environment.database.close();
    }
  });

  test("seeds the built-in launch profiles and probes them against the captured PATH", async () => {
    await using directory = await temporaryDirectory("environment");
    // A PATH holding exactly one of the built-ins' executables. If the graph
    // handed the profile service anything other than the shell capture — a
    // synthetic environment, `process.env`, nothing at all — the availability
    // below would not match this directory's contents.
    const bin = join(directory.path, "bin");
    await mkdir(bin, { recursive: true });
    await Bun.write(join(bin, "codex"), "#!/bin/sh\n");
    await chmod(join(bin, "codex"), 0o755);

    const environment = await daemonEnvironment({
      databasePath: join(directory.path, "janela.sqlite"),
      foreground: true,
      shell: { ...shell, resolved: { PATH: bin } },
    });
    try {
      const byName = new Map(
        environment.launchProfiles.profiles.map((profile) => [profile.name, profile]),
      );
      // Seeded on first open, so a fresh install has something to start.
      expect(byName.size).toBe(BUILT_IN_PROFILES.length);

      const codex = byName.get("Codex");
      const claude = byName.get("Claude Code");
      expect(codex).toBeDefined();
      expect(claude).toBeDefined();
      if (codex !== undefined) {
        expect(environment.launchProfiles.availability[codex.id]).toBe(true);
      }
      if (claude !== undefined) {
        // Not installed on this PATH. Availability is a fact about the machine,
        // not something the user authored — so it is reported, not an error.
        expect(environment.launchProfiles.availability[claude.id]).toBe(false);
      }
    } finally {
      await environment.database.close();
    }
  });

  test("a database it cannot open rejects rather than serving half a graph", async () => {
    await using directory = await temporaryDirectory("environment");
    // A directory where the file should be: SQLite cannot open it, and the daemon
    // must not reach `serve`. `main` logs this and exits non-zero, which is what
    // stops launchd's KeepAlive spinning.
    const databasePath = join(directory.path, "occupied");
    await Bun.write(join(databasePath, "placeholder"), "x");

    const thrown = await daemonEnvironment({ databasePath, foreground: true, shell }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown).toBeDefined();
  });

  test("a peer that vanishes mid-frame costs the daemon nothing", async () => {
    await using directory = await temporaryDirectory("environment");
    const socketPath = join(directory.path, "run", "janelad.sock");
    const environment = await daemonEnvironment({
      databasePath: join(directory.path, "janela.sqlite"),
      foreground: true,
      socketPath,
      shell,
    });
    const controller = new AbortController();
    const ready = listening();
    const serving = environment.serve(controller.signal);
    await ready;

    try {
      // Client A: a five-byte header claiming a body it never sends, then gone.
      // That is the shape of a client that crashed mid-write.
      const doomed = await connected(socketPath);
      doomed.write(new Uint8Array([0, 0, 0, 32, 1]));
      doomed.destroy();

      // Client B: the daemon is still there and still handshakes.
      const healthy = await connected(socketPath);
      const reply = firstFrame(healthy);
      healthy.write(HELLO);
      const frame = await reply;

      expect(frame).toBeDefined();
      if (frame !== undefined) expect(decodeDaemonMessage(frame).type).toBe("hello");
      healthy.destroy();
    } finally {
      controller.abort();
      await serving;
      await environment.database.close();
    }
  });

  /**
   * One start, raced by a client that is already spinning on `connect`.
   *
   * A function rather than a loop body so the rounds — which must be sequential,
   * one daemon at a time — cost one awaited call each.
   */
  async function racedStart(root: string, round: number): Promise<void> {
    const socketPath = join(root, String(round), "d.sock");
    const environment = await daemonEnvironment({
      databasePath: join(root, `${round}.sqlite`),
      foreground: true,
      socketPath,
      shell,
    });
    const controller = new AbortController();
    // Racing the bind deliberately: this connector is already spinning when
    // `serve()` starts, so it lands in the window between `listen` and the accept
    // loop — the window a cold `launchctl kickstart` start opens.
    const arriving = connectedEventually(socketPath);
    const serving = environment.serve(controller.signal);

    try {
      const socket = await arriving;
      const reply = firstFrame(socket);
      socket.write(HELLO);
      // The bug under test is a silence, so the failure detector has to be a real
      // deadline: there is no event to await when nothing is coming. The passing
      // path resolves on the reply and never spends the 2 s.
      const frame = await Promise.race([reply, Bun.sleep(2_000).then(() => undefined)]);

      if (frame === undefined) {
        throw new Error(
          `round ${round}: the daemon accepted the connection and never answered the hello`,
        );
      }
      expect(decodeDaemonMessage(frame).type).toBe("hello");
      socket.destroy();
    } finally {
      controller.abort();
      await serving;
      await environment.database.close();
    }
  }

  test("a client that connects the instant the socket exists is answered, ten times out of ten", async () => {
    // A short label on purpose: the socket path has to stay under `sun_path`'s
    // 104 bytes once the per-round directory is appended.
    await using directory = await temporaryDirectory("startup");

    for (let round = 1; round <= 10; round += 1) {
      // One daemon at a time: the rounds are the measurement, not a workload.
      // oxlint-disable-next-line no-await-in-loop
      await racedStart(directory.path, round);
    }
  }, 60_000);
});
