/**
 * `TerminalEmulating` over `@xterm/headless`.
 *
 * **The only module in the repository's daemon half that names an emulator
 * library**, which is the whole point of the seam it implements — see
 * docs/decisions/0018-terminal-engine.md and the gated-modules table in
 * `scripts/layers.ts`. Everything library-specific is here; everything else in
 * this package talks to `TerminalEmulating`.
 */

import { hostname } from "node:os";

import type { GridSize } from "@janela/core";
import type { TerminalBytes } from "@janela/pty";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";

import {
  parseNotification,
  parsePromptMark,
  parseUrxvtNotification,
  parseWorkingDirectory,
  sanitiseOscText,
} from "./osc.ts";
import type { TerminalEmulating, TerminalEventSink } from "./terminal-emulating.ts";

const encoder = new TextEncoder();

/**
 * Shared, never mutated. `repaintSince` is called once per frame per attached
 * client and "nothing changed" is the common answer; it must not allocate.
 */
const EMPTY = new Uint8Array(0);

/** `CSI 3 J` — erase scrollback, leaving the visible rows and the cursor alone. */
const CLEAR_SCROLLBACK = encoder.encode("\x1b[3J");

/**
 * `ESC c` (RIS), prefixed to every full repaint.
 *
 * `SerializeAddon` writes for a *fresh* terminal: relative cursor moves, `\r\n`
 * row separators, and mode sequences it only ever sets. Replayed onto a renderer
 * that already has content — the second repaint of any session — the result
 * diverges from the source. RIS rebuilds the receiver's buffers, returns it to
 * the normal screen and resets modes and attributes, which makes the replay
 * grid-, cursor-, buffer- and mode-identical. Verified by the round-trip test,
 * which fails on its second assertion without this.
 */
const FULL_RESET = "\x1bc";

export class HeadlessEmulator implements TerminalEmulating {
  /**
   * Package-internal, and deliberately not on `TerminalEmulating`: the round-trip
   * test reads the source grid through it to compare against a receiver. Nothing
   * outside this package can reach it, because `index.ts` exports the factory and
   * not the class.
   */
  readonly terminal: Terminal;

  events: TerminalEventSink | undefined;

  private readonly serializer = new SerializeAddon();
  /** Returned by the `size` getter as-is; replaced, never mutated, on resize. */
  private currentSize: GridSize;
  private currentRevision = 0;
  private parsed = false;
  /** One closure per emulator rather than one per frame. */
  private readonly markParsed = (): void => {
    this.parsed = true;
  };
  /** Read once. An OSC 7 handler must not call into the OS on the parse path. */
  private readonly hostName = hostname();

  constructor(size: GridSize, scrollback: number) {
    this.terminal = new Terminal({
      cols: size.columns,
      rows: size.rows,
      scrollback,
      // OSC 7, 9, 133 and 777 need `registerOscHandler`, which is proposed API.
      allowProposedApi: true,
      // The default is `info`, and it writes to `console`. A daemon parsing a
      // user's terminal output must not narrate it to the system log.
      logLevel: "off",
    });
    this.terminal.loadAddon(this.serializer);
    this.currentSize = { columns: this.terminal.cols, rows: this.terminal.rows };

    this.terminal.onBell(() => {
      this.events?.onAttention({});
    });
    this.terminal.onTitleChange((title) => {
      this.events?.onTitle(sanitiseOscText(title));
    });

    // Every handler is synchronous and returns `true`. Returning a promise would
    // suspend the parser, and `feed()` requires that a chunk is parsed before it
    // returns — see the note there.
    this.terminal.parser.registerOscHandler(7, (payload) => {
      const directory = parseWorkingDirectory(payload, this.hostName);
      if (directory !== undefined) {
        this.events?.onWorkingDirectory(directory);
      }
      return true;
    });
    this.terminal.parser.registerOscHandler(9, (payload) => {
      const notification = parseNotification(payload);
      if (notification !== undefined) {
        this.events?.onAttention(notification);
      }
      return true;
    });
    this.terminal.parser.registerOscHandler(777, (payload) => {
      const notification = parseUrxvtNotification(payload);
      if (notification !== undefined) {
        this.events?.onAttention(notification);
      }
      return true;
    });
    this.terminal.parser.registerOscHandler(133, (payload) => {
      const mark = parsePromptMark(payload);
      if (mark !== undefined) {
        this.events?.onPromptMark(mark);
      }
      return true;
    });
  }

  /**
   * Parses one drained chunk, synchronously.
   *
   * `TerminalBytes` is a view into a buffer the PTY layer reuses every frame, so
   * the bytes are gone by the next drain. `Terminal.write` is normally
   * *asynchronous* — it queues the chunk and parses it from a `setTimeout(0)` —
   * which would hand the parser someone else's output.
   *
   * The escape hatch is xterm's own: a write buffer that has just seen user input
   * parses the next chunk inline, so that a keystroke's echo is never a frame
   * late. `input("", true)` sets exactly that flag through the public API and
   * writes nothing. The flag is cleared by each inner write, so it is set per
   * chunk rather than once.
   *
   * The alternative — copying every chunk — is up to a megabyte of allocation per
   * terminal per frame, which is the throughput budget in docs/performance.md
   * spent on nothing. So the assumption is asserted instead of trusted: if a
   * future version of the library queues the write anyway, this throws rather
   * than silently parsing recycled memory.
   */
  feed(bytes: TerminalBytes): void {
    if (bytes.length === 0) {
      return;
    }
    this.parsed = false;
    this.terminal.input("", true);
    this.terminal.write(bytes, this.markParsed);
    if (!this.parsed) {
      throw new Error(
        "@xterm/headless parsed a chunk asynchronously; feed() requires synchronous parsing because a drained view is only valid until the next drain",
      );
    }
    // Every non-empty chunk is presumed to change the grid. A chunk that only
    // carried a title costs one redundant repaint, which under a full-repaint
    // encoder is a screen's worth of bytes and under the real damage encoder
    // (#32) will be nothing at all.
    this.currentRevision += 1;
  }

  get size(): GridSize {
    return this.currentSize;
  }

  resize(size: GridSize): void {
    if (size.columns === this.currentSize.columns && size.rows === this.currentSize.rows) {
      return;
    }
    this.terminal.resize(size.columns, size.rows);
    // xterm clamps to 2×1. Report what it holds, not what was asked for, or the
    // negotiated PTY size and the grid quietly disagree.
    this.currentSize = { columns: this.terminal.cols, rows: this.terminal.rows };
    this.currentRevision += 1;
  }

  get revision(): number {
    return this.currentRevision;
  }

  /**
   * The placeholder encoder: correct, and dumb.
   *
   * Any mismatch — including a client claiming a revision from the future — is a
   * full repaint rather than a guess. #32 replaces this with a damage encoder,
   * and the round-trip test it has to keep passing is already written.
   */
  repaintSince(revision: number): Uint8Array {
    return revision === this.currentRevision ? EMPTY : this.fullRepaint();
  }

  /**
   * The visible screen, and only the visible screen.
   *
   * Scrollback is not part of attaching: serialising 10 000 lines costs 24 ms and
   * 662 KB against a 50 ms attach budget, for history a client can neither scroll
   * nor search yet. A reattaching client starts with an empty scrollback, as
   * tmux's does.
   */
  fullRepaint(): Uint8Array {
    return encoder.encode(FULL_RESET + this.serializer.serialize({ scrollback: 0 }));
  }

  /**
   * Plain text, with wrapped lines rejoined so a long line comes back whole.
   *
   * On the alternate screen `includeScrollback` adds nothing: that buffer has no
   * history, and the normal buffer's is not what is on screen.
   */
  snapshotText(options: { readonly includeScrollback: boolean }): string {
    const buffer = this.terminal.buffer.active;
    const from = options.includeScrollback ? 0 : buffer.baseY;
    const lines: string[] = [];
    for (let y = from; y < buffer.length; y += 1) {
      const line = buffer.getLine(y);
      if (line === undefined) {
        continue;
      }
      const text = line.translateToString(true);
      const previous = lines.length - 1;
      if (line.isWrapped && previous >= 0) {
        lines[previous] = `${lines[previous] ?? ""}${text}`;
        continue;
      }
      lines.push(text);
    }
    while (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    return lines.join("\n");
  }

  /**
   * Drops history through the parser rather than around it.
   *
   * Going through `feed` keeps this in band with whatever output is already
   * queued, and bumps the revision — a mirror that is not told the buffer changed
   * keeps rendering a scrollback the daemon no longer has.
   *
   * Known limit: on the alternate screen this trims the alternate buffer, which
   * has no history, and the normal buffer keeps its own until the program exits.
   * That matches what `CSI 3 J` means, and clearing a buffer the user cannot
   * currently see would be the surprising choice.
   */
  clearScrollback(): void {
    this.feed(CLEAR_SCROLLBACK);
  }

  dispose(): void {
    // Disposes the serialise addon too, through the addon manager.
    this.terminal.dispose();
    this.events = undefined;
  }
}

/**
 * Builds the production emulator.
 *
 * `scrollback` is bounded by the caller passing `DEFAULT_SCROLLBACK` rather than
 * being optional here, because an unbounded ring buffer is the most obvious way
 * to violate non-negotiable #9 and a default that hides it helps nobody.
 */
export function createEmulator(options: {
  readonly size: GridSize;
  readonly scrollback: number;
}): TerminalEmulating {
  return new HeadlessEmulator(options.size, options.scrollback);
}
