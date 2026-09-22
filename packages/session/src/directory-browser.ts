import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { absolutePath, type AbsolutePath } from "@janela/core";
import { Effect, Option, Schema } from "effect";

import { DirectoryUnreadable } from "./errors.ts";

export type DirectoryEntryKind = "directory" | "file";

export interface DirectoryEntry {
  readonly name: string;
  readonly kind: DirectoryEntryKind;
}

export interface DirectoryListing {
  readonly directory: AbsolutePath;
  readonly parent?: AbsolutePath;
  readonly home: AbsolutePath;
  readonly entries: readonly DirectoryEntry[];
  readonly truncated: boolean;
}

export interface DirectoryBrowsing {
  list(directory: AbsolutePath | undefined): Promise<DirectoryListing>;
}

export interface DirectoryBrowserDependencies {
  readonly home: AbsolutePath;
  readonly limit?: number;
}

export const DIRECTORY_ENTRY_LIMIT = 1000;

const ROOT = "/";

const HIDDEN_PREFIX = ".";

const UNKNOWN_ERRNO = "unknown";

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const decodeErrno = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }));

export function createDirectoryBrowser(deps: DirectoryBrowserDependencies): DirectoryBrowsing {
  const limit = deps.limit ?? DIRECTORY_ENTRY_LIMIT;

  return {
    async list(requested: AbsolutePath | undefined): Promise<DirectoryListing> {
      const directory = absolutePath(resolve(requested ?? deps.home));
      const names = await Effect.runPromise(
        Effect.tryPromise({
          try: () => readdir(directory, { withFileTypes: true }),
          catch: (cause) => new DirectoryUnreadable(directory, errnoOf(cause)),
        }),
      );

      const visible = names
        .filter((entry) => !entry.name.startsWith(HIDDEN_PREFIX))
        .toSorted((left, right) => byName.compare(left.name, right.name));

      const kept = visible.slice(0, limit);
      const classified = await Promise.all(kept.map((entry) => classify(directory, entry)));
      const listing: DirectoryListing = {
        directory,
        home: deps.home,
        entries: classified.filter((entry) => entry !== undefined),
        truncated: visible.length > kept.length,
      };

      return directory === ROOT
        ? listing
        : { ...listing, parent: absolutePath(dirname(directory)) };
    },
  };
}

async function classify(
  directory: AbsolutePath,
  entry: Dirent,
): Promise<DirectoryEntry | undefined> {
  if (entry.isDirectory()) return { name: entry.name, kind: "directory" };

  if (!entry.isSymbolicLink()) return { name: entry.name, kind: "file" };

  const target = await Effect.runPromise(
    Effect.option(Effect.tryPromise(() => stat(join(directory, entry.name)))),
  );

  return Option.match(target, {
    onNone: () => undefined,
    onSome: (stats) => ({ name: entry.name, kind: stats.isDirectory() ? "directory" : "file" }),
  });
}

function errnoOf(cause: unknown): string {
  return Option.match(decodeErrno(cause), {
    onNone: () => UNKNOWN_ERRNO,
    onSome: (errno) => errno.code,
  });
}
