import { describe, expect, test } from "bun:test";

import { absolutePath } from "@janela/core";
import type { DirectoryListing } from "@janela/protocol";

import {
  childPath,
  chosenDirectory,
  columnDirectories,
  focusColumn,
  goUp,
  lastComponent,
  openColumns,
  openEntry,
  stepSelection,
  typedDirectory,
} from "./directory-columns.ts";

const HOME = absolutePath("/Users/ada");

const at = (raw: string) => absolutePath(raw);

const listing: DirectoryListing = {
  directory: HOME,
  parent: absolutePath("/Users"),
  home: HOME,
  entries: [
    { name: "Alpha", kind: "directory" },
    { name: "beta.txt", kind: "file" },
    { name: "code", kind: "directory" },
    { name: "zeta", kind: "directory" },
  ],
  truncated: false,
};

describe("paths", () => {
  test("a child of the root has one slash, a child of anything else gains one", () => {
    expect(childPath(absolutePath("/"), "Users")).toBe(at("/Users"));
    expect(childPath(HOME, "code")).toBe(at("/Users/ada/code"));
  });

  test("a typed path loses its trailing slashes; a relative one is not a path at all", () => {
    expect(typedDirectory("  /Users/ada/code/  ")).toBe(at("/Users/ada/code"));
    expect(typedDirectory("///")).toBe(at("/"));
    expect(typedDirectory("code")).toBeUndefined();
    expect(typedDirectory("")).toBeUndefined();
  });

  test("the last component names a folder, and the root names itself", () => {
    expect(lastComponent(HOME)).toBe("ada");
    expect(lastComponent(absolutePath("/"))).toBe("/");
  });
});

describe("opening", () => {
  test("opening an entry adds a column, and opening in an earlier column drops the deeper ones", () => {
    const deep = openEntry(openEntry(openColumns(HOME), 0, "code"), 1, "janela");

    expect(columnDirectories(deep)).toEqual([
      at("/Users/ada"),
      at("/Users/ada/code"),
      at("/Users/ada/code/janela"),
    ]);
    expect(chosenDirectory(deep)).toBe(at("/Users/ada/code/janela"));
    expect(deep.focused).toBe(1);

    const sideways = openEntry(deep, 0, "zeta");

    expect(columnDirectories(sideways)).toEqual([at("/Users/ada"), at("/Users/ada/zeta")]);
    expect(sideways.focused).toBe(0);
  });

  test("a column that does not exist yet cannot be opened into", () => {
    const columns = openColumns(HOME);

    expect(openEntry(columns, 2, "x")).toBe(columns);
    expect(openEntry(columns, -1, "x")).toBe(columns);
  });
});

describe("stepping", () => {
  test("with nothing selected, down selects the first folder and up the last, skipping files", () => {
    const columns = openColumns(HOME);

    expect(stepSelection(columns, listing, 1).path).toEqual(["Alpha"]);
    expect(stepSelection(columns, listing, -1).path).toEqual(["zeta"]);
  });

  test("steps stop at the ends rather than wrapping", () => {
    const atZeta = openEntry(openColumns(HOME), 0, "zeta");
    const atAlpha = openEntry(openColumns(HOME), 0, "Alpha");

    expect(stepSelection(atZeta, listing, 1)).toBe(atZeta);
    expect(stepSelection(atAlpha, listing, -1)).toBe(atAlpha);
    expect(stepSelection(atAlpha, listing, 1).path).toEqual(["code"]);
  });

  test("stepping in an earlier column replaces the deeper ones", () => {
    const deep = focusColumn(openEntry(openEntry(openColumns(HOME), 0, "Alpha"), 1, "x"), 0);

    expect(stepSelection(deep, listing, 1).path).toEqual(["code"]);
  });

  test("an empty folder has nothing to step to", () => {
    const columns = openColumns(HOME);

    expect(stepSelection(columns, { ...listing, entries: [] }, 1)).toBe(columns);
  });
});

describe("focus", () => {
  test("focus moves between existing columns only", () => {
    const deep = openEntry(openColumns(HOME), 0, "code");

    expect(focusColumn(deep, 1).focused).toBe(1);
    expect(focusColumn(deep, 5).focused).toBe(1);
    expect(focusColumn(deep, -3).focused).toBe(0);
    expect(focusColumn(deep, 0)).toBe(deep);
  });

  test("going up keeps every column and selects the old root in the new one", () => {
    const deep = focusColumn(openEntry(openColumns(HOME), 0, "code"), 1);
    const up = goUp(deep, absolutePath("/Users"));

    expect(columnDirectories(up)).toEqual([at("/Users"), at("/Users/ada"), at("/Users/ada/code")]);
    expect(up.focused).toBe(2);
    expect(chosenDirectory(up)).toBe(at("/Users/ada/code"));
  });
});
