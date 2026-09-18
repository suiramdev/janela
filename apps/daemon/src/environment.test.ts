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
import { Effect, Result } from "effect";

import { daemonEnvironment, type DaemonEnvironment } from "./environment.ts";

interface DaemonUnderTestOptions {
  readonly databasePath: string;
  readonly socketPath: string;
  readonly shell: ShellEnvironment;
}

interface DaemonUnderTest extends AsyncDisposable {
  readonly socketPath: string;
  readonly environment: DaemonEnvironment;
  startServing(): Promise<void>;
}

const REPLY_DEADLINE_MS = 2_000;

const RACED_ROUNDS = 10;

const RACED_TIMEOUT_MS = 60_000;

const shell: ShellEnvironment = {
  loginShell: "/bin/zsh",
  resolved: { PATH: "/usr/bin:/bin" },
  loginShellArguments: () => ["-zsh", "-l"],
};

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

setLogSink(nullLogSink);
afterEach(() => setLogSink(nullLogSink));

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
    settings: { worktreeRoot: { kind: "siblingDirectory" }, automation: {} },
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

function firstFrame(socket: Socket): Promise<Frame | undefined> {
  const decoder = frameDecoder();
  const { promise, resolve } = Promise.withResolvers<Frame | undefined>();

  socket.on("data", (chunk: Buffer) => {
    const [frame] = decoder.push(new Uint8Array(chunk));

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

function connectedEventually(path: string): Promise<Socket> {
  const { promise, resolve } = Promise.withResolvers<Socket>();

  const attempt = (): void => {
    const socket = connect(path);

    socket.once("connect", () => resolve(socket));
    socket.once("error", () => {
      socket.destroy();
      setImmediate(attempt);
    });
  };

  attempt();

  return promise;
}

function listening(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();

  setLogSink({
    write: (record) => {
      if (record.message === "listening") resolve();
    },
  });

  return promise;
}

async function openedDaemon(options: DaemonUnderTestOptions): Promise<DaemonUnderTest> {
  const environment = await daemonEnvironment({
    databasePath: options.databasePath,
    socketPath: options.socketPath,
    foreground: true,
    shell: options.shell,
  });
  const controller = new AbortController();
  let loop: Promise<void> | undefined;

  return {
    socketPath: options.socketPath,
    environment,

    startServing(): Promise<void> {
      const ready = listening();

      loop = environment.serve(controller.signal);

      return ready;
    },

    [Symbol.asyncDispose]: async () => {
      controller.abort();

      if (loop !== undefined) await loop;

      await environment.database.close();
    },
  };
}

describe("daemonEnvironment", () => {
  async function racedStart(root: string, round: number): Promise<void> {
    await using daemon = await openedDaemon({
      databasePath: join(root, `${round}.sqlite`),
      socketPath: join(root, String(round), "d.sock"),
      shell,
    });
    const arriving = connectedEventually(daemon.socketPath);

    void daemon.startServing();

    const socket = await arriving;
    const reply = firstFrame(socket);

    socket.write(HELLO);

    const frame = await Promise.race([reply, Bun.sleep(REPLY_DEADLINE_MS).then(() => undefined)]);

    if (frame === undefined) {
      throw new Error(
        `round ${round}: the daemon accepted the connection and never answered the hello`,
      );
    }

    expect(decodeDaemonMessage(frame).type).toBe("hello");

    socket.destroy();
  }

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

    await using daemon = await openedDaemon({
      databasePath,
      socketPath: join(directory.path, "run", "janelad.sock"),
      shell,
    });

    expect(daemon.environment.sessions.sessions).toHaveLength(2);
    expect(daemon.environment.projects.projects).toHaveLength(1);
    expect(daemon.environment.terminals.liveCount).toBe(0);
  });

  test("seeds the built-in launch profiles and probes them against the captured PATH", async () => {
    await using directory = await temporaryDirectory("environment");
    const bin = join(directory.path, "bin");

    await mkdir(bin, { recursive: true });
    await Bun.write(join(bin, "codex"), "#!/bin/sh\n");
    await chmod(join(bin, "codex"), 0o755);

    await using daemon = await openedDaemon({
      databasePath: join(directory.path, "janela.sqlite"),
      socketPath: join(directory.path, "run", "janelad.sock"),
      shell: { ...shell, resolved: { PATH: bin } },
    });
    const byName = new Map(
      daemon.environment.launchProfiles.profiles.map((profile) => [profile.name, profile]),
    );

    expect(byName.size).toBe(BUILT_IN_PROFILES.length);

    const codex = byName.get("Codex");
    const claude = byName.get("Claude Code");

    expect(codex).toBeDefined();
    expect(claude).toBeDefined();

    if (codex !== undefined) {
      expect(daemon.environment.launchProfiles.availability[codex.id]).toBe(true);
    }

    if (claude !== undefined) {
      expect(daemon.environment.launchProfiles.availability[claude.id]).toBe(false);
    }
  });

  test("a database it cannot open rejects rather than serving half a graph", async () => {
    await using directory = await temporaryDirectory("environment");
    const databasePath = join(directory.path, "occupied");

    await Bun.write(join(databasePath, "placeholder"), "x");

    const outcome = await Effect.runPromise(
      Effect.result(
        Effect.tryPromise({
          try: () => daemonEnvironment({ databasePath, foreground: true, shell }),
          catch: (cause: unknown) => cause,
        }),
      ),
    );

    expect(Result.isFailure(outcome)).toBe(true);
  });

  test("a peer that vanishes mid-frame costs the daemon nothing", async () => {
    await using directory = await temporaryDirectory("environment");
    await using daemon = await openedDaemon({
      databasePath: join(directory.path, "janela.sqlite"),
      socketPath: join(directory.path, "run", "janelad.sock"),
      shell,
    });

    await daemon.startServing();

    const doomed = await connected(daemon.socketPath);

    doomed.write(new Uint8Array([0, 0, 0, 32, 1]));
    doomed.destroy();

    const healthy = await connected(daemon.socketPath);
    const reply = firstFrame(healthy);

    healthy.write(HELLO);

    const frame = await reply;

    expect(frame).toBeDefined();

    if (frame !== undefined) expect(decodeDaemonMessage(frame).type).toBe("hello");

    healthy.destroy();
  });

  test(
    "a client that connects the instant the socket exists is answered, ten times out of ten",
    async () => {
      await using directory = await temporaryDirectory("startup");

      for (let round = 1; round <= RACED_ROUNDS; round += 1) {
        // oxlint-disable-next-line no-await-in-loop
        await racedStart(directory.path, round);
      }
    },
    RACED_TIMEOUT_MS,
  );
});
