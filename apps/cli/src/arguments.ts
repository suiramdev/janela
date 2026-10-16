import { resolve } from "node:path";

import { Predicate } from "effect";

export type CreationTarget =
  | { readonly kind: "directory"; readonly directory: string }
  | { readonly kind: "project"; readonly project: string; readonly branch: string | undefined }
  | {
      readonly kind: "newBranch";
      readonly project: string;
      readonly branch: string;
      readonly startPoint: string | undefined;
    };

export type Command =
  | { readonly kind: "list"; readonly json: boolean }
  | { readonly kind: "addProject"; readonly directory: string; readonly name: string | undefined }
  | {
      readonly kind: "createSession";
      readonly target: CreationTarget;
      readonly name: string | undefined;
    }
  | {
      readonly kind: "removeSession";
      readonly session: string;
      readonly yes: boolean;
      readonly deleteDirectory: boolean;
    }
  | {
      readonly kind: "createTerminal";
      readonly session: string;
      readonly title: string | undefined;
    }
  | { readonly kind: "startTerminal"; readonly terminal: string }
  | { readonly kind: "readTerminal"; readonly terminal: string; readonly scrollback: boolean };

export type Invocation =
  | { readonly kind: "run"; readonly command: Command }
  | { readonly kind: "help" }
  | { readonly kind: "usage"; readonly problem: string };

interface FlagSpec {
  readonly values: readonly string[];
  readonly switches: readonly string[];
  readonly positionals: number;
}

interface ReadFlags {
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<string, string>;
  readonly switches: ReadonlySet<string>;
}

export const USAGE =
  "usage: janela <command>\n" +
  "\n" +
  "  list [--json]                                  projects, sessions and terminals\n" +
  "  project add <directory> [--name <name>]        add a project\n" +
  "  session create --directory <directory> [--name <name>]\n" +
  "  session create --project <project> [--branch <branch>] [--name <name>]\n" +
  "  session create --project <project> --new-branch <branch> [--from <start>] [--name <name>]\n" +
  "  session remove <session> [--yes] [--delete-directory]\n" +
  "                                                 shows what removal costs; --yes goes ahead,\n" +
  "                                                 --delete-directory also deletes a worktree Janela made\n" +
  "  terminal create <session> [--title <title>]    prints the new terminal's id\n" +
  "  terminal start <terminal>\n" +
  "  terminal read <terminal> [--scrollback]        the terminal's screen, as text\n" +
  "\n" +
  "A <project>, <session> or <terminal> is an id, a unique id prefix, or — for a\n" +
  "project or a session — its exact name.\n" +
  "\n" +
  "Exit status: 0 done, 1 the daemon refused or failed the request, 2 usage,\n" +
  "3 the daemon is not reachable, 4 the daemon speaks an incompatible protocol,\n" +
  "5 removal was not confirmed.\n";

function readFlags(argv: readonly string[], spec: FlagSpec): ReadFlags | string {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const switches = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";

    if (!argument.startsWith("--")) {
      positionals.push(argument);

      continue;
    }

    if (spec.switches.includes(argument)) {
      switches.add(argument);

      continue;
    }

    if (!spec.values.includes(argument)) return `unknown option ${JSON.stringify(argument)}`;

    const value = argv[index + 1];

    if (value === undefined || value.startsWith("--")) return `${argument} needs a value`;

    if (values.has(argument)) return `${argument} is given twice`;

    values.set(argument, value);
    index += 1;
  }

  if (positionals.length < spec.positionals) return "a required argument is missing";

  if (positionals.length > spec.positionals) {
    return `unexpected argument ${JSON.stringify(positionals[spec.positionals])}`;
  }

  return { positionals, values, switches };
}

function first(flags: ReadFlags): string {
  return flags.positionals[0] ?? "";
}

function usage(problem: string): Invocation {
  return { kind: "usage", problem };
}

function run(command: Command): Invocation {
  return { kind: "run", command };
}

function creationTarget(flags: ReadFlags): CreationTarget | string {
  const directory = flags.values.get("--directory");
  const project = flags.values.get("--project");
  const branch = flags.values.get("--branch");
  const newBranch = flags.values.get("--new-branch");
  const startPoint = flags.values.get("--from");

  if (directory !== undefined) {
    if (project !== undefined || branch !== undefined || newBranch !== undefined) {
      return "--directory makes a session without a project; it takes no --project or branch";
    }

    if (startPoint !== undefined) return "--from needs --new-branch";

    return { kind: "directory", directory: resolve(directory) };
  }

  if (project === undefined) return "say where the session lives: --directory or --project";

  if (branch !== undefined && newBranch !== undefined) {
    return "--branch picks an existing branch and --new-branch makes one; give one of them";
  }

  if (newBranch !== undefined) return { kind: "newBranch", project, branch: newBranch, startPoint };

  if (startPoint !== undefined) return "--from needs --new-branch";

  return { kind: "project", project, branch };
}

function parseProject(argv: readonly string[]): Invocation {
  const [verb, ...rest] = argv;

  if (verb !== "add") return usage(`unknown project command ${JSON.stringify(verb ?? "")}`);

  const flags = readFlags(rest, { values: ["--name"], switches: [], positionals: 1 });

  if (Predicate.isString(flags)) return usage(flags);

  return run({
    kind: "addProject",
    directory: resolve(first(flags)),
    name: flags.values.get("--name"),
  });
}

function parseSession(argv: readonly string[]): Invocation {
  const [verb, ...rest] = argv;

  if (verb === "create") {
    const flags = readFlags(rest, {
      values: ["--directory", "--project", "--branch", "--new-branch", "--from", "--name"],
      switches: [],
      positionals: 0,
    });

    if (Predicate.isString(flags)) return usage(flags);

    const target = creationTarget(flags);

    if (Predicate.isString(target)) return usage(target);

    return run({ kind: "createSession", target, name: flags.values.get("--name") });
  }

  if (verb === "remove") {
    const flags = readFlags(rest, {
      values: [],
      switches: ["--yes", "--delete-directory"],
      positionals: 1,
    });

    if (Predicate.isString(flags)) return usage(flags);

    return run({
      kind: "removeSession",
      session: first(flags),
      yes: flags.switches.has("--yes"),
      deleteDirectory: flags.switches.has("--delete-directory"),
    });
  }

  return usage(`unknown session command ${JSON.stringify(verb ?? "")}`);
}

function parseTerminal(argv: readonly string[]): Invocation {
  const [verb, ...rest] = argv;

  if (verb === "create") {
    const flags = readFlags(rest, { values: ["--title"], switches: [], positionals: 1 });

    if (Predicate.isString(flags)) return usage(flags);

    return run({
      kind: "createTerminal",
      session: first(flags),
      title: flags.values.get("--title"),
    });
  }

  if (verb === "start") {
    const flags = readFlags(rest, { values: [], switches: [], positionals: 1 });

    if (Predicate.isString(flags)) return usage(flags);

    return run({ kind: "startTerminal", terminal: first(flags) });
  }

  if (verb === "read") {
    const flags = readFlags(rest, { values: [], switches: ["--scrollback"], positionals: 1 });

    if (Predicate.isString(flags)) return usage(flags);

    return run({
      kind: "readTerminal",
      terminal: first(flags),
      scrollback: flags.switches.has("--scrollback"),
    });
  }

  return usage(`unknown terminal command ${JSON.stringify(verb ?? "")}`);
}

export function parseArguments(argv: readonly string[]): Invocation {
  const [noun, ...rest] = argv;

  if (noun === undefined || noun === "help" || noun === "--help" || noun === "-h") {
    return { kind: "help" };
  }

  if (noun === "list") {
    const flags = readFlags(rest, { values: [], switches: ["--json"], positionals: 0 });

    if (Predicate.isString(flags)) return usage(flags);

    return run({ kind: "list", json: flags.switches.has("--json") });
  }

  if (noun === "project") return parseProject(rest);

  if (noun === "session") return parseSession(rest);

  if (noun === "terminal") return parseTerminal(rest);

  return usage(`unknown command ${JSON.stringify(noun)}`);
}
