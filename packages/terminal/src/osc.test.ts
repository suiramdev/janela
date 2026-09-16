import { describe, expect, test } from "bun:test";

import {
  parseNotification,
  parsePromptMark,
  parseUrxvtNotification,
  parseWorkingDirectory,
  sanitiseOscText,
} from "./osc.ts";
import { MAX_OSC_TEXT_LENGTH } from "./terminal-emulating.ts";

const HOST = "build-box.local";

describe("sanitiseOscText", () => {
  test("strips C0, DEL and C1 controls and keeps everything else", () => {
    expect(sanitiseOscText("a\u0001b\u007fc\u0085d")).toBe("abcd");
    expect(sanitiseOscText("café 中文 ✓")).toBe("café 中文 ✓");
  });

  test("truncates to MAX_OSC_TEXT_LENGTH", () => {
    expect(sanitiseOscText("x".repeat(3000))).toHaveLength(MAX_OSC_TEXT_LENGTH);
  });

  test("truncates by code point, never leaving a lone surrogate behind", () => {
    const result = sanitiseOscText("😀".repeat(1024));

    expect([...result]).toHaveLength(MAX_OSC_TEXT_LENGTH);
    expect(result).toBe("😀".repeat(1024));
  });
});

describe("parseWorkingDirectory", () => {
  test("percent-decodes a local file URL", () => {
    expect(parseWorkingDirectory("file://localhost/tmp/x%20y", HOST)).toBe("/tmp/x y");
    expect(parseWorkingDirectory("file:///a", HOST)).toBe("/a");
    expect(parseWorkingDirectory(`file://${HOST}/a/b`, HOST)).toBe("/a/b");
  });

  test("refuses another host's directory, which does not exist on this machine", () => {
    expect(parseWorkingDirectory("file://otherhost/a", HOST)).toBeUndefined();
  });

  test("refuses anything that is not a file URL", () => {
    expect(parseWorkingDirectory("kitty-shell-cwd://host/p", HOST)).toBeUndefined();
    expect(parseWorkingDirectory("../relative", HOST)).toBeUndefined();
    expect(parseWorkingDirectory("", HOST)).toBeUndefined();
  });

  test("refuses malformed percent escapes rather than guessing", () => {
    expect(parseWorkingDirectory("file://localhost/%ZZ", HOST)).toBeUndefined();
  });

  test("refuses an over-long path instead of truncating it to a wrong one", () => {
    const long = `file:///${"d".repeat(MAX_OSC_TEXT_LENGTH + 10)}`;

    expect(parseWorkingDirectory(long, HOST)).toBeUndefined();
  });
});

describe("parseNotification", () => {
  test("treats the payload as the body", () => {
    expect(parseNotification("build done")).toEqual({ body: "build done" });
  });

  test("an empty payload is attention with no text", () => {
    expect(parseNotification("")).toEqual({});
    expect(parseNotification("\u0001")).toEqual({});
  });

  test("ignores ConEmu sub-commands, so a progress bar never badges a session", () => {
    expect(parseNotification("4;1;50")).toBeUndefined();
    expect(parseNotification("1;done")).toBeUndefined();
  });
});

describe("parseUrxvtNotification", () => {
  test("splits title from body and keeps semicolons in the body", () => {
    expect(parseUrxvtNotification("notify;t;b;c")).toEqual({ title: "t", body: "b;c" });
  });

  test("omits empty fields rather than carrying blanks", () => {
    expect(parseUrxvtNotification("notify;t")).toEqual({ title: "t" });
    expect(parseUrxvtNotification("notify")).toEqual({});
  });

  test("ignores any other sub-command", () => {
    expect(parseUrxvtNotification("other;x")).toBeUndefined();
  });
});

describe("parsePromptMark", () => {
  test("reads the three marks Janela acts on", () => {
    expect(parsePromptMark("A")).toEqual({ kind: "promptStart" });
    expect(parsePromptMark("A;aid=1")).toEqual({ kind: "promptStart" });
    expect(parsePromptMark("C")).toEqual({ kind: "commandStart" });
    expect(parsePromptMark("C;cmdline=ls")).toEqual({ kind: "commandStart" });
    expect(parsePromptMark("D")).toEqual({ kind: "commandFinished" });
  });

  test("carries an exit code only when there is a number to carry", () => {
    expect(parsePromptMark("D;1")).toEqual({ kind: "commandFinished", exitCode: 1 });
    expect(parsePromptMark("D;-1")).toEqual({ kind: "commandFinished", exitCode: -1 });
    expect(parsePromptMark("D;x")).toEqual({ kind: "commandFinished" });
    expect(parsePromptMark("D;")).toEqual({ kind: "commandFinished" });
  });

  test("ignores marks with no meaning here", () => {
    expect(parsePromptMark("B")).toBeUndefined();
    expect(parsePromptMark("P;k=i")).toBeUndefined();
    expect(parsePromptMark("")).toBeUndefined();
  });
});
