import { absolutePath, type AbsolutePath } from "@janela/core";
import { Result, Schema } from "effect";

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

interface EncodedListing {
  directory: string;
  parent?: string;
  home: string;
  entries: readonly DirectoryEntry[];
  truncated: boolean;
}

interface DecodedListing {
  directory: AbsolutePath;
  parent?: AbsolutePath;
  home: AbsolutePath;
  entries: readonly DirectoryEntry[];
  truncated: boolean;
}

const WirePath = Schema.String.check(Schema.isStartsWith("/"));

const WireEntry = Schema.Struct({
  name: Schema.String.check(Schema.isNonEmpty()),
  kind: Schema.Literals(["directory", "file"]),
});

const WireListing = Schema.Struct({
  directory: WirePath,
  parent: Schema.optionalKey(WirePath),
  home: WirePath,
  entries: Schema.Array(WireEntry),
  truncated: Schema.Boolean,
});

const decodeListingText = Schema.decodeUnknownResult(Schema.fromJsonString(WireListing));

export function serializeDirectoryListing(listing: DirectoryListing): string {
  const encoded: EncodedListing = {
    directory: listing.directory,
    home: listing.home,
    entries: listing.entries.map((entry) => ({ name: entry.name, kind: entry.kind })),
    truncated: listing.truncated,
  };

  if (listing.parent !== undefined) encoded.parent = listing.parent;

  return JSON.stringify(encoded);
}

export function parseDirectoryListing(text: string): DirectoryListing {
  const decoded = Result.mapError(
    decodeListingText(text),
    (error) => new TypeError(`not a directory listing: ${error.message}`),
  );

  const wire = Result.getOrThrowWith(decoded, (error) => error);

  const parsed: DecodedListing = {
    directory: absolutePath(wire.directory),
    home: absolutePath(wire.home),
    entries: wire.entries,
    truncated: wire.truncated,
  };

  if (wire.parent !== undefined) parsed.parent = absolutePath(wire.parent);

  return parsed;
}
