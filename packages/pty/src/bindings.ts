import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";

import { Data, Effect } from "effect";

import libraryPath from "../native/target/release/libjanela_pty.dylib" with { type: "file" };

export type PtyHandle = number & { readonly __brand: "PtyHandle" };

export interface NativePtyLibrary {
  jpty_spawn(
    path: Pointer,
    argv: Pointer,
    envp: Pointer,
    cwd: Pointer,
    replicaPathVariable: Pointer | null,
    columns: number,
    rows: number,
    outPid: Pointer,
  ): number;
  jpty_read(handle: number, out: Pointer, capacity: number): bigint;
  jpty_write(handle: number, data: Pointer, length: number): bigint;
  jpty_resize(
    handle: number,
    columns: number,
    rows: number,
    pixelWidth: number,
    pixelHeight: number,
  ): number;
  jpty_signal(handle: number, signal: number): number;
  jpty_exit_code(handle: number): number;
  jpty_close(handle: number): void;
  jpty_drop_all(): number;
  jpty_peer_credential(fd: number, out: Pointer, outLength: number, outPid: Pointer): bigint;
}

export interface CStringArray {
  readonly pointers: BigUint64Array;
  readonly buffers: readonly Uint8Array[];
}

export const JPTY_EXEC_FAILED_BIAS = 2000;

export const JPTY_READ_FAILED_BIAS = 3000;

export const JPTY_NO_EXIT_CODE = -2147483648;

const NATIVE_LIBRARY_BUILD_STEP = "bun run build:native";

const encoder = new TextEncoder();

export class NativeLibraryUnavailable extends Data.TaggedError("NativeLibraryUnavailable")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return `@janela/pty's native library is missing. Run \`${NATIVE_LIBRARY_BUILD_STEP}\`.`;
  }
}

const openNativeLibrary: Effect.Effect<NativePtyLibrary, NativeLibraryUnavailable> = Effect.try({
  try: () =>
    dlopen(libraryPath, {
      jpty_spawn: {
        args: [
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.u16,
          FFIType.u16,
          FFIType.ptr,
        ],
        returns: FFIType.i32,
      },
      jpty_read: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
      jpty_write: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
      jpty_resize: {
        args: [FFIType.i32, FFIType.u16, FFIType.u16, FFIType.u16, FFIType.u16],
        returns: FFIType.i32,
      },
      jpty_signal: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      jpty_exit_code: { args: [FFIType.i32], returns: FFIType.i32 },
      jpty_close: { args: [FFIType.i32], returns: FFIType.void },
      jpty_drop_all: { args: [], returns: FFIType.i32 },
      jpty_peer_credential: {
        args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.ptr],
        returns: FFIType.i64,
      },
    }).symbols,
  catch: (cause) => new NativeLibraryUnavailable({ cause }),
});

export const native: NativePtyLibrary = Effect.runSync(openNativeLibrary);

export function cString(value: string): Uint8Array {
  const encoded = encoder.encode(value);
  const bytes = new Uint8Array(encoded.length + 1);
  bytes.set(encoded);

  return bytes;
}

export function cStringArray(values: readonly string[]): CStringArray {
  const buffers = values.map(cString);
  const pointers = new BigUint64Array(values.length + 1);

  for (const [index, buffer] of buffers.entries()) {
    pointers[index] = BigInt(ptr(buffer));
  }

  pointers[values.length] = 0n;

  return { pointers, buffers };
}

export { ptr };
