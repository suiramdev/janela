import { describe, expect, test } from "bun:test";

import { absolutePath } from "@janela/core";

import {
  TERMINAL_APP,
  tauriDirectoryPicker,
  tauriNativeShell,
  type DirectoryDialogOptions,
} from "./native.ts";

describe("tauriDirectoryPicker", () => {
  test("asks for exactly one directory under the caller's title", async () => {
    const requests: DirectoryDialogOptions[] = [];
    const picker = tauriDirectoryPicker({
      open: async (options) => {
        requests.push(options);

        return "/Users/me/src/api";
      },
    });

    const picked = await picker.pickDirectory({ title: "Add Project" });

    expect(picked).toBe(absolutePath("/Users/me/src/api"));
    expect(requests).toEqual([{ directory: true, multiple: false, title: "Add Project" }]);
  });

  test("a cancelled dialog is no choice, not a path", async () => {
    const picker = tauriDirectoryPicker({ open: async () => null });

    expect(await picker.pickDirectory({ title: "Add Project" })).toBeUndefined();
  });
});

describe("tauriNativeShell", () => {
  test("opens a directory in Terminal rather than whatever owns folders", async () => {
    const opened: [string, string][] = [];
    const shell = tauriNativeShell({
      openPath: async (path, openWith) => {
        opened.push([path, openWith]);
      },
    });

    await shell.openInTerminal(absolutePath("/tmp/s1"));

    expect(opened).toEqual([["/tmp/s1", TERMINAL_APP]]);
  });

  test("reveals the directory itself in Finder", async () => {
    const revealed: string[] = [];
    const shell = tauriNativeShell({
      revealItemInDir: async (path) => {
        revealed.push(path);
      },
    });

    await shell.revealInFinder(absolutePath("/tmp/s1"));

    expect(revealed).toEqual(["/tmp/s1"]);
  });
});
