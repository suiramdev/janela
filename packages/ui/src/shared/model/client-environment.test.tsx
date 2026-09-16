import { describe, expect, test } from "bun:test";

import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { useClientEnvironment } from "./client-environment.tsx";

function Consumer(): ReactElement {
  useClientEnvironment();

  return <span />;
}

describe("useClientEnvironment", () => {
  test("a view rendered outside the provider says what is missing", () => {
    expect(() => renderToStaticMarkup(<Consumer />)).toThrow(/ClientEnvironmentProvider/);
  });
});
