export function byteAt(bytes: Uint8Array, index: number): number {
  const value = bytes[index];

  if (value === undefined) {
    throw new RangeError(`index ${index} out of bounds (${bytes.length})`);
  }

  return value;
}

export function readUint32BE(bytes: Uint8Array, offset: number): number {
  const signed =
    (byteAt(bytes, offset) << 24) |
    (byteAt(bytes, offset + 1) << 16) |
    (byteAt(bytes, offset + 2) << 8) |
    byteAt(bytes, offset + 3);

  return signed >>> 0;
}

export function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}
