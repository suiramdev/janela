/**
 * Builds `janelad` and places it where `tauri.conf.json`'s `externalBin` expects it.
 *
 * tauri-build copies the sidecar at *compile* time and fails if it is missing, so
 * this runs before `tauri dev`, `tauri build`, and the CI shell job. It is a copy,
 * not a symlink: the bundler needs a real file to sign.
 */
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";

const root = new URL("../../../", import.meta.url).pathname;
const desktop = new URL("../", import.meta.url).pathname;

const build = Bun.spawnSync(["bun", "run", "daemon:build"], {
  cwd: root,
  stdio: ["inherit", "inherit", "inherit"],
});
if (build.exitCode !== 0) process.exit(build.exitCode);

const host = new TextDecoder()
  .decode(Bun.spawnSync(["rustc", "-vV"]).stdout)
  .match(/^host: (\S+)$/m)?.[1];
if (host === undefined) throw new Error("rustc -vV did not report a host triple");

mkdirSync(`${desktop}src-tauri/binaries`, { recursive: true });
const target = `${desktop}src-tauri/binaries/janelad-${host}`;
copyFileSync(`${root}apps/daemon/janelad`, target);
chmodSync(target, 0o755);
