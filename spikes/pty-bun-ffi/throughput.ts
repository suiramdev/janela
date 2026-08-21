import { Pty } from "./pty";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const dec = new TextDecoder("utf-8");

// ---- Test 1: real controlling terminal + login shell
{
  const p = new Pty("/bin/zsh", ["-zsh"], { TERM: "xterm-256color", HOME: process.env.HOME!, PATH: process.env.PATH! }, process.env.HOME!);
  let acc = "";
  const t = setInterval(() => { const d = p.drain(); if (d?.length) acc += dec.decode(d, { stream: true }); }, 8);
  await sleep(700);
  p.writeText("tty; echo COLS=$(tput cols); echo SUM=$((6*7))\r");
  await sleep(900);
  p.resize(120, 40);
  p.writeText("echo AFTER=$(tput cols)x$(tput lines)\r");
  await sleep(900);
  clearInterval(t);
  console.log("T1 ctty:      ", /\/dev\/ttys\d+/.test(acc));
  console.log("T1 login shell:", /SUM=42/.test(acc));
  console.log("T1 initial size:", /COLS=80/.test(acc));
  console.log("T1 SIGWINCH:  ", /AFTER=120x40/.test(acc));
  p.signal(1); p.close();
}
import { Pty } from "./pty";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---- Test 2: `yes` flood. Throughput, and that nothing else starves.
{
  const p = new Pty("/usr/bin/yes", ["yes"], { TERM: "xterm-256color", PATH: "/usr/bin:/bin" }, "/tmp", 80, 24);
  let bytes = 0, drains = 0, maxDrain = 0;
  // A second, interactive PTY that must stay responsive during the flood.
  const q = new Pty("/bin/sh", ["sh"], { TERM: "xterm-256color", PATH: "/usr/bin:/bin", PS1: "" }, "/tmp", 80, 24);
  let qAcc = "";
  const dec = new TextDecoder();

  // Event-loop health: how late does an 8 ms timer actually fire?
  let worstLagMs = 0, last = performance.now();

  const t = setInterval(() => {
    const now = performance.now();
    worstLagMs = Math.max(worstLagMs, now - last - 8);
    last = now;
    const d = p.drain();
    if (d && d.length) { bytes += d.length; drains++; maxDrain = Math.max(maxDrain, d.length); }
    const e = q.drain();
    if (e && e.length) qAcc += dec.decode(e, { stream: true });
  }, 8);

  const t0 = performance.now();
  await sleep(300);                       // let it get going
  q.writeText("echo RESPONSIVE_$((6*7))\n");
  await sleep(2700);
  const elapsed = (performance.now() - t0) / 1000;
  clearInterval(t);

  console.log("T2 MB read:        ", (bytes / 1e6).toFixed(1));
  console.log("T2 MB/s:           ", (bytes / 1e6 / elapsed).toFixed(1));
  console.log("T2 drain calls:    ", drains, "(largest drain:", (maxDrain/1e6).toFixed(2), "MB)");
  console.log("T2 worst timer lag:", worstLagMs.toFixed(1), "ms");
  console.log("T2 neighbour responsive during flood:", /RESPONSIVE_42/.test(qAcc));

  // Back-pressure: stop draining and confirm memory does not grow without bound.
  const rssBefore = process.memoryUsage.rss();
  await sleep(1500);                      // no drains at all for 1.5 s
  const rssAfter = process.memoryUsage.rss();
  console.log("T2 RSS growth while not draining:", ((rssAfter - rssBefore)/1e6).toFixed(1), "MB (ring cap is 4 MB)");

  p.signal(9); p.close(); q.signal(9); q.close();
}
