import { isWebURL } from "@janela/core";

import type { ExternalLinks } from "../../model/index.ts";

export function browserLinks(): ExternalLinks {
  return {
    open(url: string): Promise<void> {
      if (isWebURL(url)) window.open(url, "_blank", "noopener,noreferrer");

      return Promise.resolve();
    },
  };
}
