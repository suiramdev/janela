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

import { COLOR, CORNER_RADIUS, spring, surfaceClasses, TERMINAL_FONT_STACK } from "@janela/design";

const source = await Bun.file(new URL("./styles.css", import.meta.url)).text();

/**
 * The balanced-brace body that follows `header`, searching from `from`. Throws if
 * the header is absent. `from` is how a caller reaches the *second* block with a
 * given header — the file has two `@layer base`.
 */
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

  test("the CSS motion ladder is the spring ladder, in milliseconds", () => {
    const root = block(":root {");

    // A `duration-(--spring-moderate)` transition and a `spring.moderate`
    // animation are the same decision, so re-tiering one and not the other is
    // the drift this catches. The springs are the source; these are derived.
    for (const [tier, value] of Object.entries(spring)) {
      expect(root).toContain(`--spring-${tier}: ${Math.round(value.duration * 1000)}ms;`);
      expect(root).toContain(`--spring-${tier}-exit: ${Math.round(value.exit.duration * 1000)}ms;`);
    }
  });

  test("every surface level the ladder can name resolves to a token", () => {
    // `surfaceClasses` is the source: it hands out `bg-surface-N shadow-surface-N`
    // as literal strings, and a level whose token is missing paints *transparent*
    // — which, since the window itself is level 1, is a black-on-black window
    // rather than an obvious mistake. The dark block must redefine all eight:
    // inheriting the light ladder would light the whole window.
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
    // A ladder, not eight unrelated shadows: `shadow-5` is `shadow-4` plus one
    // more, further, softer drop. That is what makes a dialog read as *further*
    // from the page than a menu rather than merely different, and it is the part
    // that is easy to lose by hand — the dark ladder once carried a single drop
    // per level, so level 7 cast less than level 3 did.
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
    // `bg-hover` is painted by the sidebar's travelling highlight *and* by rows
    // that draw their own hover, so an appearance missing it makes one of the two
    // invisible — the kind of half-broken state nothing else catches.
    for (const header of APPEARANCES) {
      const body = block(header);
      for (const token of ["--hover", "--active", "--selected"]) {
        expect(body).toMatch(new RegExp(`${token}:\\s*\\S`));
      }
    }
  });

  test("the scrollbar's ink is a triplet each appearance flips", () => {
    // The thumb composes this at three opacities (`rgb(var(--overlay) / 0.08)`),
    // so it has to be `R G B` and not a colour: a missing or `oklch()` value
    // makes the declaration invalid and the thumb *invisible*, in a component
    // whose whole point is a scrollbar you can still find. Light inks black,
    // dark inks white; Increase Contrast inherits, because contrast does not
    // change which way the overlay tints.
    for (const header of [":root {", "@media (prefers-color-scheme: dark) {"]) {
      expect(block(header)).toMatch(/--overlay:\s*\d{1,3} \d{1,3} \d{1,3};/);
    }
  });

  test("the scroll-fade defaults are layered, so a utility can retune them", () => {
    // A 48px fade is two rows of a 28px list, so the quick list and the tab strip
    // both pass `[--scroll-fade-size:…]`. An unlayered rule would beat every one
    // of those utilities on source order alone, and the override would be
    // silently ignored — nothing about the page would look broken, it would just
    // fade far too much.
    // The *second* `@layer base` in the file: the first is the border/font reset.
    const base = block("@layer base {", source.indexOf("@layer base {") + 1);

    expect(base).toContain(".scroll-fade,");
    expect(base).toContain("--scroll-fade-size: 48px;");
    expect(base).toContain("@media (pointer: fine) {");
  });
});
