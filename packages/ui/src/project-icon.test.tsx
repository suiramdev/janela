import { describe, expect, test } from "bun:test";

import { absolutePath } from "@janela/core";
import { renderToStaticMarkup } from "react-dom/server";

import { ProjectIcon } from "./project-icon.tsx";

const janela = { name: "janela", directory: absolutePath("/repos/janela") };
/** The same project, renamed. */
const renamed = { name: "renamed", directory: janela.directory };
/** The same repository, cloned somewhere else. */
const elsewhere = { name: "janela", directory: absolutePath("/work/janela") };

describe("ProjectIcon", () => {
  test("the generated avatar is seeded from the directory, not the name", () => {
    // Same picture after a rename: the seed is what a project *is*, and the one
    // moment a user most needs to recognise a row is the moment they renamed it.
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

    // `DitherAvatar` labels itself with its seed, and the seed is a filesystem
    // path. Every row would read one out.
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("/repos/janela avatar");
    expect(markup).toContain("<canvas");
  });

  test("a custom image is offered to the avatar, with the generated one behind it", () => {
    const markup = renderToStaticMarkup(
      <ProjectIcon project={janela} imageSource="https://github.com/favicon.ico" />,
    );

    // Base UI resolves an `Avatar.Image` against its load status, which is a
    // client-only concern: on the server only the fallback is emitted. What this
    // pins is that offering an image does not *remove* the fallback — an icon
    // that 404s degrades to the generated one rather than leaving a hole. The
    // rendered `img` is verified in a browser, not here.
    expect(markup).toContain("<canvas");
    expect(markup).toContain('data-slot="avatar-fallback"');
  });
});
