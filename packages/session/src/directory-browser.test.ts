import { describe, expect, test } from "bun:test";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";

import { absolutePath } from "@janela/core";
import { temporaryDirectory } from "@janela/test-support";

import { createDirectoryBrowser } from "./directory-browser.ts";
import { DirectoryUnreadable } from "./errors.ts";

const rejection = (work: Promise<unknown>): Promise<Error> =>
  work.then(
    () => {
      throw new Error("the call resolved instead of rejecting");
    },
    (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
  );

describe("the directory browser", () => {
  test("lists a folder with folders and files told apart, sorted naturally, hidden entries left out", async () => {
    await using home = await temporaryDirectory("browse-home");
    await mkdir(home.join("code", "zeta"), { recursive: true });
    await mkdir(home.join("code", "Alpha"));
    await mkdir(home.join("code", "item10"));
    await mkdir(home.join("code", "item2"));
    await mkdir(home.join("code", ".git"));
    await writeFile(home.join("code", "notes.md"), "");
    await writeFile(home.join("code", ".env"), "");

    const browser = createDirectoryBrowser({ home: absolutePath(home.path) });
    const listing = await browser.list(absolutePath(home.join("code")));

    expect(listing.directory).toBe(absolutePath(home.join("code")));
    expect(listing.parent).toBe(absolutePath(home.path));
    expect(listing.home).toBe(absolutePath(home.path));
    expect(listing.truncated).toBe(false);
    expect(listing.entries).toEqual([
      { name: "Alpha", kind: "directory" },
      { name: "item2", kind: "directory" },
      { name: "item10", kind: "directory" },
      { name: "notes.md", kind: "file" },
      { name: "zeta", kind: "directory" },
    ]);
  });

  test("no directory means the home, and the root has no parent", async () => {
    await using home = await temporaryDirectory("browse-default");
    await mkdir(home.join("Documents"));

    const browser = createDirectoryBrowser({ home: absolutePath(home.path) });

    expect((await browser.list(undefined)).entries).toEqual([
      { name: "Documents", kind: "directory" },
    ]);
    expect(await browser.list(absolutePath("/"))).not.toHaveProperty("parent");
  });

  test("a symlink takes the kind of its target, and a dangling one is left out", async () => {
    await using home = await temporaryDirectory("browse-links");
    await mkdir(home.join("real"));
    await writeFile(home.join("file.txt"), "");
    await symlink(home.join("real"), home.join("to-folder"));
    await symlink(home.join("file.txt"), home.join("to-file"));
    await symlink(home.join("gone"), home.join("dangling"));

    const browser = createDirectoryBrowser({ home: absolutePath(home.path) });
    const { entries } = await browser.list(undefined);

    expect(entries).toEqual([
      { name: "file.txt", kind: "file" },
      { name: "real", kind: "directory" },
      { name: "to-file", kind: "file" },
      { name: "to-folder", kind: "directory" },
    ]);
  });

  test("a folder past the limit is cut after sorting, and says so", async () => {
    await using home = await temporaryDirectory("browse-limit");

    await Promise.all(["d", "b", "a", "c"].map((name) => mkdir(home.join(name))));

    const browser = createDirectoryBrowser({ home: absolutePath(home.path), limit: 3 });
    const listing = await browser.list(undefined);

    expect(listing.entries.map((entry) => entry.name)).toEqual(["a", "b", "c"]);
    expect(listing.truncated).toBe(true);
  });

  test("`..` and trailing slashes are folded before the path is read or reported", async () => {
    await using home = await temporaryDirectory("browse-normalize");
    await mkdir(home.join("code", "nested"), { recursive: true });

    const browser = createDirectoryBrowser({ home: absolutePath(home.path) });
    const listing = await browser.list(absolutePath(`${home.join("code", "nested")}/../`));

    expect(listing.directory).toBe(absolutePath(home.join("code")));
    expect(listing.entries).toEqual([{ name: "nested", kind: "directory" }]);
  });

  test("a missing folder, a file, and a folder without permission each fail with their own reason", async () => {
    await using home = await temporaryDirectory("browse-failures");
    await writeFile(home.join("file.txt"), "");
    await mkdir(home.join("sealed"));
    await chmod(home.join("sealed"), 0o000);

    const browser = createDirectoryBrowser({ home: absolutePath(home.path) });

    const missing = await rejection(browser.list(absolutePath(home.join("nowhere"))));
    const file = await rejection(browser.list(absolutePath(home.join("file.txt"))));
    const sealed = await rejection(browser.list(absolutePath(home.join("sealed"))));

    await chmod(home.join("sealed"), 0o700);

    expect(missing).toBeInstanceOf(DirectoryUnreadable);
    expect(file).toBeInstanceOf(DirectoryUnreadable);
    expect(sealed).toBeInstanceOf(DirectoryUnreadable);

    if (
      !(missing instanceof DirectoryUnreadable) ||
      !(file instanceof DirectoryUnreadable) ||
      !(sealed instanceof DirectoryUnreadable)
    ) {
      throw new Error("unreachable");
    }

    expect(missing.reason).toBe("It doesn't exist.");
    expect(file.reason).toBe("It isn't a folder.");
    expect(sealed.reason).toBe("You don't have permission to read it.");
    expect(sealed.summary).toBe("Couldn't open that folder.");
  });
});
