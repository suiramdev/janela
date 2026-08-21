// The whole daemon in miniature, as ONE compiled binary:
// PTY (Rust cdylib via bun:ffi) -> headless emulator -> serialize-for-attach,
// plus Prisma/SQLite persistence. Nothing outside this file, no node_modules.
import { dlopen, ptr } from "bun:ffi";
import dylib from "./libjanela_pty.dylib" with { type: "file" };
import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { PrismaBunSqlite } from "prisma-adapter-bun-sqlite";
import { PrismaClient } from "./generated/prisma/client";

const lib = dlopen(dylib, {
  jpty_spawn: { args: ["cstring","ptr","ptr","cstring","u16","u16","ptr"], returns: "i32" },
  jpty_read:  { args: ["i32","ptr","usize"], returns: "isize" },
  jpty_write: { args: ["i32","ptr","usize"], returns: "isize" },
  jpty_close: { args: ["i32"], returns: "void" },
});
const enc = new TextEncoder();
const cstr = (s: string) => enc.encode(s + "\0");
const arr = (items: string[]) => { const b = items.map(cstr); const a = new BigUint64Array(items.length+1);
  b.forEach((x,i) => a[i] = BigInt(ptr(x))); return { a, b }; };

// --- 1. a real terminal
const argv = arr(["zsh","-f"]);
const envp = arr(["TERM=xterm-256color","PATH=/usr/bin:/bin","PS1=$ "]);
const pidOut = new Int32Array(1);
const h = lib.symbols.jpty_spawn(cstr("/bin/zsh"), ptr(argv.a), ptr(envp.a), cstr("/tmp"), 100, 30, ptr(pidOut));
if (h < 0) throw new Error("spawn failed " + h);

// --- 2. the authoritative grid, daemon-side
const term = new Terminal({ cols: 100, rows: 30, allowProposedApi: true, scrollback: 1000 });
const ser = new SerializeAddon();
term.loadAddon(ser);

const drainBuf = new Uint8Array(4 * 1024 * 1024);
const pump = setInterval(() => {
  const n = Number(lib.symbols.jpty_read(h, ptr(drainBuf), drainBuf.length));
  if (n > 0) term.write(drainBuf.slice(0, n));      // one coalesced write per frame
}, 8);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const write = (s: string) => { const b = enc.encode(s); lib.symbols.jpty_write(h, ptr(b), b.length); };

await sleep(400);
write("printf '\\033[1;32mgreen\\033[0m plain\\n'; printf '\\033[10;20Hpositioned\\n'\n");
await sleep(900);
clearInterval(pump);

// --- 3. attach: the same encoder run over the whole grid
const repaint = ser.serialize();
const replica = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
await new Promise<void>(r => replica.write(repaint, r));
const row = (t: Terminal, y: number) => t.buffer.active.getLine(y)?.translateToString(true) ?? "";
let identical = true;
for (let y = 0; y < 30; y++) if (row(term, y) !== row(replica, y)) identical = false;

// --- 4. persistence
const prisma = new PrismaClient({ adapter: new PrismaBunSqlite({ url: "file:janela.sqlite" }) });
const now = new Date();
await prisma.session.deleteMany();
await prisma.session.create({ data: { id: "s-live", name: "spike", directory: "/tmp",
  backingKind: "folder", layout: "{}", position: 0, createdAt: now, lastActiveAt: now } });
const count = await prisma.session.count();

console.log("pty pid:              ", pidOut[0]);
console.log("emulator saw output:  ", /green plain/.test(row(term, 1)) || /green plain/.test(row(term, 2)));
console.log("attach repaint bytes: ", repaint.length);
console.log("attach grid identical:", identical);
console.log("sessions persisted:   ", count);
console.log("SINGLE-BINARY DAEMON OK");
lib.symbols.jpty_close(h);
process.exit(0);
