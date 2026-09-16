import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface TemporaryDirectory extends AsyncDisposable {
  readonly path: string;
  join(...components: string[]): string;
}

export interface GitFixture extends AsyncDisposable {
  readonly path: string;
  git(...args: string[]): Promise<string>;
  commit(file: string, contents: string, message?: string): Promise<void>;
}

interface GitEnvironment extends Record<string, string> {
  readonly PATH: string;
  readonly HOME: string;
  readonly GIT_CONFIG_GLOBAL: string;
  readonly GIT_CONFIG_SYSTEM: string;
  readonly GIT_CONFIG_NOSYSTEM: string;
  readonly GIT_TERMINAL_PROMPT: string;
  readonly GIT_AUTHOR_NAME: string;
  readonly GIT_AUTHOR_EMAIL: string;
  readonly GIT_COMMITTER_NAME: string;
  readonly GIT_COMMITTER_EMAIL: string;
  readonly LANG: string;
}

const GIT = Bun.which("git") ?? "/usr/bin/git";

export async function temporaryDirectory(label = "test"): Promise<TemporaryDirectory> {
  const created = await mkdtemp(join(tmpdir(), `janela-${label}-`));
  const path = await realpath(created);

  return {
    path,
    join: (...components: string[]) => join(path, ...components),
    async [Symbol.asyncDispose](): Promise<void> {
      await rm(path, { recursive: true, force: true });
    },
  };
}

export async function gitFixture(label = "git"): Promise<GitFixture> {
  const directory = await temporaryDirectory(label);
  const path = directory.join("repo");
  const home = directory.join("home");
  await mkdir(path, { recursive: true });
  await mkdir(home, { recursive: true });

  const environment: GitEnvironment = {
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

  const commit = async (file: string, contents: string, message = ""): Promise<void> => {
    await mkdir(dirname(join(path, file)), { recursive: true });
    await writeFile(join(path, file), contents, "utf8");
    await git("add", "--", file);
    await git("commit", "-q", "-m", message === "" ? `add ${file}` : message);
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
