import { describe, expect, test } from "bun:test";
import { closeSync, existsSync, fsyncSync, openSync, statfsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import type { AbsolutePath } from "@janela/core";
import type { Logger, LogLevel, LogRecord } from "@janela/support";
import { processRunner } from "@janela/support/process";
import { gitFixture, temporaryDirectory } from "@janela/test-support";

import { gitRunner } from "./git-runner.ts";
import {
  worktreeIncluding,
  type OversizedInclude,
  type WorktreeIncludeOptions,
  type WorktreeIncluding,
} from "./worktree-include.ts";

interface Recorded {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields?: LogRecord["fields"];
}

/**
 * A `Logger` that keeps what it was told.
 *
 * Built here rather than taken from `@janela/test-support`: `recordingLogSink`
 * there is an unimplemented seam belonging to another issue, and `log()` in
 * `@janela/support` is too — which is also why this module takes its logger as a
 * parameter.
 */
function recordingLogger(): Logger & { readonly records: readonly Recorded[] } {
  const records: Recorded[] = [];
  const at =
    (level: LogLevel) =>
    (message: string, fields?: LogRecord["fields"]): void => {
      records.push(fields === undefined ? { level, message } : { level, message, fields });
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

/** The fixture every test here works against. */
interface IncludeWorld extends AsyncDisposable {
  readonly repository: AbsolutePath;
  readonly include: WorktreeIncluding;
  readonly git: (...args: string[]) => Promise<string>;
  readonly commit: (file: string, contents: string, message?: string) => Promise<void>;
  /** A path inside the repository. */
  readonly inRepository: (...components: string[]) => string;
  /** A path in the scratch area, beside the repository's temporary root. */
  readonly scratch: (...components: string[]) => AbsolutePath;
  /** Writes an untracked file, creating parents. */
  readonly write: (relative: string, contents: string | Buffer) => Promise<void>;
  /** A worktree created by git, which is where a copy really goes. */
  readonly worktree: (name: string) => Promise<AbsolutePath>;
}

/**
 * A real repository, a real `.worktreeinclude`, and the real service over the
 * real git.
 *
 * Git is not faked, and neither is the filesystem: `.worktreeinclude` is tested
 * by creating a worktree and looking at what landed in it (docs/testing.md).
 */
async function setup(label: string, options?: WorktreeIncludeOptions): Promise<IncludeWorld> {
  const fixture = await gitFixture(label);
  const scratch = await temporaryDirectory(`${label}-scratch`);

  const write = async (relative: string, contents: string | Buffer): Promise<void> => {
    const target = join(fixture.path, relative);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, contents);
  };

  return {
    repository: fixture.path as AbsolutePath,
    include: worktreeIncluding(gitRunner(), options),
    git: fixture.git,
    commit: fixture.commit,
    inRepository: (...components: string[]) => join(fixture.path, ...components),
    scratch: (...components: string[]) => scratch.join(...components) as AbsolutePath,
    write,
    worktree: async (name: string): Promise<AbsolutePath> => {
      const path = scratch.join(name);
      await fixture.git("worktree", "add", path, "-b", name);
      return path as AbsolutePath;
    },
    async [Symbol.asyncDispose](): Promise<void> {
      await scratch[Symbol.asyncDispose]();
      await fixture[Symbol.asyncDispose]();
    },
  };
}

/**
 * The canonical shape: an `.env` and a `node_modules` that are ignored and
 * listed, plus ignored-but-unlisted and untracked-but-unlisted files that must
 * not come along.
 */
async function seed(world: IncludeWorld): Promise<void> {
  await world.commit(".gitignore", ".env\nnode_modules/\n.venv/\n");
  await world.write(".env", "SECRET=1\n");
  await world.write("node_modules/pkg/index.js", "module.exports = 1;\n");
  await world.write("junk.log", "noise\n");
  await world.write(".venv/cfg", "unlisted\n");
  await world.write(".worktreeinclude", ".env\nnode_modules/\n");
}

/**
 * A 4 MiB HFS+ volume on a ram disk, so a copy across it is genuinely
 * cross-device. No sudo needed, and no skip if it fails: `usedFallbackCopy` is
 * unprovable without a filesystem that cannot clone.
 */
async function crossDeviceVolume(): Promise<AsyncDisposable & { readonly path: string }> {
  const processes = processRunner();
  const environment = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  const name = `janela-exdev-${Math.random().toString(36).slice(2, 10)}`;

  const attached = await processes.run({
    executable: "/usr/bin/hdiutil",
    arguments: ["attach", "-nomount", "ram://8192"],
    workingDirectory: "/",
    environment,
    timeoutMs: 30_000,
  });
  if (!attached.succeeded) {
    throw new Error(
      `hdiutil attach failed (${attached.exitCode}): ${attached.standardError.trim()}`,
    );
  }
  const device = attached.standardOutput.trim();

  const detach = async (): Promise<void> => {
    for (const extra of [[], ["-force"]]) {
      // A detach can race the filesystem still flushing; the retry is what keeps
      // a failed assertion from leaving a volume mounted on the machine.
      // oxlint-disable-next-line no-await-in-loop
      const outcome = await processes.run({
        executable: "/usr/bin/hdiutil",
        arguments: ["detach", ...extra, device],
        workingDirectory: "/",
        environment,
        timeoutMs: 30_000,
      });
      if (outcome.succeeded) return;
    }
  };

  try {
    const erased = await processes.run({
      executable: "/usr/sbin/diskutil",
      arguments: ["erasevolume", "HFS+", name, device],
      workingDirectory: "/",
      environment,
      timeoutMs: 60_000,
    });
    if (!erased.succeeded) {
      throw new Error(
        `diskutil erasevolume failed (${erased.exitCode}): ${erased.standardError.trim()}`,
      );
    }
  } catch (error) {
    await detach();
    throw error;
  }

  return {
    path: join("/Volumes", name),
    async [Symbol.asyncDispose](): Promise<void> {
      await detach();
    },
  };
}

describe("worktreeinclude resolution", () => {
  test("matches exactly what git matches", async () => {
    await using world = await setup("wi-resolve");
    await seed(world);

    const resolved = await world.include.resolve(world.repository);

    // The trailing slash is git's, and it is kept: that string is what lands in
    // `WorktreeBinding.includedPaths` and what the removal dialog shows.
    expect([...resolved]).toEqual([".env", "node_modules/"]);
  });

  test("honours a negation, because git owns the matching", async () => {
    await using world = await setup("wi-negation");
    await world.write("dev.env", "dev\n");
    await world.write("prod.env", "prod\n");
    await world.write(".worktreeinclude", "*.env\n!prod.env\n");

    const resolved = await world.include.resolve(world.repository);

    expect([...resolved]).toEqual(["dev.env"]);
  });

  test("a missing .worktreeinclude is empty, not an error", async () => {
    await using world = await setup("wi-absent");
    await world.write(".env", "SECRET=1\n");

    expect([...(await world.include.resolve(world.repository))]).toEqual([]);
  });

  test("a newline in a filename survives", async () => {
    await using world = await setup("wi-newline");
    await world.write("weird\nname.env", "odd\n");
    await world.write(".worktreeinclude", "*.env\n");

    const resolved = await world.include.resolve(world.repository);

    expect([...resolved]).toEqual(["weird\nname.env"]);
  });
});

describe("worktreeinclude copying", () => {
  test("lands clones in a real worktree", async () => {
    await using world = await setup("wi-copy");
    await seed(world);
    const worktree = await world.worktree("feature");

    const paths = await world.include.resolve(world.repository);
    const report = await world.include.copy({ repository: world.repository, worktree, paths });

    expect(await readFile(join(worktree, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(await readFile(join(worktree, "node_modules/pkg/index.js"), "utf8")).toBe(
      "module.exports = 1;\n",
    );
    // A clone is a second file, not a second name for the first one.
    const source = await stat(world.inRepository(".env"));
    const destination = await stat(join(worktree, ".env"));
    expect(destination.ino).not.toBe(source.ino);
    expect(report.usedFallbackCopy).toBe(false);
    expect([...report.copied]).toEqual([".env", "node_modules/"]);
    expect(report.totalBytes).toBe(
      source.size + (await stat(world.inRepository("node_modules/pkg/index.js"))).size,
    );
  });

  test("a clone consumes no disk", async () => {
    await using world = await setup("wi-clone-cost");
    const bytes = 128 * 1024 * 1024;
    await world.write("big.bin", Buffer.alloc(bytes, 7));
    await world.write(".worktreeinclude", "big.bin\n");
    const worktree = await world.worktree("cost");

    // Flush the source before measuring, or APFS's delayed allocation lands the
    // 128 MB inside the measurement window and the copy gets blamed for it.
    const handle = openSync(world.inRepository("big.bin"), "r");
    fsyncSync(handle);
    closeSync(handle);

    const before = statfsSync(worktree);
    const report = await world.include.copy({
      repository: world.repository,
      worktree,
      paths: await world.include.resolve(world.repository),
    });
    const after = statfsSync(worktree);

    expect([...report.copied]).toEqual(["big.bin"]);
    expect(report.totalBytes).toBe(bytes);
    expect(report.usedFallbackCopy).toBe(false);
    expect(await stat(join(worktree, "big.bin"))).toMatchObject({ size: bytes });
    const consumed = (before.bavail - after.bavail) * before.bsize;
    // A byte copy would consume ~128 MiB. The slack is for background churn on
    // the volume, not for the copy.
    expect(consumed).toBeLessThan(16 * 1024 * 1024);
  });

  // Attaching a volume queues behind whoever else is doing I/O, and under a full
  // `bun run check` that is a 71 MB sidecar copy. 45 s matches packages/pty's slow
  // tests (#50).
  test("a cross-device copy falls back, says so, and still delivers the bytes", async () => {
    const log = recordingLogger();
    await using world = await setup("wi-exdev", { log });
    await world.write(".env", "SECRET=1\n");
    await world.write(".worktreeinclude", "*.env\n");
    await chmod(world.inRepository(".env"), 0o754);

    await using volume = await crossDeviceVolume();
    const worktree = join(volume.path, "feature") as AbsolutePath;
    await mkdir(worktree, { recursive: true });

    const report = await world.include.copy({
      repository: world.repository,
      worktree,
      paths: await world.include.resolve(world.repository),
    });

    expect(report.usedFallbackCopy).toBe(true);
    expect([...report.copied]).toEqual([".env"]);
    expect(await readFile(join(worktree, ".env"), "utf8")).toBe("SECRET=1\n");
    expect((await stat(join(worktree, ".env"))).mode & 0o777).toBe(0o754);
    const notices = log.records.filter((entry) => entry.level === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.fields).toMatchObject({ reason: "EXDEV" });
  }, 45_000);

  test("symlinks are recreated, never followed", async () => {
    await using world = await setup("wi-symlink");
    await world.write(".worktreeinclude", "*.env\n");
    await symlink("/etc/hosts", world.inRepository("link.env"));
    const worktree = await world.worktree("links");

    const report = await world.include.copy({
      repository: world.repository,
      worktree,
      paths: await world.include.resolve(world.repository),
    });

    expect([...report.copied]).toEqual(["link.env"]);
    const landed = await lstat(join(worktree, "link.env"));
    expect(landed.isSymbolicLink()).toBe(true);
    expect(landed.isFile()).toBe(false);
    expect(await readlink(join(worktree, "link.env"))).toBe("/etc/hosts");
  });

  test(".git is never copied, at any depth or by request", async () => {
    await using world = await setup("wi-dotgit");
    await seed(world);
    await world.write("node_modules/pkg/.git/config", "[core]\n");
    const worktree = await world.worktree("nested");

    const report = await world.include.copy({
      repository: world.repository,
      worktree,
      paths: await world.include.resolve(world.repository),
    });

    expect([...report.copied]).toEqual([".env", "node_modules/"]);
    expect(await readdir(join(worktree, "node_modules/pkg"))).toEqual(["index.js"]);

    const refused = await world.include.copy({
      repository: world.repository,
      worktree,
      paths: [".git/"],
    });
    expect([...refused.copied]).toEqual([]);
    expect(refused.skipped ?? 0).toBeGreaterThanOrEqual(1);
  });

  test("an unreadable file is skipped and its siblings arrive", async () => {
    await using world = await setup("wi-unreadable");
    await seed(world);
    await world.write("node_modules/pkg/secret.js", "hidden\n");
    const unreadable = world.inRepository("node_modules/pkg/secret.js");
    await chmod(unreadable, 0o000);
    try {
      const worktree = await world.worktree("partial");

      const report = await world.include.copy({
        repository: world.repository,
        worktree,
        paths: await world.include.resolve(world.repository),
      });

      expect(await readFile(join(worktree, "node_modules/pkg/index.js"), "utf8")).toBe(
        "module.exports = 1;\n",
      );
      expect(report.skipped ?? 0).toBeGreaterThanOrEqual(1);
      // The directory still arrived, so the removal dialog must still name it.
      expect([...report.copied]).toEqual([".env", "node_modules/"]);
    } finally {
      await chmod(unreadable, 0o644);
    }
  });

  test("an escaping path is refused and nothing is written outside", async () => {
    await using world = await setup("wi-escape");
    const worktree = await world.worktree("guarded");
    await writeFile(world.inRepository("..", "escape.txt"), "outside\n");

    const report = await world.include.copy({
      repository: world.repository,
      worktree,
      paths: ["../escape.txt", "/etc/hosts"],
    });

    expect([...report.copied]).toEqual([]);
    expect(report.skipped).toBe(2);
    expect(report.totalBytes).toBe(0);
    // Nothing new in the worktree, and neither would-be destination exists: the
    // escape was refused, not merely relocated.
    expect((await readdir(worktree)).toSorted()).toEqual([".git", "README.md"]);
    expect(existsSync(join(worktree, "..", "escape.txt"))).toBe(false);
    expect(existsSync(join(worktree, "etc"))).toBe(false);
  });
});

describe("the worktreeinclude size cap", () => {
  test("an oversized include is skipped, asked about once, and never blocks", async () => {
    const asked: OversizedInclude[] = [];
    await using world = await setup("wi-cap", {
      capBytes: 1,
      onOversized: (details) => asked.push(details),
    });
    await seed(world);
    const worktree = world.scratch("over-cap");
    await mkdir(worktree, { recursive: true });

    // Resolving before copying, then awaiting the copy: it returns without the
    // question having been answered, which is the non-blocking property.
    const paths = await world.include.resolve(world.repository);
    const report = await world.include.copy({ repository: world.repository, worktree, paths });

    expect([...report.copied]).toEqual([]);
    expect(report.totalBytes).toBe(0);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.capBytes).toBe(1);
    expect(asked[0]?.firstOffendingPath).toBe(".env");
    const real =
      (await stat(world.inRepository(".env"))).size +
      (await stat(world.inRepository("node_modules/pkg/index.js"))).size;
    expect(asked[0]?.totalBytes).toBe(real);
    expect(report.oversized).toEqual({ totalBytes: real, capBytes: 1, firstOffendingPath: ".env" });
    expect(await readdir(worktree)).toEqual([]);
  });

  test("with nobody to ask, the outcome is the same", async () => {
    const log = recordingLogger();
    await using world = await setup("wi-cap-silent", { capBytes: 1, log });
    await seed(world);
    const worktree = world.scratch("no-client");
    await mkdir(worktree, { recursive: true });

    const report = await world.include.copy({
      repository: world.repository,
      worktree,
      paths: await world.include.resolve(world.repository),
    });

    expect([...report.copied]).toEqual([]);
    expect(report.oversized?.capBytes).toBe(1);
    expect(await readdir(worktree)).toEqual([]);
    const notice = log.records.find((entry) => entry.level === "notice");
    expect(notice?.message).toBe("worktreeinclude over size cap, copy skipped");
    expect(notice?.fields).toMatchObject({ capBytes: 1, entries: 2 });
  });
});

describe("worktreeinclude logging", () => {
  test("logs counts, sizes and errnos, never a path", async () => {
    const log = recordingLogger();
    await using world = await setup("wi-log", { log });
    await seed(world);
    const worktree = await world.worktree("logged");
    const paths = await world.include.resolve(world.repository);

    await world.include.copy({ repository: world.repository, worktree, paths });

    // The same module, over a cap and over a device boundary: all three paths log.
    const capped = worktreeIncluding(gitRunner(), { capBytes: 1, log });
    await capped.copy({ repository: world.repository, worktree: world.scratch("capped"), paths });

    await using volume = await crossDeviceVolume();
    const elsewhere = join(volume.path, "logged") as AbsolutePath;
    await mkdir(elsewhere, { recursive: true });
    await worktreeIncluding(gitRunner(), { log }).copy({
      repository: world.repository,
      worktree: elsewhere,
      paths,
    });

    expect(log.records.length).toBeGreaterThanOrEqual(3);
    for (const record of log.records) {
      const rendered = `${record.message} ${JSON.stringify(record.fields ?? {})}`;
      expect(rendered).not.toContain(world.repository);
      expect(rendered).not.toContain(worktree);
      expect(rendered).not.toContain(".env");
      expect(rendered).not.toContain("node_modules");
    }
  }, 45_000);
});
