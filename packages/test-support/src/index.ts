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

/** A directory that deletes itself when disposed. */
export interface TemporaryDirectory extends AsyncDisposable {
  readonly path: string;
  join(...components: string[]): string;
}

export function temporaryDirectory(label?: string): Promise<TemporaryDirectory> {
  void label;
  throw new Error(`not implemented: temporaryDirectory`);
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

export function gitFixture(label?: string): Promise<GitFixture> {
  void label;
  throw new Error(`not implemented: gitFixture`);
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
