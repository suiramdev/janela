import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { parseArguments } from "./arguments.ts";

describe("parseArguments", () => {
  test("nothing, help, --help and -h all ask for help", () => {
    for (const argv of [[], ["help"], ["--help"], ["-h"]]) {
      expect(parseArguments(argv)).toEqual({ kind: "help" });
    }
  });

  test("list reads, and --json switches the format", () => {
    expect(parseArguments(["list"])).toEqual({
      kind: "run",
      command: { kind: "list", json: false },
    });

    expect(parseArguments(["list", "--json"])).toEqual({
      kind: "run",
      command: { kind: "list", json: true },
    });
  });

  test("project add makes its directory absolute", () => {
    expect(parseArguments(["project", "add", "code/janela", "--name", "Janela"])).toEqual({
      kind: "run",
      command: { kind: "addProject", directory: resolve("code/janela"), name: "Janela" },
    });
  });

  test("a standalone session is a directory and nothing else", () => {
    expect(parseArguments(["session", "create", "--directory", "scratch"])).toEqual({
      kind: "run",
      command: {
        kind: "createSession",
        target: { kind: "directory", directory: resolve("scratch") },
        name: undefined,
      },
    });

    expect(
      parseArguments(["session", "create", "--directory", "scratch", "--project", "p"]).kind,
    ).toBe("usage");
  });

  test("a session in a project takes an existing branch or makes a new one, never both", () => {
    expect(parseArguments(["session", "create", "--project", "janela", "--branch", "dev"])).toEqual(
      {
        kind: "run",
        command: {
          kind: "createSession",
          target: { kind: "project", project: "janela", branch: "dev" },
          name: undefined,
        },
      },
    );

    expect(
      parseArguments([
        "session",
        "create",
        "--project",
        "janela",
        "--new-branch",
        "feat/cli",
        "--from",
        "dev",
        "--name",
        "CLI",
      ]),
    ).toEqual({
      kind: "run",
      command: {
        kind: "createSession",
        target: { kind: "newBranch", project: "janela", branch: "feat/cli", startPoint: "dev" },
        name: "CLI",
      },
    });

    expect(
      parseArguments(["session", "create", "--project", "p", "--branch", "a", "--new-branch", "b"])
        .kind,
    ).toBe("usage");

    expect(parseArguments(["session", "create", "--project", "p", "--from", "dev"]).kind).toBe(
      "usage",
    );

    expect(parseArguments(["session", "create"]).kind).toBe("usage");
  });

  test("session remove does not confirm itself unless told to", () => {
    expect(parseArguments(["session", "remove", "s1"])).toEqual({
      kind: "run",
      command: { kind: "removeSession", session: "s1", yes: false, deleteDirectory: false },
    });

    expect(parseArguments(["session", "remove", "s1", "--yes", "--delete-directory"])).toEqual({
      kind: "run",
      command: { kind: "removeSession", session: "s1", yes: true, deleteDirectory: true },
    });
  });

  test("terminal create, start and read each name one target", () => {
    expect(parseArguments(["terminal", "create", "s1", "--title", "Build"])).toEqual({
      kind: "run",
      command: { kind: "createTerminal", session: "s1", title: "Build" },
    });

    expect(parseArguments(["terminal", "start", "t1"])).toEqual({
      kind: "run",
      command: { kind: "startTerminal", terminal: "t1" },
    });

    expect(parseArguments(["terminal", "read", "t1", "--scrollback"])).toEqual({
      kind: "run",
      command: { kind: "readTerminal", terminal: "t1", scrollback: true },
    });
  });

  test("anything unknown, missing or repeated is a usage problem, not a guess", () => {
    for (const argv of [
      ["frobnicate"],
      ["session", "rename", "s1"],
      ["terminal", "start"],
      ["terminal", "start", "t1", "t2"],
      ["terminal", "read", "t1", "--follow"],
      ["project", "add", "a", "--name"],
      ["project", "add", "a", "--name", "x", "--name", "y"],
    ]) {
      expect(parseArguments(argv).kind).toBe("usage");
    }
  });
});
