import { describe, expect, test } from "bun:test";

import { renderToStaticMarkup } from "react-dom/server";

import { CommandPalette, rankedCommands } from "./command-palette.tsx";
import { COMMANDS } from "./commands.ts";

const noop = (): void => {};

describe("rankedCommands", () => {
  test("an empty query is the whole table, in its order", () => {
    expect(rankedCommands("").map((item) => item.id)).toEqual(
      COMMANDS.map((command) => command.id),
    );
  });

  test("every row of the table is reachable by its own title", () => {
    // The "one place" guarantee: a command added to COMMANDS is in the palette and
    // in the menu bar, with nothing else to update.
    for (const command of COMMANDS) {
      expect(rankedCommands(command.title).map((item) => item.id)).toContain(command.id);
    }
  });

  test("a row's chord travels with it, as symbols", () => {
    const split = rankedCommands("Split Vertically")[0];
    expect(split?.id).toBe("splitRight");
    expect(split?.chord).toBe("⌘D");
  });

  test("commands with no chord carry none", () => {
    const reveal = rankedCommands("Reveal in Finder")[0];
    expect(reveal?.id).toBe("revealInFinder");
    expect(reveal?.chord).toBeUndefined();
  });
});

describe("CommandPalette markup", () => {
  test("lists the commands with their chords", () => {
    const markup = renderToStaticMarkup(<CommandPalette onPick={noop} onCancel={noop} />);

    expect(markup).toContain("Go to Session…");
    expect(markup).toContain("⌘⇧O");
    expect(markup).toContain('role="listbox"');
  });
});
