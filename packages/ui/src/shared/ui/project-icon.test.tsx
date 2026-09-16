import { describe, expect, test } from "bun:test";

import { absolutePath } from "@janela/core";
import { renderToStaticMarkup } from "react-dom/server";

import { ProjectIcon } from "./project-icon.tsx";

const janela = { name: "janela", directory: absolutePath("/repos/janela") };

const renamed = { name: "renamed", directory: janela.directory };

const elsewhere = { name: "janela", directory: absolutePath("/work/janela") };

describe("ProjectIcon", () => {
  test("the generated avatar is seeded from the directory, not the name", () => {
    expect(renderToStaticMarkup(<ProjectIcon project={renamed} />)).toBe(
      renderToStaticMarkup(<ProjectIcon project={janela} />),
    );
  });

  test("two clones of one repository in two places look different", () => {
    expect(renderToStaticMarkup(<ProjectIcon project={elsewhere} />)).not.toBe(
      renderToStaticMarkup(<ProjectIcon project={janela} />),
    );
  });

  test("the whole icon is decorative: the directory is never announced", () => {
    const markup = renderToStaticMarkup(<ProjectIcon project={janela} />);

    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("/repos/janela avatar");
    expect(markup).toContain("<canvas");
  });

  test("a custom image is offered to the avatar, with the generated one behind it", () => {
    const markup = renderToStaticMarkup(
      <ProjectIcon project={janela} imageSource="https://github.com/favicon.ico" />,
    );

    expect(markup).toContain("<canvas");
    expect(markup).toContain('data-slot="avatar-fallback"');
  });
});
