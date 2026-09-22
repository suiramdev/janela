import { describe, expect, test } from "bun:test";

import { UPDATER_ARCHIVE, updaterManifest } from "./updater-manifest.ts";

const PUBLISHED_AT = new Date("2026-02-03T04:05:06.000Z");

describe("updaterManifest", () => {
  test("points the one platform at the tagged release asset", () => {
    const manifest = updaterManifest({
      version: "0.1.0",
      signature: "sig",
      publishedAt: PUBLISHED_AT,
      repository: "suiramdev/janela",
    });

    expect(manifest).toEqual({
      version: "0.1.0",
      pub_date: "2026-02-03T04:05:06.000Z",
      platforms: {
        "darwin-aarch64": {
          signature: "sig",
          url: `https://github.com/suiramdev/janela/releases/download/v0.1.0/${UPDATER_ARCHIVE}`,
        },
      },
    });
  });

  test("trims the trailing newline the signer leaves in the .sig file", () => {
    const manifest = updaterManifest({
      version: "0.1.0",
      signature: "untrusted comment: signature\nRWT...\n",
      publishedAt: PUBLISHED_AT,
      repository: "o/r",
    });

    expect(manifest.platforms["darwin-aarch64"].signature).toBe(
      "untrusted comment: signature\nRWT...",
    );
  });
});
