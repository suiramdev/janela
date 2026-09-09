import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The daemon's build does not write to `dist/`.
 *
 * `bun build --compile --outfile janelad` writes the sidecar beside
 * `package.json`, so the root `build` task's `outputs: ["dist/**"]` caches
 * nothing: a cache *hit* replays the logs, restores no binary, and
 * `apps/desktop/scripts/sidecar.ts` then fails at `copyFileSync` with `ENOENT`
 * (issue #48). `apps/daemon/turbo.json` declares the real output; these tests ask
 * turbo what it resolved, so the config and the build script cannot drift apart
 * silently.
 */
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

interface TurboDryRun {
  readonly tasks: readonly {
    readonly taskId: string;
    readonly resolvedTaskDefinition?: {
      readonly outputs: readonly string[];
      readonly dependsOn: readonly string[];
    };
  }[];
}

function resolvedDaemonBuild(): NonNullable<
  TurboDryRun["tasks"][number]["resolvedTaskDefinition"]
> {
  const result = Bun.spawnSync(
    ["bunx", "turbo", "run", "build", "--filter=@janela/janelad", "--dry-run=json"],
    { cwd: REPO_ROOT },
  );
  expect(result.success, `turbo --dry-run failed: ${result.stderr.toString()}`).toBe(true);

  const stdout = result.stdout.toString();
  // Turbo's documented --dry-run=json shape. Every field read below is checked.
  const dryRun = JSON.parse(stdout.slice(stdout.indexOf("{"))) as TurboDryRun;
  if (!Array.isArray(dryRun.tasks)) throw new Error("turbo --dry-run=json has no `tasks` array");

  const task = dryRun.tasks.find((candidate) => candidate.taskId === "@janela/janelad#build");
  if (task === undefined) {
    throw new Error("turbo --dry-run=json does not mention @janela/janelad#build");
  }

  const definition = task.resolvedTaskDefinition;
  if (
    definition === undefined ||
    !Array.isArray(definition.outputs) ||
    !Array.isArray(definition.dependsOn)
  ) {
    throw new Error("@janela/janelad#build resolved without outputs or dependsOn");
  }
  return definition;
}

describe("the daemon's turbo build task", () => {
  test("declares the sidecar the build script actually writes as its output", async () => {
    const manifest = (await Bun.file(join(REPO_ROOT, "apps/daemon/package.json")).json()) as {
      readonly scripts?: { readonly build?: unknown };
    };
    const build = manifest.scripts?.build;
    if (typeof build !== "string") throw new Error("apps/daemon has no `build` script");

    const outfile = /--outfile\s+(\S+)/.exec(build)?.[1];
    if (outfile === undefined) {
      throw new Error("apps/daemon's build script no longer passes --outfile");
    }

    expect(resolvedDaemonBuild().outputs).toContain(outfile);
  });

  test("still inherits the root task's ordering", () => {
    // A root-level `@janela/janelad#build` entry would overwrite the base task
    // rather than extend it, dropping `dependsOn` and letting the daemon build
    // race the native library and the generated Prisma client.
    expect(resolvedDaemonBuild().dependsOn).toContain("^build");
  });
});
