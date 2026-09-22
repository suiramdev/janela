import { describe, expect, test } from "bun:test";

import type { AbsolutePath } from "@janela/core";

import {
  parseDirectoryListing,
  serializeDirectoryListing,
  type DirectoryListing,
} from "./directory-listing.ts";

type WireValue =
  | string
  | number
  | boolean
  | null
  | readonly WireValue[]
  | { readonly [key: string]: WireValue };

const path = (raw: string): AbsolutePath => raw as AbsolutePath;

const listing: DirectoryListing = {
  directory: path("/Users/ada/code"),
  parent: path("/Users/ada"),
  home: path("/Users/ada"),
  entries: [
    { name: "janela", kind: "directory" },
    { name: "notes.md", kind: "file" },
  ],
  truncated: false,
};

const corrupted = (field: string, value: WireValue): string =>
  JSON.stringify({ ...listing, [field]: value });

describe("the directory listing on the wire", () => {
  test("round-trips the directory, its parent, the home and the entries", () => {
    expect(parseDirectoryListing(serializeDirectoryListing(listing))).toEqual(listing);
  });

  test("the root carries no parent key at all", () => {
    const { parent: _omitted, ...root } = listing;
    const encoded = serializeDirectoryListing({ ...root, directory: path("/") });

    expect(JSON.parse(encoded)).not.toHaveProperty("parent");
    expect(parseDirectoryListing(encoded)).not.toHaveProperty("parent");
  });

  test("carries only the wire fields, however wide the caller's object is", () => {
    const wider = {
      ...listing,
      entries: listing.entries.map((entry) => ({ ...entry, size: 1024, modifiedAt: "2026" })),
    };

    expect(JSON.parse(serializeDirectoryListing(wider))).toEqual({ ...listing });
  });

  test("text that is not JSON is not a listing", () => {
    expect(() => parseDirectoryListing("not json")).toThrow(TypeError);
    expect(() => parseDirectoryListing("[]")).toThrow(TypeError);
    expect(() => parseDirectoryListing("null")).toThrow(TypeError);
  });

  test("a missing field is refused rather than defaulted", () => {
    const { entries: _omitted, ...withoutEntries } = listing;

    expect(() => parseDirectoryListing(JSON.stringify(withoutEntries))).toThrow(TypeError);
  });

  test("a directory that is not absolute is refused, because it becomes a working directory", () => {
    expect(() => parseDirectoryListing(corrupted("directory", "code"))).toThrow(TypeError);
    expect(() => parseDirectoryListing(corrupted("parent", "Users/ada"))).toThrow(TypeError);
    expect(() => parseDirectoryListing(corrupted("home", ""))).toThrow(TypeError);
  });

  test("an entry with an unknown kind or an empty name is refused", () => {
    expect(() =>
      parseDirectoryListing(corrupted("entries", [{ name: "x", kind: "symlink" }])),
    ).toThrow(TypeError);

    expect(() =>
      parseDirectoryListing(corrupted("entries", [{ name: "", kind: "directory" }])),
    ).toThrow(TypeError);

    expect(() => parseDirectoryListing(corrupted("entries", [null]))).toThrow(TypeError);
  });

  test("truncated is a boolean, not whatever is truthy", () => {
    expect(() => parseDirectoryListing(corrupted("truncated", "yes"))).toThrow(TypeError);
  });
});
