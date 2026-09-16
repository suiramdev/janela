import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Schema } from "effect";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const ResolvedTaskDefinition = Schema.Struct({
  outputs: Schema.Array(Schema.String),
  dependsOn: Schema.Array(Schema.String),
});

const TurboDryRun = Schema.Struct({
  tasks: Schema.Array(
    Schema.Struct({
      taskId: Schema.String,
      resolvedTaskDefinition: Schema.optional(ResolvedTaskDefinition),
    }),
  ),
});

const DaemonManifest = Schema.Struct({
  scripts: Schema.Struct({ build: Schema.String }),
});

type ResolvedTaskDefinition = (typeof ResolvedTaskDefinition)["Type"];

function resolvedDaemonBuild(): ResolvedTaskDefinition {
  const result = Bun.spawnSync(
    ["bunx", "turbo", "run", "build", "--filter=@janela/janelad", "--dry-run=json"],
    { cwd: REPO_ROOT },
  );

  expect(result.success, `turbo --dry-run failed: ${result.stderr.toString()}`).toBe(true);

  const stdout = result.stdout.toString();

  const dryRun = Schema.decodeUnknownSync(TurboDryRun)(
    JSON.parse(stdout.slice(stdout.indexOf("{"))),
  );

  const task = dryRun.tasks.find((candidate) => candidate.taskId === "@janela/janelad#build");

  if (task === undefined) {
    throw new Error("turbo --dry-run=json does not mention @janela/janelad#build");
  }

  const definition = task.resolvedTaskDefinition;

  if (definition === undefined) {
    throw new Error("@janela/janelad#build resolved without outputs or dependsOn");
  }

  return definition;
}

describe("the daemon's turbo build task", () => {
  test("declares the sidecar the build script actually writes as its output", async () => {
    const manifest = Schema.decodeUnknownSync(DaemonManifest)(
      await Bun.file(join(REPO_ROOT, "apps/daemon/package.json")).json(),
    );

    const outfile = /--outfile\s+(\S+)/.exec(manifest.scripts.build)?.[1];

    if (outfile === undefined) {
      throw new Error("apps/daemon's build script no longer passes --outfile");
    }

    expect(resolvedDaemonBuild().outputs).toContain(outfile);
  });

  test("still inherits the root task's ordering", () => {
    expect(resolvedDaemonBuild().dependsOn).toContain("^build");
  });
});
