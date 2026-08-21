// Can `bun build --compile` embed a .dylib and can we dlopen it at runtime?
import { dlopen, FFIType, ptr, suffix } from "bun:ffi";
import libFile from "./libjanela_pty.dylib" with { type: "file" };

const lib = dlopen(libFile, {
  jpty_spawn: { args: ["cstring","ptr","ptr","cstring","u16","u16","ptr"], returns: "i32" },
  jpty_read:  { args: ["i32","ptr","usize"], returns: "isize" },
  jpty_write: { args: ["i32","ptr","usize"], returns: "isize" },
  jpty_close: { args: ["i32"], returns: "void" },
});
const enc = new TextEncoder();
const cstr = (s: string) => enc.encode(s + "\0");
function cstrArray(items: string[]) {
  const bufs = items.map(cstr);
  const arr = new BigUint64Array(items.length + 1);
  bufs.forEach((b, i) => { arr[i] = BigInt(ptr(b)); });
  return { arr, bufs };
}
console.log("resolved dylib path:", libFile);
const a = cstrArray(["zsh","-fc","echo EMBEDDED_PTY_$((6*7))"]);
const e = cstrArray(["TERM=xterm-256color","PATH=/usr/bin:/bin"]);
const pid = new Int32Array(1);
const path = cstr("/bin/zsh"), cwd = cstr("/tmp");
const h = lib.symbols.jpty_spawn(path, ptr(a.arr), ptr(e.arr), cwd, 80, 24, ptr(pid));
if (h < 0) { console.log("spawn failed", h); process.exit(1); }
const buf = new Uint8Array(65536);
let acc = "";
for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 50));
  const n = Number(lib.symbols.jpty_read(h, ptr(buf), buf.length));
  if (n > 0) acc += new TextDecoder().decode(buf.subarray(0, n));
  if (/EMBEDDED_PTY_42/.test(acc)) break;
}
console.log("COMPILED BINARY PTY WORKS:", /EMBEDDED_PTY_42/.test(acc));
lib.symbols.jpty_close(h);
process.exit(0);
