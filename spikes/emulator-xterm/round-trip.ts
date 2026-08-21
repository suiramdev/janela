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
process.exit(0);
