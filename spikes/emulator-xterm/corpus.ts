/**
 * The damage corpus, as data.
 *
 * A copy of what `packages/terminal/src/headless-emulator.test.ts` drives, kept
 * here because a package may not import a spike and a spike may not be the test's
 * source of truth. If the two drift, the test is right.
 */

export type Step = { readonly feed: string; readonly full?: true };

export interface Case {
  readonly name: string;
  readonly columns: number;
  readonly rows: number;
  readonly setup?: string;
  readonly steps: readonly Step[];
}

export const CORPUS: readonly Case[] = [
  {
    name: "prompt typing",
    columns: 80,
    rows: 24,
    setup: "$ ",
    steps: [
      { feed: "l" },
      { feed: "s" },
      { feed: " -la" },
      { feed: "\r\n" },
      { feed: "total 0\r\n$ " },
      { feed: "\x1b[1;1H\x1b[2Kshort" },
    ],
  },
  {
    name: "colours and every flag",
    columns: 60,
    rows: 8,
    steps: [
      { feed: "\x1b[31mred \x1b[91mbright \x1b[38;5;200mpalette \x1b[38;2;10;200;30mtrue\x1b[0m\r\n" },
      { feed: "\x1b[41mred bg \x1b[101mbright \x1b[48;5;99mpalette \x1b[48;2;9;9;9mrgb\x1b[0m\r\n" },
      { feed: "\x1b[1mbold\x1b[22;2mdim\x1b[0m still\r\n" },
      { feed: "\x1b[7minverse\x1b[27m \x1b[4munderline\x1b[24m \x1b[53moverline\x1b[55m\r\n" },
      { feed: "\x1b[5mblink\x1b[25m \x1b[8minvisible\x1b[28m \x1b[3mitalic\x1b[23m \x1b[9mstrike\x1b[29m\r\n" },
    ],
  },
  {
    name: "wide characters",
    columns: 12,
    rows: 4,
    steps: [
      { feed: "ab中文cd\r\n" },
      { feed: "\x1b[2;1Hxxxxxxxxxxx中" },
      { feed: "\x1b[1;3Hzz" },
    ],
  },
  {
    name: "combined characters",
    columns: 12,
    rows: 4,
    steps: [
      { feed: "e\u0301 a\u0300\r\n" },
      { feed: "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\r\n" },
      { feed: "\x1b[1;1Ho\u0308" },
      { feed: "\x1b[1;1Hu\u030a" },
    ],
  },
  {
    name: "erasures with a background colour",
    columns: 20,
    rows: 6,
    steps: [
      { feed: "filled with text here\r\n" },
      { feed: "\x1b[1;5H\x1b[44m\x1b[K" },
      { feed: "\x1b[2;1Hsecond row of text\x1b[2;4H\x1b[41m\x1b[5X" },
      { feed: "\x1b[3;1Hthird\x1b[3;1H\x1b[42m\x1b[2K" },
      { feed: "\x1b[4;1H\x1b[45m\x1b[3X\x1b[3C\x1b[46m\x1b[3X\x1b[3Cmid\x1b[0m" },
      { feed: "\x1b[5;1H\x1b[43m\x1b[2J" },
    ],
  },
  {
    name: "scrolling",
    columns: 40,
    rows: 24,
    steps: [
      { feed: Array.from({ length: 30 }, (_, index) => `pre-${index} with width\r\n`).join("") },
      { feed: "a with width\r\nb with width\r\nc with width\r\n" },
      { feed: "d with width\r\ne with width\r\nf with width\r\n" },
    ],
  },
  {
    name: "a scroll region",
    columns: 20,
    rows: 10,
    setup: "\x1b[1;1Hheader\r\n",
    steps: [
      { feed: "\x1b[3;8r\x1b[3;1H" },
      { feed: "a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\n" },
      { feed: "h\r\ni\r\n" },
      { feed: "\x1b[r" },
      { feed: "after\r\n" },
    ],
  },
  {
    name: "the alternate screen",
    columns: 40,
    rows: 10,
    setup: "normal screen content\r\n",
    steps: [
      { feed: "\x1b[?1049h\x1b[2J\x1b[H", full: true },
      { feed: "\x1b[3;3Hinside the alternate screen" },
      { feed: "\x1b[5;1H\x1b[44mstatus\x1b[0m" },
      { feed: "\x1b[?1049l", full: true },
      { feed: "back on the normal screen\r\n" },
    ],
  },
  {
    name: "the cursor",
    columns: 10,
    rows: 5,
    setup: "\x1b[1;1Hrow",
    steps: [
      { feed: "\x1b[4;7H" },
      { feed: "\x1b[2;1H0123456789" },
      { feed: "\x1b[?25l" },
      { feed: "\x1b[?25h" },
    ],
  },
  {
    name: "modes",
    columns: 20,
    rows: 4,
    setup: "content\r\n",
    steps: [
      { feed: "\x1b[?1h" },
      { feed: "\x1b[?2004h" },
      { feed: "\x1b[?1000h\x1b[?1006h" },
      { feed: "\x1b[4h" },
      { feed: "\x1b[4l" },
      { feed: "\x1b[5 q" },
      { feed: "\x1b[!p" },
      { feed: "\x1b[?7l" },
      { feed: "\x1b[?7h" },
    ],
  },
];
