import { describe, expect, test } from "bun:test";

import { renderToStaticMarkup } from "react-dom/server";

import { FALLBACK_ICON_NAME, PROFILE_ICON_NAMES } from "../../../shared/config/index.ts";
import { ProfileIcon } from "./profile-icon.tsx";

describe("ProfileIcon", () => {
  test("an unrecognised name falls back rather than rendering nothing", () => {
    const misspelled = renderToStaticMarkup(<ProfileIcon iconName="sparkle" />);
    const fallback = renderToStaticMarkup(<ProfileIcon iconName={FALLBACK_ICON_NAME} />);

    expect(misspelled).toContain("<svg");
    expect(misspelled).toBe(fallback);
  });

  test("a recognised name renders its own glyph, not the fallback", () => {
    const sparkles = renderToStaticMarkup(<ProfileIcon iconName="sparkles" />);
    const fallback = renderToStaticMarkup(<ProfileIcon iconName={FALLBACK_ICON_NAME} />);

    expect(sparkles).toContain("<svg");
    expect(sparkles).not.toBe(fallback);
  });

  test("the glyph is hidden from assistive technology", () => {
    expect(renderToStaticMarkup(<ProfileIcon iconName="sparkles" />)).toContain(
      'aria-hidden="true"',
    );
  });

  test("every name the grid offers renders", () => {
    for (const name of PROFILE_ICON_NAMES) {
      expect(renderToStaticMarkup(<ProfileIcon iconName={name} />)).toContain("<svg");
    }
  });
});
