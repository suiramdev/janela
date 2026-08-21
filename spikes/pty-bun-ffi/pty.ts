import { dlopen, FFIType, ptr, suffix } from "bun:ffi";

const lib = dlopen(`./native/target/release/libjanela_pty.${suffix}`, {
  jpty_spawn: { args: ["cstring","ptr","ptr","cstring","u16","u16","ptr"], returns: "i32" },
  jpty_read:  { args: ["i32","ptr","usize"], returns: "isize" },
  jpty_write: { args: ["i32","ptr","usize"], returns: "isize" },
  jpty_resize:{ args: ["i32","u16","u16","u16","u16"], returns: "i32" },
  jpty_signal:{ args: ["i32","i32"], returns: "i32" },
  jpty_exit_code: { args: ["i32"], returns: "i32" },
  jpty_close: { args: ["i32"], returns: "void" },
});

const enc = new TextEncoder();
const cstr = (s: string) => enc.encode(s + "\0");

/** Build a NULL-terminated char*[] and keep every buffer alive. */
function cstrArray(items: string[]) {
  const bufs = items.map(cstr);
  const arr = new BigUint64Array(items.length + 1);
  bufs.forEach((b, i) => { arr[i] = BigInt(ptr(b)); });
  arr[items.length] = 0n;
  return { arr, bufs };
}

export class Pty {
  handle: number;
  pid: number;
  private keepalive: unknown[] = [];
  private drainBuf = new Uint8Array(8 * 1024 * 1024);

  constructor(path: string, argv: string[], env: Record<string,string>, cwd: string, cols = 80, rows = 24) {
    const a = cstrArray(argv);
    const e = cstrArray(Object.entries(env).map(([k,v]) => `${k}=${v}`));
    const pidOut = new Int32Array(1);
    const p = cstr(path), c = cstr(cwd);
    this.keepalive.push(a, e, p, c, pidOut);
    this.handle = lib.symbols.jpty_spawn(p, ptr(a.arr), ptr(e.arr), c, cols, rows, ptr(pidOut));
    if (this.handle < 0) throw new Error(`jpty_spawn failed: errno ${-this.handle}`);
    this.pid = pidOut[0]!;
  }

  /** Drain everything buffered in one FFI call. Returns a view, or null. */
  drain(): Uint8Array | null {
    const n = lib.symbols.jpty_read(this.handle, ptr(this.drainBuf), this.drainBuf.length);
    if (n > 0) return this.drainBuf.subarray(0, Number(n));
    if (n === -1 || n === -1n) return null; // closed
    return new Uint8Array(0);
  }

  write(bytes: Uint8Array) { lib.symbols.jpty_write(this.handle, ptr(bytes), bytes.length); }
  writeText(s: string) { this.write(enc.encode(s)); }
  resize(cols: number, rows: number, xpix = 0, ypix = 0) { lib.symbols.jpty_resize(this.handle, cols, rows, xpix, ypix); }
  signal(sig: number) { lib.symbols.jpty_signal(this.handle, sig); }
  exitCode() { return lib.symbols.jpty_exit_code(this.handle); }
  close() { lib.symbols.jpty_close(this.handle); }
}
