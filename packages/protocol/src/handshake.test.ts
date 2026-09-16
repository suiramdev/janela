import { describe, expect, test } from "bun:test";

import {
  MINIMUM_SUPPORTED_VERSION,
  PROTOCOL_VERSION,
  isCompatible,
  type Hello,
} from "./handshake.ts";

const hello = (protocolVersion: number, minimumSupported: number): Hello => ({
  protocolVersion,
  minimumSupported,
  clientName: "test",
});

describe("handshake compatibility", () => {
  const mine = hello(2, 2);

  test("identical ranges speak to each other", () => {
    expect(isCompatible(mine, hello(2, 2))).toBe(true);
  });

  test("a peer below our minimum is incompatible", () => {
    expect(isCompatible(mine, hello(1, 1))).toBe(false);
  });

  test("a newer peer that still speaks our version is compatible", () => {
    expect(isCompatible(mine, hello(3, 2))).toBe(true);
  });

  test("a newer peer that has dropped our version is incompatible", () => {
    expect(isCompatible(mine, hello(3, 3))).toBe(false);
  });

  test("the answer does not depend on which side asks", () => {
    for (const other of [hello(2, 2), hello(1, 1), hello(3, 2), hello(3, 3), hello(5, 1)]) {
      expect(isCompatible(mine, other)).toBe(isCompatible(other, mine));
    }
  });

  test("the shipped range is self-compatible, so two current peers connect", () => {
    const current = hello(PROTOCOL_VERSION, MINIMUM_SUPPORTED_VERSION);

    expect(isCompatible(current, current)).toBe(true);
  });
});
