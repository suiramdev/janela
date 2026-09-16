import { describe, expect, test } from "bun:test";

import { dockEdge } from "./pane-drag.ts";

const BOX = { left: 100, top: 50, width: 200, height: 100 };

describe("dockEdge", () => {
  test("the nearest edge wins, measured in the pane's own proportions", () => {
    expect(dockEdge({ x: 110, y: 100 }, BOX)).toBe("left");
    expect(dockEdge({ x: 290, y: 100 }, BOX)).toBe("right");
    expect(dockEdge({ x: 200, y: 55 }, BOX)).toBe("top");
    expect(dockEdge({ x: 200, y: 145 }, BOX)).toBe("bottom");
  });

  test("a wide pane's top and bottom are closer than its sides at the quadrant centres", () => {
    expect(dockEdge({ x: 150, y: 60 }, BOX)).toBe("top");
    expect(dockEdge({ x: 250, y: 140 }, BOX)).toBe("bottom");
    expect(dockEdge({ x: 120, y: 100 }, BOX)).toBe("left");
    expect(dockEdge({ x: 280, y: 100 }, BOX)).toBe("right");
  });

  test("ties resolve left, then right, then top, and a degenerate box is left", () => {
    expect(dockEdge({ x: 200, y: 100 }, BOX)).toBe("left");
    expect(dockEdge({ x: 150, y: 100 }, { ...BOX, height: 200 })).toBe("left");
    expect(dockEdge({ x: 0, y: 0 }, { left: 0, top: 0, width: 0, height: 0 })).toBe("left");
  });
});
