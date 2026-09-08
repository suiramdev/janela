import { afterEach, describe, expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import { join } from "node:path";

import {
  absolutePath,
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
});
