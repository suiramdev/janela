import { constants, type Dirent, type Stats } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readlink, stat, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import type { AbsolutePath } from "@janela/core";
import type { Logger } from "@janela/support";
import { Effect, Option, Predicate, Result, Schema } from "effect";

import {
  CloneUnavailable,
  EntryUnreadable,
  GitError,
  gitErrorLabel,
  type GitRunning,
} from "./git-runner.ts";

export interface WorktreeIncluding {
  resolve(repository: AbsolutePath): Promise<readonly string[]>;

  copy(request: IncludeCopyRequest): Promise<CopyReport>;
}

export interface IncludeCopyRequest {
  readonly repository: AbsolutePath;
  readonly worktree: AbsolutePath;
  readonly paths: readonly string[];
}

export interface CopyReport {
  readonly copied: readonly string[];
  readonly totalBytes: number;
  readonly usedFallbackCopy: boolean;
  readonly oversized?: OversizedInclude;
  readonly skipped?: number;
}

export interface OversizedInclude {
  readonly totalBytes: number;
  readonly capBytes: number;
  readonly firstOffendingPath: string;
}

export interface WorktreeIncludeOptions {
  readonly capBytes?: number;
  readonly onOversized?: (details: OversizedInclude) => void;
  readonly log?: Logger;
}

interface Measurement {
  readonly bytes: number;
  readonly skipped: number;
  readonly missing: boolean;
}

export const DEFAULT_INCLUDE_CAP_BYTES = 2 * 1024 * 1024 * 1024;

const INCLUDE_FILE_NAME = ".worktreeinclude";

const NESTED_REPOSITORY = ".git";

const ENTRY_SEPARATOR = "\0";

const TRAILING_SLASHES = /\/+$/;

const UNKNOWN_ERRNO = "unknown";

const CLONE_UNAVAILABLE_CODES = new Set(["EXDEV", "ENOTSUP", "EOPNOTSUPP", "EINVAL", "ENOSYS"]);

const ABSENT_CODES = new Set(["ENOENT", "ENOTDIR"]);

const NOTHING_MEASURED: Measurement = { bytes: 0, skipped: 0, missing: false };

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  notice: () => {},
  warning: () => {},
  error: () => {},
};

const decodeErrno = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }));

const decodeIncludePath = Schema.decodeUnknownOption(
  Schema.String.check(
    Schema.makeFilter<string>((entry) => {
      const trimmed = entry.replace(TRAILING_SLASHES, "");

      return (
        trimmed !== "" &&
        !isAbsolute(trimmed) &&
        trimmed
          .split("/")
          .every((segment) => segment !== "" && segment !== ".." && segment !== NESTED_REPOSITORY)
      );
    }),
  ),
);

function errnoOf(cause: unknown): string {
  return Option.match(decodeErrno(cause), {
    onNone: () => UNKNOWN_ERRNO,
    onSome: (errno) => errno.code,
  });
}

function entryFailure(cause: unknown): GitError {
  return new GitError({ reason: new EntryUnreadable({ code: errnoOf(cause) }) });
}

function cloneFailure(cause: unknown): GitError {
  const code = errnoOf(cause);

  return new GitError({
    reason: CLONE_UNAVAILABLE_CODES.has(code)
      ? new CloneUnavailable({ code })
      : new EntryUnreadable({ code }),
  });
}

function failureCode(error: GitError): string {
  const reason = error.reason;

  if (Predicate.isTagged(reason, "cloneUnavailable")) return reason.code;

  if (Predicate.isTagged(reason, "entryUnreadable")) return reason.code;

  return gitErrorLabel(error);
}

function fileStatus(path: string): Effect.Effect<Stats, GitError> {
  return Effect.tryPromise({ try: () => lstat(path), catch: entryFailure });
}

function directoryEntries(path: string): Effect.Effect<readonly Dirent[], GitError> {
  return Effect.tryPromise({
    try: () => readdir(path, { withFileTypes: true }),
    catch: entryFailure,
  });
}

function makeDirectory(path: string): Effect.Effect<void, GitError> {
  return Effect.tryPromise({ try: () => mkdir(path, { recursive: true }), catch: entryFailure });
}

function measureEntry(absolute: string): Effect.Effect<Measurement> {
  return Effect.gen(function* () {
    const root = yield* Effect.option(fileStatus(absolute));

    if (Option.isNone(root)) return { bytes: 0, skipped: 1, missing: true };

    if (root.value.isSymbolicLink()) return NOTHING_MEASURED;

    if (root.value.isFile()) return { bytes: root.value.size, skipped: 0, missing: false };

    if (!root.value.isDirectory()) return NOTHING_MEASURED;

    let bytes = 0;
    let skipped = 0;
    const stack: string[] = [absolute];

    while (stack.length > 0) {
      const directory = stack.pop();

      if (directory === undefined) break;

      const listing = yield* Effect.option(directoryEntries(directory));

      if (Option.isNone(listing)) {
        skipped += 1;
        continue;
      }

      for (const entry of listing.value) {
        if (entry.name === NESTED_REPOSITORY) continue;

        if (entry.isSymbolicLink()) continue;

        const child = join(directory, entry.name);

        if (entry.isDirectory()) {
          stack.push(child);
          continue;
        }

        if (!entry.isFile()) continue;

        const info = yield* Effect.option(fileStatus(child));

        if (Option.isNone(info)) skipped += 1;
        else bytes += info.value.size;
      }
    }

    return { bytes, skipped, missing: false };
  });
}

export function worktreeIncluding(
  git: GitRunning,
  options: WorktreeIncludeOptions = {},
): WorktreeIncluding {
  const capBytes = options.capBytes ?? DEFAULT_INCLUDE_CAP_BYTES;
  const logger = options.log ?? silentLogger;

  const copyProgram = (request: IncludeCopyRequest): Effect.Effect<CopyReport> =>
    Effect.gen(function* () {
      const { repository, worktree } = request;

      let skipped = 0;
      let cloneUnavailable = false;
      let usedFallbackCopy = false;
      let copiedBytes = 0;

      const accepted: string[] = [];

      for (const path of request.paths) {
        if (Option.isSome(decodeIncludePath(path))) {
          accepted.push(path);
          continue;
        }

        skipped += 1;
        logger.debug("worktreeinclude entry skipped", { reason: "refused" });
      }

      if (accepted.length === 0) {
        return { copied: [], totalBytes: 0, usedFallbackCopy: false, skipped };
      }

      let measured = 0;
      let firstOffendingPath: string | undefined;
      const present: string[] = [];

      for (const entry of accepted) {
        const measurement = yield* measureEntry(
          join(repository, entry.replace(TRAILING_SLASHES, "")),
        );

        skipped += measurement.skipped;

        if (measurement.missing) continue;

        present.push(entry);
        measured += measurement.bytes;

        if (firstOffendingPath === undefined && measured > capBytes) firstOffendingPath = entry;
      }

      if (firstOffendingPath !== undefined) {
        const oversized: OversizedInclude = { totalBytes: measured, capBytes, firstOffendingPath };

        logger.notice("worktreeinclude over size cap, copy skipped", {
          totalBytes: measured,
          capBytes,
          entries: present.length,
        });
        options.onOversized?.(oversized);

        return { copied: [], totalBytes: 0, usedFallbackCopy: false, skipped, oversized };
      }

      const copyOneFile = (
        source: string,
        destination: string,
        size: number,
      ): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          if (!cloneUnavailable) {
            const cloned = yield* Effect.result(
              Effect.tryPromise({
                try: () => copyFile(source, destination, constants.COPYFILE_FICLONE_FORCE),
                catch: cloneFailure,
              }),
            );

            if (Result.isSuccess(cloned)) {
              copiedBytes += size;

              return true;
            }

            if (!Predicate.isTagged(cloned.failure.reason, "cloneUnavailable")) {
              logger.debug("worktreeinclude entry skipped", {
                reason: failureCode(cloned.failure),
              });

              return false;
            }

            cloneUnavailable = true;
            usedFallbackCopy = true;
            logger.notice("worktreeinclude clone unavailable, using byte copy", {
              reason: failureCode(cloned.failure),
            });
          }

          const copied = yield* Effect.result(
            Effect.tryPromise({ try: () => copyFile(source, destination), catch: entryFailure }),
          );

          if (Result.isFailure(copied)) {
            logger.debug("worktreeinclude entry skipped", { reason: failureCode(copied.failure) });

            return false;
          }

          copiedBytes += size;

          return true;
        });

      const copyOneSymlink = (source: string, destination: string): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          const recreated = yield* Effect.result(
            Effect.gen(function* () {
              const target = yield* Effect.tryPromise({
                try: () => readlink(source),
                catch: entryFailure,
              });

              yield* makeDirectory(dirname(destination));
              yield* Effect.tryPromise({
                try: () => symlink(target, destination),
                catch: entryFailure,
              });
            }),
          );

          if (Result.isFailure(recreated)) {
            logger.debug("worktreeinclude entry skipped", {
              reason: failureCode(recreated.failure),
            });

            return false;
          }

          return true;
        });

      const copyTree = (source: string, destination: string): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          const root = yield* Effect.result(makeDirectory(destination));

          if (Result.isFailure(root)) {
            logger.debug("worktreeinclude entry skipped", { reason: failureCode(root.failure) });

            return false;
          }

          const stack: { readonly source: string; readonly destination: string }[] = [
            { source, destination },
          ];

          while (stack.length > 0) {
            const current = stack.pop();

            if (current === undefined) break;

            const listing = yield* Effect.result(directoryEntries(current.source));

            if (Result.isFailure(listing)) {
              skipped += 1;
              logger.debug("worktreeinclude entry skipped", {
                reason: failureCode(listing.failure),
              });
              continue;
            }

            for (const entry of listing.success) {
              if (entry.name === NESTED_REPOSITORY) continue;

              const childSource = join(current.source, entry.name);
              const childDestination = join(current.destination, entry.name);

              if (entry.isSymbolicLink()) {
                if (!(yield* copyOneSymlink(childSource, childDestination))) skipped += 1;

                continue;
              }

              if (entry.isDirectory()) {
                const made = yield* Effect.result(makeDirectory(childDestination));

                if (Result.isFailure(made)) {
                  skipped += 1;
                  continue;
                }

                stack.push({ source: childSource, destination: childDestination });
                continue;
              }

              if (!entry.isFile()) {
                skipped += 1;
                continue;
              }

              const info = yield* Effect.result(fileStatus(childSource));

              if (Result.isFailure(info)) {
                skipped += 1;
                continue;
              }

              if (!(yield* copyOneFile(childSource, childDestination, info.success.size))) {
                skipped += 1;
              }
            }
          }

          return true;
        });

      const copied: string[] = [];

      for (const entry of present) {
        const relative = entry.replace(TRAILING_SLASHES, "");
        const source = join(repository, relative);
        const destination = join(worktree, relative);
        const info = yield* Effect.option(fileStatus(source));

        if (Option.isNone(info)) {
          skipped += 1;
          continue;
        }

        let landed = false;

        if (info.value.isSymbolicLink()) {
          landed = yield* copyOneSymlink(source, destination);
        } else if (info.value.isDirectory()) {
          landed = yield* copyTree(source, destination);
        } else if (info.value.isFile()) {
          const parent = yield* Effect.result(makeDirectory(dirname(destination)));

          landed =
            Result.isSuccess(parent) && (yield* copyOneFile(source, destination, info.value.size));
        }

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
    });

  return {
    async resolve(repository: AbsolutePath): Promise<readonly string[]> {
      const excludeFile = join(repository, INCLUDE_FILE_NAME);
      const probed = await Effect.runPromise(
        Effect.result(Effect.tryPromise({ try: () => stat(excludeFile), catch: entryFailure })),
      );

      if (Result.isFailure(probed)) {
        const code = failureCode(probed.failure);

        if (!ABSENT_CODES.has(code)) logger.debug("worktreeinclude unreadable", { reason: code });

        return [];
      }

      if (!probed.success.isFile()) return [];

      const output = await git.run(
        ["ls-files", "-o", "-i", `--exclude-from=${excludeFile}`, "-z", "--directory"],
        repository,
      );

      return output.split(ENTRY_SEPARATOR).filter((entry) => entry !== "");
    },

    copy(request: IncludeCopyRequest): Promise<CopyReport> {
      return Effect.runPromise(copyProgram(request));
    },
  };
}
