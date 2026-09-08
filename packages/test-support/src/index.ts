/**
 * `@janela/test-support` — shared test helpers. Not shipped.
 *
 * Temporary directories, throwaway git repositories, fakes, and a recording log sink.
 *
 * ## The rule this package exists to enforce
 *
 * `bun test` runs files in parallel, as the suite always has. **A test that writes
 * to a fixed path is a test that fails when run in parallel**, and it fails
 * intermittently, which is worse than failing. So anything touching the filesystem
 * uses `temporaryDirectory` and nothing else.
 *
 * ## What we fake and what we do not
 *
 * - **Git is not faked.** Worktree behaviour is not something we can meaningfully
 *   mock: `git worktree add` either works against a real repository or it does not,
 *   and a mock would only prove our assumptions. So git tests use real repositories
 *   in temporary directories and accept the few hundred milliseconds. The same goes
 *   for `.worktreeinclude`, which is tested by creating a real worktree and looking
 *   at what landed in it.
 * - **PTYs are not faked either.** A pseudo-terminal is cheap and the interesting
 *   behaviour — controlling terminals, job control, SIGWINCH, back-pressure — is
 *   exactly what a fake would paper over.
 * - **Automation, attention policy and forge state are faked**, because the logic
 *   under test is the *decision*, not the subprocess.
 *
 * See docs/testing.md.
 */

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The git the fixtures run, resolved once from the developer's `PATH`.
 *
 * `Bun.spawn` and not `node:child_process`: that module is gated to
 * `@janela/support` by `scripts/layers.ts`, and the gate scans this package too.
 */
const GIT = Bun.which("git") ?? "/usr/bin/git";

/** A directory that deletes itself when disposed. */
export interface TemporaryDirectory extends AsyncDisposable {
  readonly path: string;
  join(...components: string[]): string;
}

export async function temporaryDirectory(label?: string): Promise<TemporaryDirectory> {
  const created = await mkdtemp(join(tmpdir(), `janela-${label ?? "test"}-`));
  // Realpath, because on macOS `os.tmpdir()` is `/var/folders/…` while every
  // path git prints back is `/private/var/folders/…`. A fixture path that does
  // not compare equal to git's own answer makes every worktree assertion a lie.
  const path = await realpath(created);

  return {
    path,
    join: (...components: string[]) => join(path, ...components),
    async [Symbol.asyncDispose](): Promise<void> {
      await rm(path, { recursive: true, force: true });
    },
  };
}

/**
 * A throwaway git repository with one commit on `main`.
 *
 * Hermetic on purpose: `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`,
 * `GIT_TERMINAL_PROMPT=0`, and `commit.gpgsign=false`, so the suite passes on a
 * machine with signing configured globally. A test that depends on the developer's
 * git config is a test that fails in CI for reasons nobody can reproduce.
 */
export interface GitFixture extends AsyncDisposable {
  readonly path: string;
  /** Runs git in the fixture. Throws on a non-zero exit, with the output. */
  git(...args: string[]): Promise<string>;
  /** Writes a file and commits it. */
  commit(file: string, contents: string, message?: string): Promise<void>;
}

export async function gitFixture(label?: string): Promise<GitFixture> {
  const directory = await temporaryDirectory(label ?? "git");
  const path = directory.join("repo");
  const home = directory.join("home");
  await mkdir(path, { recursive: true });
  await mkdir(home, { recursive: true });

  // `PATH` is passed through rather than minimised so git finds its own helpers,
  // and so a `gitRunner()` under test resolves the same binary the fixture used.
  // Everything else is pinned so the suite does not read the developer's config.
  const environment: Record<string, string> = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Janela Test",
    GIT_AUTHOR_EMAIL: "test@janela.invalid",
    GIT_COMMITTER_NAME: "Janela Test",
    GIT_COMMITTER_EMAIL: "test@janela.invalid",
    LANG: "C",
  };

  const git = async (...args: string[]): Promise<string> => {
    const child = Bun.spawn([GIT, ...args], {
      cwd: path,
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [standardOutput, standardError, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) {
      throw new Error(`git ${args[0] ?? ""} exited ${code}: ${standardError.trimEnd()}`);
    }
    return standardOutput;
  };

  const commit = async (file: string, contents: string, message?: string): Promise<void> => {
    await mkdir(dirname(join(path, file)), { recursive: true });
    await writeFile(join(path, file), contents, "utf8");
    await git("add", "--", file);
    await git("commit", "-q", "-m", message ?? `add ${file}`);
  };

  await git("init", "-q", "-b", "main");
  await git("config", "commit.gpgsign", "false");
  await git("config", "user.name", "Janela Test");
  await git("config", "user.email", "test@janela.invalid");
  await commit("README.md", "# fixture\n", "initial");

  return {
    path,
    git,
    commit,
    async [Symbol.asyncDispose](): Promise<void> {
      await directory[Symbol.asyncDispose]();
    },
  };
}

/** A log sink that records, for asserting that we log shapes and not content. */
export interface RecordingLogSink {
  readonly records: readonly { readonly message: string; readonly fields?: unknown }[];
  install(): void;
  reset(): void;
}

export function recordingLogSink(): RecordingLogSink {
  throw new Error(`not implemented: recordingLogSink`);
}

/**
 * A recording `ProcessRunning`, for the things we *do* fake.
 *
 * Note it is typed structurally rather than by importing `@janela/support/process`:
 * that subpath is daemon-only, and this package is linked by both sides.
 */
export interface FakeProcessRunner {
  /** Every invocation, in order, so a test can assert the argv it expected. */
  readonly invocations: readonly {
    readonly executable: string;
    readonly arguments: readonly string[];
  }[];
  /** Queues a response for the next matching invocation. */
  stub(match: string, outcome: { stdout?: string; stderr?: string; exitCode?: number }): void;
}

export function fakeProcessRunner(): FakeProcessRunner {
  throw new Error(`not implemented: fakeProcessRunner`);
}
