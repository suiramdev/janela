/**
 * Pins `styles.css` to `@janela/design`.
 *
 * The tokens are declared in TypeScript and consumed as CSS custom properties, and
 * nothing else notices when the two disagree: a component reading an undefined
 * property paints transparent, and an appearance missing a token silently falls
 * back to the light one. These two tests are the only thing standing between that
 * and a shipped build.
 */
import { describe, expect, test } from "bun:test";

import { COLOR, CORNER_RADIUS, TERMINAL_FONT_STACK } from "@janela/design";

const source = await Bun.file(new URL("./styles.css", import.meta.url)).text();

/** The balanced-brace body that follows `header`. Throws if the header is absent. */
function block(header: string): string {
  const start = source.indexOf(header);
  if (start < 0) throw new Error(`styles.css has no \`${header}\``);

  let depth = 0;
  for (let index = start + header.length - 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`\`${header}\` in styles.css is never closed`);
}

/** `terminalBackground` → `terminal-background`. */
function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

const APPEARANCES = [
  ":root {",
  "@media (prefers-color-scheme: dark) {",
  "@media (prefers-contrast: more) {",
  "@media (prefers-color-scheme: dark) and (prefers-contrast: more) {",
];

describe("styles.css", () => {
  test("every colour token is defined for every appearance", () => {
    const missing: string[] = [];
    for (const header of APPEARANCES) {
      const body = block(header);
      for (const property of Object.values(COLOR)) {
        if (!new RegExp(`${property}:\\s*#[0-9a-f]{6};`).test(body)) {
          missing.push(`${header} ${property}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test("Tailwind's theme aliases resolve to the tokens", () => {
    const theme = block("@theme inline {");

    for (const [name, property] of Object.entries(COLOR)) {
      expect(theme).toContain(`--color-${kebab(name)}: var(${property});`);
    }
    expect(theme).toContain(`--radius-small: ${CORNER_RADIUS.small}px;`);
    expect(theme).toContain(`--radius-medium: ${CORNER_RADIUS.medium}px;`);
    expect(theme).toContain(`--font-mono: ${TERMINAL_FONT_STACK};`);
  });
});
