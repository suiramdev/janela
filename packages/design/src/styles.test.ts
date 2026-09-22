import { describe, expect, test } from "bun:test";

import {
  COLOR,
  CORNER_RADIUS,
  spring,
  surfaceClasses,
  TERMINAL_FONT_STACK,
  TERMINAL_SYMBOL_FONT,
} from "./index.ts";

const source = await Bun.file(new URL("./styles.css", import.meta.url)).text();

const APPEARANCES = [
  ":root {",
  "@media (prefers-color-scheme: dark) {",
  "@media (prefers-contrast: more) {",
  "@media (prefers-color-scheme: dark) and (prefers-contrast: more) {",
];

const MATCHING_BLOCKS: readonly (readonly number[])[] = [[0], [0, 1], [0, 2], [0, 1, 2, 3]];

function block(header: string, from = 0): string {
  const start = source.indexOf(header, from);

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

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function resolved(property: string, appearance: number): string {
  let value: string | null = null;

  for (const index of MATCHING_BLOCKS[appearance] ?? []) {
    const header = APPEARANCES[index];

    if (header === undefined) continue;

    const declaration = new RegExp(`${property}:\\s*([^;]+);`).exec(block(header));

    if (declaration?.[1] !== undefined) value = declaration[1].trim();
  }

  if (value === null) throw new Error(`no appearance declares ${property} for ${appearance}`);

  return value;
}

function alphaOf(value: string): number {
  const alpha = /\/\s*([\d.]+)%/.exec(value);

  if (!alpha?.[1]) throw new Error(`${value} has no percentage alpha`);

  return Number(alpha[1]) / 100;
}

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

    const mono = /--font-mono:\s*([^;]+);/.exec(theme)?.[1];

    expect(mono?.replace(/\s+/gu, " ")).toBe(TERMINAL_FONT_STACK);
  });

  test("the symbol font the stack names is bundled and declared", async () => {
    const face = block("@font-face {");

    expect(face).toContain(`font-family: "${TERMINAL_SYMBOL_FONT}";`);
    expect(TERMINAL_FONT_STACK).toContain(`"${TERMINAL_SYMBOL_FONT}"`);

    const asset = /url\("([^"]+)"\)/u.exec(face)?.[1];

    expect(asset).toBeDefined();
    expect(await Bun.file(new URL(asset ?? "", import.meta.url)).exists()).toBe(true);
  });

  test("the CSS motion ladder is the spring ladder, in milliseconds", () => {
    const root = block(":root {");

    for (const [tier, value] of Object.entries(spring)) {
      expect(root).toContain(`--spring-${tier}: ${Math.round(value.duration * 1000)}ms;`);
      expect(root).toContain(`--spring-${tier}-exit: ${Math.round(value.exit.duration * 1000)}ms;`);
    }
  });

  test("every surface level the ladder can name resolves to a token", () => {
    const theme = block("@theme inline {");
    const root = block(":root {");
    const dark = block("@media (prefers-color-scheme: dark) {");

    for (let level = 1; level <= 8; level += 1) {
      const [background, shadow] = surfaceClasses(level).split(" ");

      expect(theme).toContain(
        `--color-${background?.slice("bg-".length)}: var(--surface-${level});`,
      );

      expect(theme).toContain(`--${shadow}: var(--shadow-${level});`);

      for (const body of [root, dark]) {
        expect(body).toMatch(new RegExp(`--surface-${level}:\\s*\\S`));
        expect(body).toMatch(new RegExp(`--shadow-${level}:\\s*\\S`));
      }
    }
  });

  test("each shadow keeps every layer of the one below it", () => {
    for (const appearance of [":root {", "@media (prefers-color-scheme: dark) {"]) {
      const body = block(appearance);

      const drops = (level: number): readonly string[] => {
        const declaration = new RegExp(`--shadow-${level}:([^;]*);`).exec(body);

        expect(declaration).not.toBeNull();

        return [...(declaration?.[1] ?? "").matchAll(/(\d+px \d+px -[\d.]+px)/g)].map(
          (match) => match[1] ?? "",
        );
      };

      for (let level = 3; level <= 8; level += 1) {
        const below = drops(level - 1);

        expect(drops(level)).toEqual([...below, expect.any(String)]);
      }
    }
  });

  test("the interaction ladder is defined for every appearance", () => {
    for (const header of APPEARANCES) {
      const body = block(header);

      for (const token of ["--hover", "--active", "--selected"]) {
        expect(body).toMatch(new RegExp(`${token}:\\s*\\S`));
      }
    }
  });

  test("the scrollbar's ink is a triplet each appearance flips", () => {
    for (const header of [":root {", "@media (prefers-color-scheme: dark) {"]) {
      expect(block(header)).toMatch(/--overlay:\s*\d{1,3} \d{1,3} \d{1,3};/);
    }
  });

  test("the scrim dims equally in both appearances, and more under Increase Contrast", () => {
    const [light, dark, contrast, darkContrast] = APPEARANCES.map((_, index) =>
      alphaOf(resolved("--scrim", index)),
    ) as [number, number, number, number];

    expect(dark).toBe(light);
    expect(darkContrast).toBe(contrast);
    expect(contrast).toBeGreaterThan(light);
    expect(Math.max(light, contrast)).toBeLessThanOrEqual(0.6);
  });

  test("the scroll-fade defaults are layered, so a utility can retune them", () => {
    const base = block("@layer base {", source.indexOf("@layer base {") + 1);

    expect(base).toContain(".scroll-fade,");
    expect(base).toContain("--scroll-fade-size: 48px;");
    expect(base).toContain("@media (pointer: fine) {");
  });
});
