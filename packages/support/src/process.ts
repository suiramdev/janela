import { spawn } from "node:child_process";
import { access, constants, stat } from "node:fs/promises";
import { join } from "node:path";

import { Effect } from "effect";

export interface ProcessRequest {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface ProcessOutcome {
  readonly standardOutput: string;
  readonly standardError: string;
  readonly exitCode: number;
  readonly succeeded: boolean;
  readonly timedOut: boolean;
}

export interface ProcessRunning {
  run(request: ProcessRequest): Promise<ProcessOutcome>;
  which(executable: string, path: string): Promise<string | undefined>;
}

export function processRunner(): ProcessRunning {
  return {
    run(request: ProcessRequest): Promise<ProcessOutcome> {
      return new Promise<ProcessOutcome>((resolve, reject) => {
        const child = spawn(request.executable, [...request.arguments], {
          cwd: request.workingDirectory,
          env: request.environment ?? {},
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
        });

        const standardOutput: Buffer[] = [];
        const standardError: Buffer[] = [];

        child.stdout?.on("data", (chunk: Buffer) => standardOutput.push(chunk));
        child.stderr?.on("data", (chunk: Buffer) => standardError.push(chunk));

        let timedOut = false;
        const timer =
          request.timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                timedOut = true;
                child.kill("SIGKILL");
              }, request.timeoutMs);

        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });

        child.once("close", (code) => {
          clearTimeout(timer);
          resolve({
            standardOutput: Buffer.concat(standardOutput).toString("utf8"),
            standardError: Buffer.concat(standardError).toString("utf8"),
            exitCode: code ?? -1,
            succeeded: code === 0,
            timedOut,
          });
        });
      });
    },

    async which(executable: string, path: string): Promise<string | undefined> {
      if (executable.includes("/")) {
        return (await isRunnable(executable)) ? executable : undefined;
      }

      for (const directory of path.split(":")) {
        if (directory === "") continue;

        const candidate = join(directory, executable);

        // oxlint-disable-next-line no-await-in-loop
        if (await isRunnable(candidate)) return candidate;
      }

      return undefined;
    },
  };
}

function isRunnable(candidate: string): Promise<boolean> {
  return Effect.runPromise(
    Effect.tryPromise(async () => {
      if (!(await stat(candidate)).isFile()) return false;

      await access(candidate, constants.X_OK);

      return true;
    }).pipe(Effect.catch(() => Effect.succeed(false))),
  );
}
