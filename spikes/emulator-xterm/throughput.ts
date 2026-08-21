import { Terminal } from "@xterm/headless";
const feed = (t: Terminal, d: string | Uint8Array) => new Promise<void>(r => t.write(d as any, r));

for (const [label, chunkKB] of [["8 KB chunks", 8], ["64 KB chunks", 64], ["1 MB chunks", 1024]] as const) {
  const t = new Terminal({ cols: 120, rows: 40, allowProposedApi: true, scrollback: 1000 });
  const line = "y".repeat(78) + "\r\n";
  const chunk = line.repeat(Math.floor(chunkKB * 1024 / line.length));
  const bytes = new TextEncoder().encode(chunk);
  const rounds = Math.max(1, Math.floor(64 * 1024 * 1024 / bytes.length));
  const t0 = performance.now();
  for (let i = 0; i < rounds; i++) await feed(t, bytes);
  const secs = (performance.now() - t0) / 1000;
  const mb = (bytes.length * rounds) / 1e6;
  console.log(`${label.padEnd(13)} ${mb.toFixed(0)} MB in ${secs.toFixed(2)}s = ${(mb/secs).toFixed(1)} MB/s`);
}

// Escape-sequence-heavy payload: the realistic worst case (a TUI redrawing).
{
  const t = new Terminal({ cols: 120, rows: 40, allowProposedApi: true, scrollback: 1000 });
  let s = "";
  for (let y = 1; y <= 40; y++) s += `\x1b[${y};1H\x1b[3${y%8};4${(y+3)%8}m` + "▒".repeat(100) + "\x1b[0m";
  const bytes = new TextEncoder().encode(s);
  const rounds = Math.floor(32 * 1024 * 1024 / bytes.length);
  const t0 = performance.now();
  for (let i = 0; i < rounds; i++) await feed(t, bytes);
  const secs = (performance.now() - t0) / 1000;
  const mb = (bytes.length * rounds) / 1e6;
  console.log(`SGR-heavy     ${mb.toFixed(0)} MB in ${secs.toFixed(2)}s = ${(mb/secs).toFixed(1)} MB/s (${(rounds/secs).toFixed(0)} full 120x40 repaints/s)`);
}
process.exit(0);
