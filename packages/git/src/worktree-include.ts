import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readlink, stat, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import type { AbsolutePath } from "@janela/core";
import type { Logger } from "@janela/support";

import type { GitRunning } from "./git-runner.ts";

/**
 * `.worktreeinclude` — the repo-declared list of ignored files to carry into a
 * new worktree: `.env`, `node_modules`, build caches.
 *
 * Two decisions are load-bearing here, and both are about not writing code we
 * would get wrong:
 *
 * 1. **git matches the patterns.** The honest implementation of "which ignored
 *    files match these patterns" is `git ls-files -o -i --exclude-from`, not a
 *    gitignore matcher we wrote. Ours would disagree with git's the first time
 *    someone used a negation.
 * 2. **`clonefile` moves the bytes.** On APFS a clone is metadata-only, which is
 *    what makes copying a 500 MB `node_modules` cost milliseconds instead of
 *    seconds. A non-APFS fallback is allowed to be slow; it is not allowed to be
 *    silent, because a silent fallback is how the budget in docs/performance.md
 *    stops being met without anyone noticing.
 */
export interface WorktreeIncluding {
  /**
   * Resolves the patterns in `<repository>/.worktreeinclude` to actual paths,
   * relative to the repository root.
   *
   * Returns empty when the file does not exist, which is the common case and not
   * an error.
   */
  resolve(repository: AbsolutePath): Promise<readonly string[]>;

  /**
   * Copies the resolved paths into a freshly created worktree.
   *
   * Runs *before* any automation, because scripts depend on their `.env` already
   * being present — the ordering is fixed and documented in
   * docs/domain-model.md § AutomationCommand.
   *
   * @returns The paths actually copied, which is what
   *   `WorktreeBinding.includedPaths` records so the removal dialog can name them
   *   later.
   */
  copy(request: {
    readonly repository: AbsolutePath;
    readonly worktree: AbsolutePath;
    readonly paths: readonly string[];
  }): Promise<CopyReport>;
}

export interface CopyReport {
  readonly copied: readonly string[];
  /** Bytes of regular files actually copied. Zero when the copy was skipped for being oversized. */
  readonly totalBytes: number;
  /**
   * True when the filesystem did not support cloning and we fell back to a
   * byte-for-byte copy. Logged, and worth surfacing if it ever becomes common.
   */
  readonly usedFallbackCopy: boolean;
  /**
   * Present when the whole copy was skipped for exceeding the size cap; `copied`
   * is then empty. Optional because a caller that predates the cap still builds
   * a valid report without it.
   */
  readonly oversized?: OversizedInclude;
  /**
   * How many entries or nested files were passed over: unreadable, vanished
   * between the measure pass and the copy pass, or refused by the path guard.
   */
  readonly skipped?: number;
}

/**
 * 2 GiB. Past this nothing is copied unless the user opts in — a worktree is
 * meant to be cheap, and silently duplicating half a disk is not.
 */
export const DEFAULT_INCLUDE_CAP_BYTES = 2 * 1024 * 1024 * 1024;

/** What the user is shown when an include is over the cap. */
export interface OversizedInclude {
  /** The real measured total, in bytes. Shown to the user; logged as a number, never with a path. */
  readonly totalBytes: number;
  readonly capBytes: number;
  /** The resolved entry whose measurement first pushed the running total past the cap. */
  readonly firstOffendingPath: string;
}

export interface WorktreeIncludeOptions {
  /** Defaults to `DEFAULT_INCLUDE_CAP_BYTES`. Tests inject a small one. */
  readonly capBytes?: number;
  /**
   * Called exactly once, fire-and-forget, when a copy is skipped for being over
   * the cap. Never awaited: session creation must not block on a person, and by
   * the time this runs the session already exists and works without its
   * includes. The composition root wires this to a daemon→client notification;
   * with no client attached — or nothing wired — the outcome is identical: the
   * copy stays skipped, and the skip is on the report and in the log.
   */
  readonly onOversized?: (details: OversizedInclude) => void;
  /** Defaults to a silent logger, for the same reason `nullLogSink` is the default sink. */
  readonly log?: Logger;
}

/**
 * Discarded by default: a library that logs during import must not decide the
 * format for a process that has not asked for one.
 */
const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  notice: () => {},
  warning: () => {},
  error: () => {},
};

/**
 * The errnos that mean "this filesystem cannot clone", as opposed to "this file
 * could not be copied". `EXDEV` is the cross-volume case, `EINVAL` what a special
 * file answers; both measured on macOS. Seeing one of these flips the whole copy
 * to plain byte copies, so a 40 000-file `node_modules` on a clone-incapable
 * volume pays one failed syscall rather than 40 000.
 */
const CLONE_UNAVAILABLE_CODES: Record<string, true> = {
  EXDEV: true,
  ENOTSUP: true,
  EOPNOTSUPP: true,
  EINVAL: true,
  ENOSYS: true,
};

/** Four call sites, all of which must agree on what an errno-less throw is called. */
function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "unknown";
}

/**
 * Recreates a link rather than following it — including one pointing outside the
 * repository, which is the user's arrangement and not ours to flatten into a
 * copy of whatever it happens to reference.
 *
 * @returns False when nothing landed, which the caller counts as skipped.
 */
async function copyOneSymlink(source: string, destination: string): Promise<boolean> {
  try {
    const target = await readlink(source);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(target, destination);
    return true;
  } catch {
    return false;
  }
}

interface Measurement {
  readonly bytes: number;
  readonly skipped: number;
}

/**
 * Total size of one entry, without building a file list.
 *
 * The bound this satisfies (AGENTS.md § no unbounded buffers): the only thing
 * that grows is `stack`, which holds directory paths and is bounded by the tree's
 * depth times its per-level directory fan-out — never one entry per file. A
 * `node_modules` with 40 000 files costs two numbers and a few hundred strings.
 */
async function measure(absolute: string): Promise<Measurement & { readonly missing: boolean }> {
  let info;
  try {
    info = await lstat(absolute);
  } catch {
    return { bytes: 0, skipped: 1, missing: true };
  }

  // A symlink is recreated, not followed, so it contributes no bytes.
  if (info.isSymbolicLink()) return { bytes: 0, skipped: 0, missing: false };
  if (info.isFile()) return { bytes: info.size, skipped: 0, missing: false };
  if (!info.isDirectory()) return { bytes: 0, skipped: 0, missing: false };

  let bytes = 0;
  let skipped = 0;
  const stack: string[] = [absolute];
  while (stack.length > 0) {
    const directory = stack.pop();
    if (directory === undefined) break;
    let entries;
    try {
      // oxlint-disable-next-line no-await-in-loop
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      skipped += 1;
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const child = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(child);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        // oxlint-disable-next-line no-await-in-loop
        const child_info = await lstat(child);
        bytes += child_info.size;
      } catch {
        skipped += 1;
      }
    }
  }
  return { bytes, skipped, missing: false };
}

export function worktreeIncluding(
  git: GitRunning,
  options?: WorktreeIncludeOptions,
): WorktreeIncluding {
  const capBytes = options?.capBytes ?? DEFAULT_INCLUDE_CAP_BYTES;
  const logger = options?.log ?? silentLogger;

  return {
    async resolve(repository: AbsolutePath): Promise<readonly string[]> {
      const excludeFile = join(repository, ".worktreeinclude");
      try {
        const info = await stat(excludeFile);
        if (!info.isFile()) return [];
      } catch {
        // Missing is the common case, and handing git a nonexistent
        // `--exclude-from` is a fatal exit 128 rather than an empty answer.
        return [];
      }

      // git owns the matching. Ours would disagree with it the first time
      // someone wrote a negation. `-z` because a filename may contain a newline,
      // `--directory` so a wholly-ignored directory collapses to one entry, and
      // an absolute `--exclude-from` so nothing depends on the child's cwd.
      const output = await git.run(
        ["ls-files", "-o", "-i", `--exclude-from=${excludeFile}`, "-z", "--directory"],
        repository,
      );
      return output.split("\0").filter((entry) => entry !== "");
    },

    async copy(request: {
      readonly repository: AbsolutePath;
      readonly worktree: AbsolutePath;
      readonly paths: readonly string[];
    }): Promise<CopyReport> {
      const { repository, worktree } = request;
      let skipped = 0;

      // git's own output is relative, inside the repository, and never `.git`,
      // but `copy` is a public seam: a caller handing us `../..` is refused
      // rather than trusted.
      const accepted: string[] = [];
      for (const path of request.paths) {
        const trimmed = path.replace(/\/+$/, "");
        const acceptable =
          trimmed !== "" &&
          !isAbsolute(trimmed) &&
          trimmed
            .split("/")
            .every((segment) => segment !== "" && segment !== ".." && segment !== ".git");
        if (acceptable) {
          accepted.push(path);
          continue;
        }
        skipped += 1;
        logger.debug("worktreeinclude entry skipped", { reason: "refused" });
      }
      if (accepted.length === 0) {
        return { copied: [], totalBytes: 0, usedFallbackCopy: false, skipped };
      }

      // Measure everything before moving a byte: the cap is a precondition of the
      // copy, not something to notice halfway through it.
      let measured = 0;
      let firstOffendingPath: string | undefined;
      const present: string[] = [];
      for (const entry of accepted) {
        // oxlint-disable-next-line no-await-in-loop
        const measurement = await measure(join(repository, entry.replace(/\/+$/, "")));
        skipped += measurement.skipped;
        if (measurement.missing) continue;
        present.push(entry);
        measured += measurement.bytes;
        if (firstOffendingPath === undefined && measured > capBytes) firstOffendingPath = entry;
      }

      if (firstOffendingPath !== undefined) {
        const oversized: OversizedInclude = { totalBytes: measured, capBytes, firstOffendingPath };
        // Counts and sizes only — the paths are the user's business, not the log's.
        logger.notice("worktreeinclude over size cap, copy skipped", {
          totalBytes: measured,
          capBytes,
          entries: present.length,
        });
        // Deliberately not awaited, and there is nothing to await: the ask is
        // one-way today. Nothing is copied — a partial under-cap subset would be
        // a selection policy the user never expressed.
        options?.onOversized?.(oversized);
        return { copied: [], totalBytes: 0, usedFallbackCopy: false, skipped, oversized };
      }

      let cloneUnavailable = false;
      let usedFallbackCopy = false;
      let copiedBytes = 0;

      const copyOneFile = async (
        source: string,
        destination: string,
        size: number,
      ): Promise<boolean> => {
        if (!cloneUnavailable) {
          try {
            // FORCE, so a filesystem that cannot clone says so instead of quietly
            // moving bytes. That refusal is the only reason `usedFallbackCopy` can
            // be honest.
            await copyFile(source, destination, constants.COPYFILE_FICLONE_FORCE);
            copiedBytes += size;
            return true;
          } catch (error) {
            const code = errorCode(error);
            if (CLONE_UNAVAILABLE_CODES[code] !== true) {
              logger.debug("worktreeinclude entry skipped", { reason: code });
              return false;
            }
            cloneUnavailable = true;
            usedFallbackCopy = true;
            // Once per copy, and never silent: a fallback nobody notices is how
            // the budget in docs/performance.md stops being met.
            logger.notice("worktreeinclude clone unavailable, using byte copy", { reason: code });
          }
        }
        try {
          await copyFile(source, destination);
          copiedBytes += size;
          return true;
        } catch (error) {
          logger.debug("worktreeinclude entry skipped", { reason: errorCode(error) });
          return false;
        }
      };

      /** Same bound as `measure`: a stack of directories, never a list of files. */
      const copyTree = async (source: string, destination: string): Promise<boolean> => {
        try {
          await mkdir(destination, { recursive: true });
        } catch {
          return false;
        }
        const stack: { readonly source: string; readonly destination: string }[] = [
          { source, destination },
        ];
        while (stack.length > 0) {
          const current = stack.pop();
          if (current === undefined) break;
          let entries;
          try {
            // oxlint-disable-next-line no-await-in-loop
            entries = await readdir(current.source, { withFileTypes: true });
          } catch {
            skipped += 1;
            continue;
          }
          for (const entry of entries) {
            // Never a `.git`, at any depth, whatever the patterns matched: a
            // nested repository copied wholesale is a second checkout the user
            // did not ask for.
            if (entry.name === ".git") continue;
            const childSource = join(current.source, entry.name);
            const childDestination = join(current.destination, entry.name);
            if (entry.isSymbolicLink()) {
              // oxlint-disable-next-line no-await-in-loop
              if (!(await copyOneSymlink(childSource, childDestination))) skipped += 1;
              continue;
            }
            if (entry.isDirectory()) {
              try {
                // oxlint-disable-next-line no-await-in-loop
                await mkdir(childDestination, { recursive: true });
                stack.push({ source: childSource, destination: childDestination });
              } catch {
                skipped += 1;
              }
              continue;
            }
            if (!entry.isFile()) {
              skipped += 1;
              continue;
            }
            let info;
            try {
              // oxlint-disable-next-line no-await-in-loop
              info = await lstat(childSource);
            } catch {
              skipped += 1;
              continue;
            }
            // oxlint-disable-next-line no-await-in-loop
            if (!(await copyOneFile(childSource, childDestination, info.size))) skipped += 1;
          }
        }
        return true;
      };

      const copied: string[] = [];
      for (const entry of present) {
        const relative = entry.replace(/\/+$/, "");
        const source = join(repository, relative);
        const destination = join(worktree, relative);
        let info;
        try {
          // oxlint-disable-next-line no-await-in-loop
          info = await lstat(source);
        } catch {
          skipped += 1;
          continue;
        }

        let landed: boolean;
        if (info.isSymbolicLink()) {
          // oxlint-disable-next-line no-await-in-loop
          landed = await copyOneSymlink(source, destination);
        } else if (info.isDirectory()) {
          // oxlint-disable-next-line no-await-in-loop
          landed = await copyTree(source, destination);
        } else if (info.isFile()) {
          try {
            // oxlint-disable-next-line no-await-in-loop
            await mkdir(dirname(destination), { recursive: true });
            // oxlint-disable-next-line no-await-in-loop
            landed = await copyOneFile(source, destination, info.size);
          } catch {
            landed = false;
          }
        } else {
          landed = false;
        }

        // A directory that arrived minus three unreadable files still has to be
        // named by the removal dialog, so it counts as copied.
        if (landed) copied.push(entry);
        else skipped += 1;
      }

      logger.info("worktreeinclude copy finished", {
        entries: copied.length,
        bytes: copiedBytes,
        skipped,
        usedFallbackCopy,
      });
      return { copied, totalBytes: copiedBytes, usedFallbackCopy, skipped };
    },
  };
}
