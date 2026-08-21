setTimeout(() => { console.log("WATCHDOG FIRED"); process.exit(3); }, 25000);
import { Pty } from "./pty";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const dec = new TextDecoder("utf-8");
const env = { TERM: "xterm-256color", PATH: "/usr/bin:/bin", PS1: "> ", HOME: "/tmp" };

// ---- Ctrl-C: written as a byte, interpreted by the tty line discipline.
// This is how a real terminal does it, and it is the only way that respects the
// foreground process group. Proves the child really has a controlling terminal.
{
  const p = new Pty("/bin/zsh", ["zsh", "-f"], env, "/tmp", 80, 24);
  let acc = "";
  const t = setInterval(() => { const d = p.drain(); if (d?.length) acc += dec.decode(d, { stream: true }); }, 8);
  await sleep(400);
  p.writeText("sleep 300; echo INTERRUPTED_OK\n");
  await sleep(600);
  p.write(new Uint8Array([0x03]));           // Ctrl-C
  await sleep(800);
  clearInterval(t);
  console.log("T6 Ctrl-C interrupted foreground job:", /INTERRUPTED_OK/.test(acc));
  p.close();
}

// ---- Exit codes must survive. If the host runtime reaps our children first,
// TerminalState.exited(code:) is unimplementable.
{
  for (const [cmd, want] of [["exit 0", 0], ["exit 7", 7], ["kill -TERM $$", 143]] as const) {
    const p = new Pty("/bin/zsh", ["zsh", "-fc", cmd], env, "/tmp", 80, 24);
    const t = setInterval(() => p.drain(), 8);
    let code = -2147483648;
    for (let i = 0; i < 60 && code === -2147483648; i++) { await sleep(50); code = p.exitCode(); }
    clearInterval(t);
    console.log(`T7 '${cmd}' -> exit code ${code} (expected ${want})`, code === want ? "OK" : "MISMATCH");
    p.close();
  }
}

// ---- Teardown kills the whole session, including grandchildren without job control.
{
  const p = new Pty("/bin/zsh", ["zsh", "-fc", "set +m; sleep 300 & echo GC=$!; wait"], env, "/tmp", 80, 24);
  let acc = "";
  const t = setInterval(() => { const d = p.drain(); if (d?.length) acc += dec.decode(d, {stream:true}); }, 8);
  await sleep(700);
  const gc = Number(/GC=(\d+)/.exec(acc)?.[1]);
  p.close();                                  // SIGHUP to the process group
  await sleep(800);
  clearInterval(t);
  let alive = true; try { process.kill(gc, 0); } catch { alive = false; }
  console.log("T8 grandchild pid", gc, "killed by teardown SIGHUP:", !alive);
}
process.exit(0);
