#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { lstat, mkdir, symlink } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { Subprocess } from "bun";

export interface LineSplitter {
  push(chunk: Uint8Array): string[];
  flush(): string[];
}

interface Options {
  web: boolean;
  isolated: boolean;
}

interface Run {
  home: string;
  daemon: Piped | undefined;
  app: Subprocess;
  companions: readonly Piped[];
}

type Piped = Subprocess<"ignore", "pipe", "pipe">;

const REPO_ROOT = new URL("..", import.meta.url).pathname;

export const ISOLATED_ROOT = "/tmp/janela-iso";

export const ISOLATED_DOTFILES = [
  ".zshenv",
  ".zprofile",
  ".zshrc",
  ".bashrc",
  ".bash_profile",
  ".profile",
  ".gitconfig",
] as const;

export const POINTER_FILE = join(REPO_ROOT, ".janela", "isolated-home");

export const GATEWAY_PORT_BASE = 7412;

export const PORT_SPAN = 1000;

export const PORT_ATTEMPTS = 50;

const USAGE = "usage: bun run scripts/dev.ts [--web] [--isolated]";

const READY_DEADLINE_MS = 10_000;

const WEB_READY_DEADLINE_MS = 90_000;

const PROBE_INTERVAL_MS = 150;

const PROBE_TIMEOUT_MS = 250;

const APP_GRACE_MS = 5_000;

const EXIT_DRAIN_MS = 2_000;

const MAX_LINE_LENGTH = 64 * 1024;

const DAEMON_PREFIX = "janelad │ ";

const GATEWAY_PREFIX = "gateway │ ";

const WEB_PREFIX = "web     │ ";

const ID_LENGTH = 8;

const PORT_DIGITS_END = 12;

const HEX = 16;

const PRIVATE_DIRECTORY = 0o700;

export function lineSplitter(limit: number = MAX_LINE_LENGTH): LineSplitter {
  const decoder = new TextDecoder();
  let carry = "";

  return {
    push(chunk: Uint8Array): string[] {
      carry += decoder.decode(chunk, { stream: true });
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";

      if (carry.length > limit) {
        lines.push(carry);
        carry = "";
      }

      return lines;
    },
    flush(): string[] {
      if (carry === "") return [];

      const last = carry;
      carry = "";

      return [last];
    },
  };
}

export async function daemonIsListening(
  socketPath: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const { promise, resolve: settleWith } = Promise.withResolvers<boolean>();
  const socket = connect(socketPath);

  const settle = (answer: boolean): void => {
    socket.destroy();
    settleWith(answer);
  };

  socket.setTimeout(timeoutMs, () => settle(false));
  socket.once("connect", () => settle(true));
  socket.once("error", () => settle(false));

  return await promise;
}

function checkoutDigest(repoRoot: string): string {
  return createHash("sha256").update(resolve(repoRoot)).digest("hex");
}

export function isolationId(repoRoot: string): string {
  return checkoutDigest(repoRoot).slice(0, ID_LENGTH);
}

export function isolatedHome(repoRoot: string): string {
  return join(ISOLATED_ROOT, isolationId(repoRoot));
}

export function socketPathUnder(home: string): string {
  return join(home, ".janela", "run", "janelad.sock");
}

export function preferredGatewayPort(repoRoot: string): number {
  const digits = checkoutDigest(repoRoot).slice(ID_LENGTH, PORT_DIGITS_END);

  return GATEWAY_PORT_BASE + (parseInt(digits, HEX) % PORT_SPAN);
}

export async function portIsFree(port: number): Promise<boolean> {
  const { promise, resolve: settle } = Promise.withResolvers<boolean>();
  const server = createServer();

  server.once("error", () => settle(false));
  server.listen(port, "127.0.0.1", () => server.close(() => settle(true)));

  return await promise;
}

export async function freePortFrom(
  start: number,
  attempts: number = PORT_ATTEMPTS,
): Promise<number | undefined> {
  for (let port = start; port < start + attempts; port += 1) {
    if (await portIsFree(port)) return port;
  }

  return undefined;
}

export async function seedDotfiles(realHome: string, isolated: string): Promise<readonly string[]> {
  const linked: string[] = [];

  for (const name of ISOLATED_DOTFILES) {
    const source = join(realHome, name);
    const target = join(isolated, name);

    const sourceExists = await lstat(source).then(
      () => true,
      () => false,
    );

    const targetExists = await lstat(target).then(
      () => true,
      () => false,
    );

    if (!sourceExists || targetExists) continue;

    await symlink(source, target);
    linked.push(name);
  }

  return linked;
}

function parseArguments(argv: readonly string[]): Options | undefined {
  const options: Options = { web: false, isolated: false };

  for (const argument of argv) {
    if (argument === "--web") options.web = true;
    else if (argument === "--isolated") options.isolated = true;
    else return undefined;
  }

  return options;
}

function residentDaemons(): string {
  const found = Bun.spawnSync(["pgrep", "-lf", String.raw`janelad|main\.ts --foreground`]);

  return new TextDecoder().decode(found.stdout).trim();
}

async function forward(stream: ReadableStream<Uint8Array>, prefix: string): Promise<void> {
  const splitter = lineSplitter();

  for await (const chunk of stream) {
    for (const line of splitter.push(chunk)) console.log(`${prefix}${line}`);
  }

  for (const line of splitter.flush()) console.log(`${prefix}${line}`);
}

function hasExited(child: Subprocess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function startDaemon(home: string): Piped {
  const entryPoint = join(REPO_ROOT, "apps", "daemon", "src", "main.ts");

  const daemon = Bun.spawn(["bun", "run", entryPoint, "--foreground"], {
    cwd: join(REPO_ROOT, "apps", "daemon"),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home },
  });

  void forward(daemon.stdout, DAEMON_PREFIX);
  void forward(daemon.stderr, DAEMON_PREFIX);

  return daemon;
}

async function waitForDaemon(daemon: Piped, socketPath: string): Promise<boolean> {
  const deadline = Date.now() + READY_DEADLINE_MS;

  while (Date.now() < deadline) {
    if (hasExited(daemon)) return false;

    if (await daemonIsListening(socketPath)) return true;

    await Bun.sleep(PROBE_INTERVAL_MS);
  }

  return false;
}

async function stopDaemon(daemon: Piped): Promise<void> {
  if (hasExited(daemon)) return;

  daemon.kill("SIGTERM");
  await daemon.exited;
  console.log("Stopped the janelad this script started. That closed the terminals it held.");
}

async function ensureDaemon(home: string): Promise<Piped | undefined> {
  const socketPath = socketPathUnder(home);

  if (await daemonIsListening(socketPath)) {
    console.log(`janelad is already listening on ${socketPath}. Reusing it.`);
    const resident = residentDaemons();
    console.log(
      resident === ""
        ? "  `pgrep` cannot name it; `lsof -U | grep janelad` shows the process holding the socket."
        : resident.replaceAll(/^/gm, "  "),
    );

    console.log("  Leaving it alone. To hand over to this checkout: bun run daemon:restart");

    return undefined;
  }

  const started = startDaemon(home);

  if (await waitForDaemon(started, socketPath)) return started;

  const failure = started.exitCode;
  started.kill("SIGTERM");
  await started.exited;
  console.error(
    failure === null
      ? `janelad did not bind ${socketPath} within ${READY_DEADLINE_MS / 1000}s. Not starting the app.`
      : `janelad exited ${failure} before it bound its socket. Not starting the app.`,
  );

  console.error("If this is a fresh checkout, `bun run bootstrap` first.");
  process.exit(1);
}

async function supervise(run: Run): Promise<void> {
  let started = run.daemon;
  let stopping = false;

  const announceDaemonExit = async (daemon: Piped): Promise<void> => {
    const code = await daemon.exited;

    if (stopping) return;

    console.log(
      `${DAEMON_PREFIX}exited (${code}). The app will retry; start another with \`HOME=${run.home} bun run daemon\`.`,
    );
  };

  const announceCompanionExit = async (companion: Piped): Promise<void> => {
    const code = await companion.exited;

    if (stopping) return;

    console.log(`${WEB_PREFIX}exited (${code}); the gateway keeps serving the last build`);
  };

  if (started !== undefined) void announceDaemonExit(started);

  for (const companion of run.companions) void announceCompanionExit(companion);

  const stopStarted = async (): Promise<void> => {
    if (started === undefined) return;

    const daemon = started;
    started = undefined;
    await stopDaemon(daemon);
  };

  const finish = (code: number): void => {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    process.exitCode = code;
    setTimeout(() => process.exit(code), EXIT_DRAIN_MS).unref();
  };

  const stopCompanions = async (): Promise<void> => {
    for (const companion of run.companions) {
      if (!hasExited(companion)) companion.kill("SIGTERM");
    }

    await Promise.race([
      Promise.all(run.companions.map((companion) => companion.exited)),
      Bun.sleep(APP_GRACE_MS),
    ]);
  };

  const shutdown = async (code: number): Promise<void> => {
    if (stopping) return;

    stopping = true;
    run.app.kill("SIGTERM");
    await Promise.race([run.app.exited, Bun.sleep(APP_GRACE_MS)]);
    await stopCompanions();
    await stopStarted();
    finish(code);
  };

  const onInterrupt = (): void => void shutdown(130);
  const onTerminate = (): void => void shutdown(143);
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);

  const code = await run.app.exited;
  stopping = true;
  await stopCompanions();
  await stopStarted();
  finish(code);
}

async function runShared(target: string): Promise<void> {
  const home = homedir();
  const daemon = await ensureDaemon(home);

  const app = Bun.spawn(["bun", "run", target], {
    cwd: REPO_ROOT,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  await supervise({ home, daemon, app, companions: [] });
}

function startWebBuild(): Piped {
  const build = Bun.spawn(
    ["bun", "run", "--cwd", join(REPO_ROOT, "apps", "web"), "build", "--watch"],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    },
  );

  void forward(build.stdout, WEB_PREFIX);
  void forward(build.stderr, WEB_PREFIX);

  return build;
}

function startGateway(home: string, port: number, webRoot: string): Piped {
  const entryPoint = join(REPO_ROOT, "apps", "gateway", "src", "main.ts");

  const gateway = Bun.spawn(
    ["bun", "run", entryPoint, "--port", String(port), "--web-root", webRoot],
    {
      cwd: join(REPO_ROOT, "apps", "gateway"),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: home },
    },
  );

  void forward(gateway.stdout, GATEWAY_PREFIX);
  void forward(gateway.stderr, GATEWAY_PREFIX);

  return gateway;
}

async function waitForGateway(gateway: Piped, port: number): Promise<boolean> {
  const deadline = Date.now() + READY_DEADLINE_MS;

  while (Date.now() < deadline) {
    if (hasExited(gateway)) return false;

    const answered = await fetch(`http://127.0.0.1:${port}/`).then(
      () => true,
      () => false,
    );

    if (answered) return true;

    await Bun.sleep(PROBE_INTERVAL_MS);
  }

  return false;
}

async function waitForWebBuild(indexPath: string): Promise<boolean> {
  const deadline = Date.now() + WEB_READY_DEADLINE_MS;

  while (Date.now() < deadline) {
    if (await Bun.file(indexPath).exists()) return true;

    await Bun.sleep(PROBE_INTERVAL_MS);
  }

  return false;
}

async function abortIsolated(
  message: string,
  daemon: Piped | undefined,
  children: readonly Piped[],
): Promise<never> {
  console.error(message);

  for (const child of children) {
    if (!hasExited(child)) child.kill("SIGTERM");
  }

  await Promise.race([Promise.all(children.map((child) => child.exited)), Bun.sleep(APP_GRACE_MS)]);

  if (daemon !== undefined) await stopDaemon(daemon);

  process.exit(1);
}

function printIsolatedBanner(home: string, port: number, linked: readonly string[]): void {
  console.log(`isolated HOME: ${home}`);
  console.log(`socket: ${socketPathUnder(home)}`);
  console.log(
    `database: ${join(home, "Library", "Application Support", "sh.janela.Janela", "janela.sqlite")}`,
  );

  console.log(`daemon log: ${join(home, "Library", "Logs", "sh.janela.Janela", "janelad.log")}`);
  console.log(`app: http://localhost:${port}`);
  console.log(`dotfiles linked: ${linked.length === 0 ? "none new" : linked.join(", ")}`);
  console.log(`probe: HOME=${home} bun run scripts/survival-probe.ts`);
  console.log(`clean slate: stop this, then rm -rf ${home}`);
  console.log(
    "never run bun run daemon:restart from here: it is pkill -x janelad and stops the user's installed daemon, never this one — Ctrl-C stops this one",
  );
}

async function runIsolated(): Promise<void> {
  const realHome = homedir();
  const home = isolatedHome(REPO_ROOT);
  await mkdir(home, { recursive: true, mode: PRIVATE_DIRECTORY });
  const linked = await seedDotfiles(realHome, home);
  await mkdir(dirname(POINTER_FILE), { recursive: true });
  await Bun.write(POINTER_FILE, `${home}\n`);

  const daemon = await ensureDaemon(home);

  const start = preferredGatewayPort(REPO_ROOT);
  const port = await freePortFrom(start);

  if (port === undefined) {
    await abortIsolated(
      `no free port in ${start}..${start + PORT_ATTEMPTS - 1}. Not starting the gateway.`,
      daemon,
      [],
    );
  }

  const webRoot = join(REPO_ROOT, "apps", "web", "dist");
  const webBuild = startWebBuild();
  const gateway = startGateway(home, port, webRoot);

  if (!(await waitForGateway(gateway, port))) {
    await abortIsolated(
      `gateway did not answer on ${port} within ${READY_DEADLINE_MS / 1000}s`,
      daemon,
      [gateway, webBuild],
    );
  }

  if (!(await waitForWebBuild(join(webRoot, "index.html")))) {
    console.warn(
      "web build has not produced apps/web/dist/index.html yet; the gateway answers 503 until it does",
    );
  }

  printIsolatedBanner(home, port, linked);

  await supervise({ home, daemon, app: gateway, companions: [webBuild] });
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));

  if (options === undefined) {
    console.error(USAGE);
    process.exit(2);
  }

  if (options.isolated) {
    await runIsolated();

    return;
  }

  await runShared(options.web ? "web:only" : "desktop:only");
}

if (import.meta.main) await main();
