import { homedir } from "node:os";

import type { Logger } from "@janela/support";
import type { ProcessRunning } from "@janela/support/process";
import { Effect } from "effect";

export interface LaunchAgentKickstartOptions {
  readonly run: ProcessRunning["run"];
  readonly uid: number;
  readonly now: () => number;
  readonly log: Logger;
}

export const LAUNCH_AGENT_LABEL = "sh.janela.janelad";

export const KICKSTART_THROTTLE_MS = 1000;

const KICKSTART_TIMEOUT_MS = 5000;

const LAUNCHCTL = "/bin/launchctl";

export function launchAgentKickstart(deps: LaunchAgentKickstartOptions): () => void {
  const { run, uid, now, log } = deps;

  let lastAttempt: number | undefined = undefined;

  return (): void => {
    const at = now();

    if (lastAttempt !== undefined && at - lastAttempt < KICKSTART_THROTTLE_MS) return;

    lastAttempt = at;

    void Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          run({
            executable: LAUNCHCTL,
            arguments: ["kickstart", `gui/${uid}/${LAUNCH_AGENT_LABEL}`],
            workingDirectory: homedir(),
            timeoutMs: KICKSTART_TIMEOUT_MS,
          }),
        catch: (cause: unknown) => cause,
      }).pipe(
        Effect.match({
          onSuccess: (outcome) => {
            log.debug("kickstart requested", { exitCode: outcome.exitCode });
          },
          onFailure: (cause) => {
            log.debug("kickstart unavailable", {
              error: cause instanceof Error ? cause.name : "unknown",
            });
          },
        }),
      ),
    );
  };
}
