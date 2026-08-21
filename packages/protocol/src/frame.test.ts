import { describe, expect, test } from "bun:test";

import { FRAME_HEADER_LENGTH, FrameKind, MAXIMUM_PAYLOAD_LENGTH } from "./frame.ts";
import { MINIMUM_SUPPORTED_VERSION, PROTOCOL_VERSION } from "./handshake.ts";

describe("framing bounds", () => {
  test("an unbounded length prefix is a memory-exhaustion bug waiting for a bad packet", () => {
    expect(MAXIMUM_PAYLOAD_LENGTH).toBe(8 * 1024 * 1024);
  });

  test("header is length u32 plus kind u8", () => {
    expect(FRAME_HEADER_LENGTH).toBe(5);
  });

  test("exactly three frame kinds; a fourth high-frequency one needs an argument", () => {
    expect(Object.keys(FrameKind)).toEqual(["Control", "Input", "Output"]);
  });
});

describe("protocol versioning", () => {
  test("there is no minor version: a change is compatible or it is not", () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(MINIMUM_SUPPORTED_VERSION).toBeLessThanOrEqual(PROTOCOL_VERSION);
  });
});
