import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";

function make(cols = 80, rows = 24) {
  const t = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
  const s = new SerializeAddon();
  t.loadAddon(s);
  return { t, s };
}
const feed = (t: Terminal, data: string) => new Promise<void>(r => t.write(data, r));

function dump(t: Terminal, includeAlt = false) {
  const b = includeAlt ? t.buffer.active : t.buffer.normal;
  const out: string[] = [];
  for (let y = 0; y < t.rows; y++) {
    const line = t.buffer.active.getLine(y);
    if (!line) { out.push(""); continue; }
    let row = "";
    for (let x = 0; x < t.cols; x++) {
      const c = line.getCell(x)!;
      row += `${c.getChars() || " "}|${c.getFgColor()}/${c.getBgColor()}/${c.isBold()}${c.isInverse()} `;
    }
    out.push(row.trimEnd());
  }
  return out.join("\n") + `\n@cursor ${t.buffer.active.cursorX},${t.buffer.active.cursorY}`;
}

// ---- Case 1: coloured, cursor-positioned content
{
  const a = make();
  await feed(a.t, "\x1b[H\x1b[2J");
  await feed(a.t, "\x1b[1;31mERROR\x1b[0m plain \x1b[7minverse\x1b[0m\r\n");
  await feed(a.t, "\x1b[38;2;120;200;90mtruecolor\x1b[0m \x1b[44mbg\x1b[0m\r\n");
  await feed(a.t, "\x1b[10;40Hpositioned\r\n");
  await feed(a.t, "box: ┌───┐ ╭─╮ ✓ 中文\r\n");
  const bytes = a.s.serialize();

  const b = make();
  await feed(b.t, bytes);
  console.log("C1 serialize length:", bytes.length, "bytes");
  console.log("C1 replayed buffer identical:", dump(a.t) === dump(b.t));
}

// ---- Case 2: a full-screen TUI on the alternate screen (the attach case that matters)
{
  const a = make(100, 30);
  await feed(a.t, "\x1b[?1049h");                        // enter alt screen
  await feed(a.t, "\x1b[2J\x1b[H");
  for (let y = 1; y <= 30; y++) {
    await feed(a.t, `\x1b[${y};1H\x1b[4${y % 8}m row ${String(y).padStart(2)} \x1b[0m` + "·".repeat(40));
  }
  await feed(a.t, "\x1b[15;25H\x1b[1;97;41m [ MODAL ] \x1b[0m");
  await feed(a.t, "\x1b[30;1H\x1b[7m -- INSERT --                    \x1b[0m");
  await feed(a.t, "\x1b[5;12H");                          // leave the cursor mid-screen

  const bytes = a.s.serialize();
  const b = make(100, 30);
  await feed(b.t, bytes);
  console.log("C2 alt-screen serialize length:", bytes.length, "bytes");
  console.log("C2 alt-screen replay identical:", dump(a.t, true) === dump(b.t, true));
  console.log("C2 cursor preserved:", a.t.buffer.active.cursorX === b.t.buffer.active.cursorX && a.t.buffer.active.cursorY === b.t.buffer.active.cursorY,
              `(${a.t.buffer.active.cursorX},${a.t.buffer.active.cursorY})`);
  console.log("C2 both on alt buffer:", a.t.buffer.active.type, b.t.buffer.active.type);
}

// ---- Case 3: throughput of the daemon-side emulator under a flood
{
  const a = make(120, 40);
  const chunk = ("yes output line ".repeat(4) + "\r\n").repeat(256);   // ~68 KB
  const t0 = performance.now();
  let total = 0;
  for (let i = 0; i < 400; i++) { await feed(a.t, chunk); total += chunk.length; }
  const secs = (performance.now() - t0) / 1000;
  console.log("C3 emulator feed throughput:", (total / 1e6 / secs).toFixed(1), "MB/s");
  const t1 = performance.now();
  const s = a.s.serialize();
  console.log("C3 full-grid serialize:", (performance.now() - t1).toFixed(2), "ms for", s.length, "bytes");
}


// ---- Case 4 & 5: the damage encoder's corpus, against both receivers
//
// Case 4's receiver is `@xterm/headless`, which is what the package's own test
// uses. Case 5's is `@xterm/xterm` — the library the *client* actually renders
// with (ADR 0018 knowingly accepted that the two ends of the round trip are
// different libraries). Case 5 is the only thing in the repository that measures
// that accepted divergence, which is why it lives in a spike: `check:layers`
// gates `@xterm/xterm` to `@janela/terminal-ui`, correctly.
{
  const { HeadlessEmulator } = await import("../../packages/terminal/src/headless-emulator.ts");
  const { CORPUS } = await import("./corpus.ts");
  const { Terminal: DomTerminal } = await import("@xterm/xterm");
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  type AnyTerminal = { rows: number; cols: number; buffer: any; modes: any; parser: any; write(data: Uint8Array | string, callback?: () => void): void; resize(cols: number, rows: number): void; unicode?: any };

  function dumpCells(t: AnyTerminal) {
    const buffer = t.buffer.active;
    const out: string[] = [];
    for (let y = 0; y < t.rows; y++) {
      const line = buffer.getLine(buffer.viewportY + y);
      if (!line) { out.push(""); continue; }
      let row = "";
      for (let x = 0; x < t.cols; x++) {
        const c = line.getCell(x);
        if (!c) continue;
        row += `${c.getChars() || " "}|${c.getFgColor()}/${c.getBgColor()}/${c.isBold()}${c.isInverse()}${c.isUnderline()}${c.isDim()} `;
      }
      out.push(row.trimEnd());
    }
    return `${out.join("\n")}\n@cursor ${buffer.cursorX},${buffer.cursorY} @buffer ${buffer.type}`;
  }

  const dumpModes = (t: AnyTerminal) => JSON.stringify(t.modes);
  const escape = (s: string) => s.replaceAll("\x1b", "\\e").replaceAll("\r", "\\r").replaceAll("\n", "\\n");

  function makeReceiver(kind: "headless" | "dom", cols: number, rows: number): AnyTerminal {
    const options = { cols, rows, allowProposedApi: true, windowOptions: { setWinSizeChars: true } } as const;
    const t: AnyTerminal = kind === "headless"
      ? (new Terminal({ ...options, logLevel: "off" }) as unknown as AnyTerminal)
      : (new DomTerminal(options as any) as unknown as AnyTerminal);
    t.parser.registerCsiHandler({ final: "t" }, (p: (number | number[])[]) => {
      if (p[0] !== 8) return false;
      const r = p[1], c = p[2];
      if (typeof r === "number" && typeof c === "number") t.resize(c, r);
      return true;
    });
    return t;
  }

  const write = (t: AnyTerminal, bytes: Uint8Array) => new Promise<void>((r) => t.write(bytes, r));

  let failures = 0;
  for (const kind of ["headless", "dom"] as const) {
    const label = kind === "headless" ? "C4 @xterm/headless" : "C5 @xterm/xterm  ";
    for (const testCase of CORPUS) {
      const source = new HeadlessEmulator({ columns: testCase.columns, rows: testCase.rows }, 200);
      const target = makeReceiver(kind, testCase.columns, testCase.rows);
      if (testCase.setup) source.feed(encoder.encode(testCase.setup));
      await write(target, source.fullRepaint());
      let seen = source.revision;
      let deltaBytes = 0;
      let fullBytes = 0;
      let identical = true;
      const problems: string[] = [];
      for (const step of testCase.steps) {
        source.feed(encoder.encode(step.feed));
        const delta = source.repaintSince(seen);
        deltaBytes += delta.length;
        fullBytes += source.fullRepaint().length;
        if (!step.full && decoder.decode(delta).startsWith("\x1bc")) {
          problems.push(`step "${escape(step.feed)}" was answered with a full repaint`);
        }
        await write(target, new Uint8Array(delta));
        seen = source.revision;
        const wanted = dumpCells(source.terminal as unknown as AnyTerminal);
        const got = dumpCells(target);
        if (wanted !== got) {
          identical = false;
          const wantedRows = wanted.split("\n");
          const gotRows = got.split("\n");
          for (let i = 0; i < Math.max(wantedRows.length, gotRows.length); i++) {
            if (wantedRows[i] !== gotRows[i]) {
              problems.push(`step "${escape(step.feed)}" row ${i}:\n      source: ${wantedRows[i]}\n      target: ${gotRows[i]}`);
              break;
            }
          }
        }
        const wantedModes = dumpModes(source.terminal as unknown as AnyTerminal);
        const gotModes = dumpModes(target);
        if (wantedModes !== gotModes) {
          identical = false;
          problems.push(`step "${escape(step.feed)}" modes:\n      source: ${wantedModes}\n      target: ${gotModes}`);
        }
      }
      const unicode = target.unicode?.activeVersion ?? "n/a";
      console.log(`${label} ${testCase.name.padEnd(34)} identical: ${identical} delta: ${String(deltaBytes).padStart(6)}B full: ${String(fullBytes).padStart(6)}B unicode: ${unicode}`);
      for (const problem of problems) {
        failures += 1;
        console.log(`    ${problem}`);
      }
      source.dispose();
    }
  }
  if (failures > 0) {
    console.log(`\n${failures} divergence(s) — see above`);
    process.exit(1);
  }
  console.log("\nC4/C5: every corpus case round-tripped identically on both libraries");
}

process.exit(0);
