#!/usr/bin/env bun

import { createInterface } from "node:readline/promises";

import { defaultSocketPath } from "@janela/protocol/endpoint";
import { UnexpectedFailure, isUserFacing, type UserFacingError } from "@janela/support";
import { Effect, Match, Result } from "effect";

import { USAGE, parseArguments, type Command } from "./arguments.ts";
import { runCommand, type Output } from "./commands.ts";
import { linkDaemon } from "./daemon-link.ts";
import { EXIT_STATUS, exitStatusFor } from "./exit-status.ts";
import { openSocketTransport } from "./socket-transport.ts";

const output: Output = {
  line: (text) => {
    process.stdout.write(`${text}\n`);
  },
  write: (text) => {
    process.stdout.write(text);
  },
};

function report(error: UserFacingError): void {
  const lines = [`janela: ${error.summary}`];

  if (error.reason !== undefined) lines.push(error.reason);

  if (error.recoverySuggestion !== undefined) lines.push(error.recoverySuggestion);

  process.stderr.write(`${lines.join("\n")}\n`);
}

async function confirmOnTerminal(question: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await prompt.question(question);
  prompt.close();

  return /^y(es)?$/i.test(answer.trim());
}

async function execute(command: Command): Promise<void> {
  const linked = await linkDaemon({
    socketPath: defaultSocketPath(),
    openTransport: (path) => openSocketTransport(path),
  });

  const outcome = await Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        try: () =>
          runCommand(command, {
            connection: linked.connection,
            stores: linked.stores,
            output,
            confirm:
              process.stdin.isTTY === true && process.stderr.isTTY === true
                ? confirmOnTerminal
                : undefined,
          }),
        catch: (cause) => cause,
      }),
    ),
  );

  await linked.connection.disconnect();

  if (Result.isFailure(outcome)) throw outcome.failure;
}

async function main(): Promise<void> {
  const invocation = parseArguments(process.argv.slice(2));

  const command = Match.value(invocation).pipe(
    Match.discriminatorsExhaustive("kind")({
      help: () => {
        process.stdout.write(USAGE);

        return undefined;
      },
      usage: ({ problem }) => {
        process.stderr.write(`janela: ${problem}\n\n${USAGE}`);
        process.exitCode = EXIT_STATUS.usage;

        return undefined;
      },
      run: (running) => running.command,
    }),
  );

  if (command === undefined) return;

  const ran = await Effect.runPromise(
    Effect.result(Effect.tryPromise({ try: () => execute(command), catch: (cause) => cause })),
  );

  if (Result.isSuccess(ran)) return;

  const failure = ran.failure;
  const shown = isUserFacing(failure)
    ? failure
    : new UnexpectedFailure("Something went wrong in janela.", failure);

  report(shown);
  process.exitCode = exitStatusFor(shown);
}

if (import.meta.main) {
  await main();
}
