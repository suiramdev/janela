import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface UpdaterManifest {
  readonly version: string;
  readonly pub_date: string;
  readonly platforms: {
    readonly "darwin-aarch64": { readonly signature: string; readonly url: string };
  };
}

export interface UpdaterManifestInput {
  readonly version: string;
  readonly signature: string;
  readonly publishedAt: Date;
  readonly repository: string;
}

export const UPDATER_ARCHIVE = "Janela.app.tar.gz";

export const DEFAULT_REPOSITORY = "suiramdev/janela";

const BUNDLE_DIRECTORY = "src-tauri/target/release/bundle";

const SIGNATURE_PATH = `${BUNDLE_DIRECTORY}/macos/${UPDATER_ARCHIVE}.sig`;

const MANIFEST_PATH = `${BUNDLE_DIRECTORY}/latest.json`;

const USAGE =
  "usage: bun scripts/updater-manifest.ts --version <version> [--repository <owner/name>]";

export function updaterManifest(input: UpdaterManifestInput): UpdaterManifest {
  return {
    version: input.version,
    pub_date: input.publishedAt.toISOString(),
    platforms: {
      "darwin-aarch64": {
        signature: input.signature.trimEnd(),
        url: `https://github.com/${input.repository}/releases/download/v${input.version}/${UPDATER_ARCHIVE}`,
      },
    },
  };
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);

  return index === -1 ? undefined : args[index + 1];
}

function main(): void {
  const args = process.argv.slice(2);
  const version = flag(args, "--version");
  const repository = flag(args, "--repository") ?? DEFAULT_REPOSITORY;

  if (version === undefined) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }

  const desktop = new URL("../", import.meta.url).pathname;
  const signaturePath = join(desktop, SIGNATURE_PATH);

  if (!existsSync(signaturePath)) {
    process.stderr.write(
      `updater-manifest: ${signaturePath} not found — was the bundle built with createUpdaterArtifacts?\n`,
    );

    process.exit(1);
  }

  const manifest = updaterManifest({
    version,
    repository,
    signature: readFileSync(signaturePath, "utf8"),
    publishedAt: new Date(),
  });

  const manifestPath = join(desktop, MANIFEST_PATH);

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${manifestPath}\n`);
}

if (import.meta.main) main();
