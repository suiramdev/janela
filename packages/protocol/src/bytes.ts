/**
 * The two-and-a-half byte operations framing needs.
 *
 * Private to this package: none of it is protocol vocabulary, and `@janela/support`
 * has no equivalent — `bounded.ts` is queues and water marks.
 *
 * A `DataView` would read the length prefix just as well, but constructing one is
 * an allocation per frame on the hot path, and this package is on both sides of
 * every repaint. These are plain indexed reads with the bounds check
 * `noUncheckedIndexedAccess` asks for, which is also the check we want.
 */

/**
 * Indexed read that satisfies `noUncheckedIndexedAccess` without `!` or `?? 0`.
 *
 * Every caller checks the length first, so a throw here is a bug in this package
 * rather than a malformed frame — which is why it is a `RangeError` and not a
 * `FrameError`: a `FrameError` closes a connection, and this one would deserve a
 * stack trace instead.
 */
export function byteAt(bytes: Uint8Array, index: number): number {
  const value = bytes[index];
  if (value === undefined) {
    throw new RangeError(`index ${index} out of bounds (${bytes.length})`);
  }
  return value;
}

/** Reads the big-endian u32 at `offset`. Requires four bytes to be there. */
export function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((byteAt(bytes, offset) << 24) |
      (byteAt(bytes, offset + 1) << 16) |
      (byteAt(bytes, offset + 2) << 8) |
      byteAt(bytes, offset + 3)) >>>
    // `>>> 0` because the shift above is signed: a length with the high bit set
    // would otherwise read as negative, which is exactly the value that skips a
    // `length > MAXIMUM_PAYLOAD_LENGTH` check.
    0
  );
}

/** Writes `value` as a big-endian u32 at `offset`. Requires four bytes of room. */
export function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}
