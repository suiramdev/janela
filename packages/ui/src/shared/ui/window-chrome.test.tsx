import { describe, expect, test } from "bun:test";

import { Elevated, useSurface } from "@janela/design";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ContentCard } from "./window-chrome.tsx";

function Substrate(): ReactElement {
  return <span data-substrate={String(useSurface())} />;
}

describe("ContentCard", () => {
  test("the card is a step above the window, and says so to what it holds", () => {
    const markup = renderToStaticMarkup(
      <ContentCard>
        <Substrate />
      </ContentCard>,
    );

    expect(markup).toContain("bg-surface-2");
    expect(markup).toContain("shadow-surface-2");
    expect(markup).toContain('data-substrate="2"');
  });

  test("a surface inside the card climbs from the card, and stops at the top", () => {
    const markup = renderToStaticMarkup(
      <ContentCard>
        <Elevated offset={4}>
          <Elevated offset={4}>
            <Substrate />
          </Elevated>
        </Elevated>
      </ContentCard>,
    );

    expect(markup).toContain("bg-surface-6");
    expect(markup).toContain("bg-surface-8");
    expect(markup).toContain('data-substrate="8"');
  });
});
