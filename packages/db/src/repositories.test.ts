import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import type {
  AutomationScript,
  AutomationScripts,
  Pane,
  Project,
  ProjectID,
  Session,
  SessionLayout,
  TerminalDescriptor,
  TerminalID,
} from "@janela/core";
import {
  MAXIMUM_PANE_DEPTH,
  absolutePath,
  newProjectID,
  newSessionID,
  newTerminalID,
  now,
  repairLayout,
} from "@janela/core";
import type { LogRecord, Logger } from "@janela/support";
import { Effect, Result } from "effect";

import { temporaryDatabase } from "./database.ts";
import type { TemporaryDatabase } from "./database.ts";
import { CorruptRecord, InvalidRecord } from "./errors.ts";

interface Record_ {
  readonly level: LogRecord["level"];
  readonly message: string;
  readonly fields: LogRecord["fields"];
}

interface RecordingLogger {
  readonly logger: Logger;
  readonly records: Record_[];
}

interface Fixture {
  readonly database: TemporaryDatabase;
  readonly records: readonly Record_[];
  corrupt(sql: string, parameters: readonly (string | number | null)[] | undefined): void;
}

const DEV_SCRIPT: AutomationScript = { script: "pnpm dev", timeoutSeconds: 30 };

function recordingLogger(): RecordingLogger {
  const records: Record_[] = [];
  const at =
    (level: Record_["level"]) =>
    (message: string, fields: LogRecord["fields"] | undefined): void => {
      records.push({ level, message, fields });
    };

  return {
    logger: {
      debug: at("debug"),
      info: at("info"),
      notice: at("notice"),
      warning: at("warning"),
      error: at("error"),
    },
    records,
  };
}

function sideDoor(
  path: string,
  sql: string,
  parameters: readonly (string | number | null)[],
): void {
  Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        const side = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(path)),
          (open) =>
            Effect.sync(() => {
              open.close();
            }),
        );

        yield* Effect.sync(() => {
          side.run(sql, [...parameters]);
        });
      }),
    ),
  );
}

function withDatabase(work: (fixture: Fixture) => Promise<void>): Promise<void> {
  const { logger, records } = recordingLogger();

  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const database = yield* Effect.acquireRelease(
          Effect.promise(() => temporaryDatabase({ log: logger })),
          (open) => Effect.promise(() => open.dispose()),
        );

        yield* Effect.tryPromise({
          try: () =>
            work({
              database,
              records,
              corrupt(sql, parameters = []): void {
                sideDoor(database.path, sql, parameters);
              },
            }),
          catch: (cause: unknown) => cause,
        });
      }),
    ),
  );
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: newProjectID(),
    name: "janela",
    directory: absolutePath(`/tmp/janela-${crypto.randomUUID()}`),
    settings: {
      worktreeRoot: { kind: "siblingDirectory" },
      automation: {},
    },
    accent: "none",
    isExpanded: true,
    addedAt: now(),
    ...overrides,
  };
}

function terminal(overrides: Partial<TerminalDescriptor> = {}): TerminalDescriptor {
  return {
    id: newTerminalID(),
    title: "zsh",
    startsAutomatically: true,
    role: { kind: "user" },
    createdAt: now(),
    ...overrides,
  };
}

function oneTab(id: TerminalID): SessionLayout {
  return { tabs: [{ root: { kind: "terminal", id }, focusedTerminalID: id }], focusedTabIndex: 0 };
}

function session(overrides: Partial<Session> = {}): Session {
  const first = terminal();
  const directory = absolutePath(`/tmp/janela-session-${crypto.randomUUID()}`);

  return {
    id: newSessionID(),
    name: "feature",
    directory,
    backing: { kind: "folder" },
    terminals: [first],
    layout: oneTab(first.id),
    accent: "none",
    createdAt: now(),
    lastActiveAt: now(),
    isPinned: false,
    ...overrides,
  };
}

function worktreeSession(parent: ProjectID, overrides: Partial<Session> = {}): Session {
  const base = session(overrides);

  return {
    ...base,
    projectID: parent,
    backing: {
      kind: "worktree",
      binding: {
        branch: "feature/one",
        baseCommit: "0123456789abcdef",
        path: base.directory,
        ownership: "managed",
        includedPaths: [".env", "node_modules"],
      },
    },
  };
}

function deepLayout(ids: readonly TerminalID[]): SessionLayout {
  const [head, ...rest] = ids;

  if (head === undefined) throw new Error("need at least one id");

  let root: Pane = { kind: "terminal", id: head };

  for (const id of rest) {
    root = {
      kind: "split",
      axis: "horizontal",
      fraction: 0.5,
      first: root,
      second: { kind: "terminal", id },
    };
  }

  return { tabs: [{ root, focusedTerminalID: head }], focusedTabIndex: 0 };
}

async function failureOf(work: Promise<unknown>): Promise<Error> {
  const outcome = await Effect.runPromise(
    Effect.result(Effect.tryPromise({ try: () => work, catch: (cause: unknown) => cause })),
  );

  if (Result.isSuccess(outcome)) throw new Error("expected the work to fail");

  return outcome.failure instanceof Error
    ? outcome.failure
    : new Error(String(outcome.failure), { cause: outcome.failure });
}

function reasonsOf(failure: Error): readonly string[] {
  if (failure instanceof CorruptRecord || failure instanceof InvalidRecord) return failure.reasons;

  throw failure;
}

function rowCount(database: TemporaryDatabase, table: string): number {
  return Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        const side = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(database.path, { readonly: true })),
          (open) =>
            Effect.sync(() => {
              open.close();
            }),
        );

        return yield* Effect.sync(() =>
          Number(
            side.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "${table}"`).get()?.n ?? -1,
          ),
        );
      }),
    ),
  );
}

describe("projects", () => {
  test("a project round-trips with git, a custom worktree root and a script per event", async () => {
    await withDatabase(async ({ database }) => {
      const teardown: AutomationScript = {
        script: "# later\ndocker compose down",
        timeoutSeconds: 5,
      };

      const automation: AutomationScripts = {
        worktreeCreated: { script: 'cp "$JANELA_PROJECT_DIRECTORY/.env" .env', timeoutSeconds: 30 },
        sessionTeardown: teardown,
      };

      const value = project({
        git: { remoteURL: "git@github.com:x/y.git", defaultBranch: "main", forge: "gitHub" },
        settings: {
          worktreeRoot: { kind: "custom", directory: absolutePath("/tmp/worktrees") },
          automation,
        },
        accent: "blue",
        isExpanded: false,
      });

      await database.projects.save(value);

      expect(await database.projects.find(value.id)).toEqual(value);

      const teardownOnly: AutomationScripts = { sessionTeardown: teardown };
      await database.projects.save({
        ...value,
        settings: { ...value.settings, automation: teardownOnly },
      });

      expect((await database.projects.find(value.id))?.settings.automation).toEqual(teardownOnly);
    });
  });

  test("an empty git descriptor reads back as no git at all", async () => {
    await withDatabase(async ({ database }) => {
      const value = project({ git: {} });
      const { git: _empty, ...withoutGit } = value;
      await database.projects.save(value);
      const read = await database.projects.find(value.id);

      expect(read?.git).toBeUndefined();
      expect(read).toEqual(withoutGit);
    });
  });

  test("a remote with no branch and no forge is still a repository", async () => {
    await withDatabase(async ({ database }) => {
      const value = project({ git: { defaultBranch: "trunk" } });
      await database.projects.save(value);

      expect((await database.projects.find(value.id))?.git).toEqual({ defaultBranch: "trunk" });
    });
  });

  test("all is name-ordered", async () => {
    await withDatabase(async ({ database }) => {
      // oxlint-disable-next-line no-await-in-loop
      for (const name of ["zed", "atlas", "meta"]) await database.projects.save(project({ name }));

      expect((await database.projects.all()).map((p) => p.name)).toEqual(["atlas", "meta", "zed"]);
    });
  });

  test("an unknown forge degrades to absent, with a warning, rather than failing the load", async () => {
    await withDatabase(async ({ database, records, corrupt }) => {
      const value = project({ git: { remoteURL: "ssh://git@example.test/x", forge: "gitHub" } });
      await database.projects.save(value);
      corrupt(`UPDATE Project SET forge = 'bitbucket'`, undefined);

      const read = await database.projects.find(value.id);

      expect(read?.git).toEqual({ remoteURL: "ssh://git@example.test/x" });
      expect(records).toContainEqual({
        level: "warning",
        message: "forge unknown, defaulted",
        fields: { table: "Project", id: value.id },
      });
    });
  });

  test("a custom worktree root with no path is corrupt, not a guess", async () => {
    await withDatabase(async ({ database, corrupt }) => {
      const value = project({
        settings: {
          worktreeRoot: { kind: "custom", directory: absolutePath("/tmp/worktrees") },
          automation: {},
        },
      });

      await database.projects.save(value);
      corrupt(`UPDATE Project SET worktreeRootPath = NULL`, undefined);

      expect(reasonsOf(await failureOf(database.projects.find(value.id)))).toEqual([
        "worktreeRootPath missing on custom worktreeRoot",
      ]);
    });
  });

  test("an unknown automation event is corrupt", async () => {
    await withDatabase(async ({ database, corrupt }) => {
      const value = project({
        settings: {
          worktreeRoot: { kind: "siblingDirectory" },
          automation: { sessionStart: DEV_SCRIPT },
        },
      });

      await database.projects.save(value);
      corrupt(`UPDATE AutomationScript SET event = 'onTuesday'`, undefined);

      expect(reasonsOf(await failureOf(database.projects.find(value.id)))).toEqual([
        "automation onTuesday: event unknown",
      ]);
    });
  });

  test("removing an absent project is a no-op", async () => {
    await withDatabase(async ({ database }) => {
      await database.projects.remove(newProjectID());

      expect(await database.projects.all()).toEqual([]);
    });
  });
});

describe("sessions", () => {
  test("a worktree-backed session round-trips whole: terminals, tabs, splits, titles", async () => {
    await withDatabase(async ({ database }) => {
      const owner = project();
      await database.projects.save(owner);
      const shell = terminal();
      const agent = terminal({
        title: "claude",
        role: { kind: "automation", event: "sessionStart" },
        startsAutomatically: false,
      });

      const scratch = terminal({
        title: "logs",
        workingDirectoryOverride: absolutePath("/tmp/logs"),
      });

      const layout: SessionLayout = {
        tabs: [
          {
            title: "work",
            root: {
              kind: "split",
              axis: "vertical",
              fraction: 0.3,
              first: { kind: "terminal", id: shell.id },
              second: { kind: "terminal", id: agent.id },
            },
            focusedTerminalID: agent.id,
          },
          { root: { kind: "terminal", id: scratch.id }, focusedTerminalID: scratch.id },
        ],
        focusedTabIndex: 1,
      };

      const value = worktreeSession(owner.id, {
        terminals: [shell, agent, scratch],
        layout,
        accent: "teal",
        isPinned: true,
      });

      await database.sessions.save(value);

      expect(await database.sessions.find(value.id)).toEqual(value);
    });
  });

  test("a standalone folder session saves and reads with no project", async () => {
    await withDatabase(async ({ database }) => {
      const value = session();
      await database.sessions.save(value);
      const read = await database.sessions.find(value.id);

      expect(read?.projectID).toBeUndefined();
      expect(read).toEqual(value);
    });
  });

  test("all lists standalone sessions first, then each project in its own order", async () => {
    await withDatabase(async ({ database }) => {
      const owner = project();
      await database.projects.save(owner);

      const first = worktreeSession(owner.id, { name: "first" });
      const loose = session({ name: "loose" });
      const secondSession = worktreeSession(owner.id, { name: "second" });

      // oxlint-disable-next-line no-await-in-loop
      for (const value of [first, loose, secondSession]) await database.sessions.save(value);

      expect((await database.sessions.all()).map((s) => s.name)).toEqual([
        "loose",
        "first",
        "second",
      ]);

      expect((await database.sessions.inProject(owner.id)).map((s) => s.name)).toEqual([
        "first",
        "second",
      ]);

      expect((await database.sessions.standalone()).map((s) => s.name)).toEqual(["loose"]);
    });
  });

  test("position is assigned once and survives a re-save that drops a terminal", async () => {
    await withDatabase(async ({ database }) => {
      const owner = project();
      await database.projects.save(owner);

      const keep = terminal();
      const doomed = terminal({ title: "gone" });
      const first = worktreeSession(owner.id, {
        name: "first",
        terminals: [keep, doomed],
        layout: oneTab(keep.id),
      });

      const second = worktreeSession(owner.id, { name: "second" });
      await database.sessions.save(first);
      await database.sessions.save(second);

      await database.sessions.save({ ...first, terminals: [keep] });

      const read = await database.sessions.find(first.id);

      expect(read?.terminals.map((t) => t.id)).toEqual([keep.id]);
      expect((await database.sessions.inProject(owner.id)).map((s) => s.name)).toEqual([
        "first",
        "second",
      ]);
    });
  });

  test("touch moves lastActiveAt and nothing else", async () => {
    await withDatabase(async ({ database }) => {
      const value = session({
        lastActiveAt: "2020-01-01T00:00:00.000Z" as Session["lastActiveAt"],
      });

      await database.sessions.save(value);

      await database.sessions.touch(value.id);
      const read = await database.sessions.find(value.id);

      expect(read?.lastActiveAt).not.toBe(value.lastActiveAt);
      expect(read).toEqual({ ...value, lastActiveAt: read?.lastActiveAt ?? value.lastActiveAt });
    });
  });

  test("removing an absent session is a no-op", async () => {
    await withDatabase(async ({ database }) => {
      await database.sessions.remove(newSessionID());

      expect(await database.sessions.all()).toEqual([]);
    });
  });
});

describe("cascades", () => {
  test("removing a project takes its sessions, terminals and automation with it", async () => {
    await withDatabase(async ({ database }) => {
      const doomed = project();
      const survivor = project({ name: "survivor" });
      await database.projects.save({
        ...doomed,
        settings: { ...doomed.settings, automation: { sessionStart: DEV_SCRIPT } },
      });

      await database.projects.save(survivor);

      const inDoomed = worktreeSession(doomed.id);
      const inSurvivor = worktreeSession(survivor.id);
      await database.sessions.save(inDoomed);
      await database.sessions.save(inSurvivor);

      await database.projects.remove(doomed.id);

      expect(await database.projects.find(doomed.id)).toBeUndefined();
      expect(await database.sessions.find(inDoomed.id)).toBeUndefined();
      expect(await database.sessions.find(inSurvivor.id)).toEqual(inSurvivor);
      expect(rowCount(database, "Terminal")).toBe(inSurvivor.terminals.length);
      expect(rowCount(database, "AutomationScript")).toBe(0);
    });
  });

  test("removing a session takes its terminals and leaves its project alone", async () => {
    await withDatabase(async ({ database }) => {
      const owner = project();
      await database.projects.save(owner);
      const doomed = worktreeSession(owner.id);
      const sibling = worktreeSession(owner.id, { name: "sibling" });
      await database.sessions.save(doomed);
      await database.sessions.save(sibling);

      await database.sessions.remove(doomed.id);

      expect(await database.projects.find(owner.id)).toEqual(owner);
      expect(await database.sessions.inProject(owner.id)).toEqual([sibling]);
      expect(rowCount(database, "Terminal")).toBe(sibling.terminals.length);
    });
  });
});

describe("a backing that is representable in SQL and meaningless in the domain", () => {
  test("a worktree session missing its ownership is refused, by name", async () => {
    await withDatabase(async ({ database, corrupt }) => {
      const owner = project();
      await database.projects.save(owner);
      const value = worktreeSession(owner.id);
      await database.sessions.save(value);

      corrupt(`UPDATE Session SET worktreeOwnership = NULL`, undefined);

      expect(reasonsOf(await failureOf(database.sessions.find(value.id)))).toEqual([
        "worktreeOwnership is not managed or adopted",
      ]);

      expect(await failureOf(database.sessions.all())).toBeInstanceOf(CorruptRecord);
    });
  });

  test("a path list stored as a shell string is refused, never read as one path", async () => {
    await withDatabase(async ({ database, corrupt }) => {
      const owner = project();
      await database.projects.save(owner);
      const value = worktreeSession(owner.id);
      await database.sessions.save(value);

      corrupt(`UPDATE Session SET worktreeIncludedPaths = '".env node_modules"'`, undefined);

      expect(reasonsOf(await failureOf(database.sessions.find(value.id)))).toEqual([
        "worktreeIncludedPaths is not a JSON array of strings",
      ]);
    });
  });

  test("worktree columns on a folder backing are refused, one reason per column", async () => {
    await withDatabase(async ({ database, corrupt }) => {
      const value = session();
      await database.sessions.save(value);
      corrupt(
        `UPDATE Session SET worktreeBranch = 'main', worktreeOwnership = 'managed'`,
        undefined,
      );

      expect(reasonsOf(await failureOf(database.sessions.find(value.id)))).toEqual([
        "worktreeBranch set on folder backing",
        "worktreeOwnership set on folder backing",
      ]);
    });
  });

  test("a projectDirectory session orphaned from its project is refused", async () => {
    await withDatabase(async ({ database, corrupt }) => {
      const owner = project();
      await database.projects.save(owner);
      const value = session({ projectID: owner.id, backing: { kind: "projectDirectory" } });
      await database.sessions.save(value);
      corrupt(`UPDATE Session SET projectId = NULL`, undefined);

      expect(reasonsOf(await failureOf(database.sessions.find(value.id)))).toEqual([
        "projectDirectory backing requires a project",
      ]);
    });
  });

  test("an unknown backing kind is refused", async () => {
    await withDatabase(async ({ database, corrupt }) => {
      const value = session();
      await database.sessions.save(value);
      corrupt(`UPDATE Session SET backingKind = 'symlink'`, undefined);

      expect(reasonsOf(await failureOf(database.sessions.find(value.id)))).toEqual([
        "backingKind is not folder, projectDirectory or worktree",
      ]);
    });
  });

  test("an unknown terminal role is refused, because a role decides what runs", async () => {
    await withDatabase(async ({ database, corrupt }) => {
      const value = session();
      await database.sessions.save(value);
      corrupt(`UPDATE Terminal SET role = 'daemon'`, undefined);

      expect(reasonsOf(await failureOf(database.sessions.find(value.id)))).toEqual([
        "terminal 0: role unknown",
      ]);
    });
  });

  test("an unknown accent degrades to none, with a warning", async () => {
    await withDatabase(async ({ database, records, corrupt }) => {
      const value = session({ accent: "pink" });
      await database.sessions.save(value);
      corrupt(`UPDATE Session SET accent = 'plaid'`, undefined);

      expect((await database.sessions.find(value.id))?.accent).toBe("none");
      expect(records).toContainEqual({
        level: "warning",
        message: "accent unknown, defaulted",
        fields: { table: "Session", id: value.id },
      });
    });
  });
});

describe("layout", () => {
  test("a layout naming a terminal that no longer exists is repaired and reported", async () => {
    await withDatabase(async ({ database, records, corrupt }) => {
      const real = terminal();
      const value = session({ terminals: [real], layout: oneTab(real.id) });
      await database.sessions.save(value);

      const ghost = newTerminalID();
      const stored: SessionLayout = {
        tabs: [
          {
            root: {
              kind: "split",
              axis: "horizontal",
              fraction: 0.5,
              first: { kind: "terminal", id: real.id },
              second: { kind: "terminal", id: ghost },
            },
            focusedTerminalID: ghost,
          },
        ],
        focusedTabIndex: 0,
      };

      corrupt(`UPDATE Session SET layout = ?`, [JSON.stringify(stored)]);

      const read = await database.sessions.find(value.id);

      expect(read?.layout).toEqual(repairLayout(stored, [real.id]));
      expect(read?.layout).toEqual(oneTab(real.id));
      expect(records).toContainEqual({
        level: "warning",
        message: "layout repaired",
        fields: {
          sessionID: value.id,
          reason: `tab 0: pane names absent terminal ${ghost}`,
        },
      });
    });
  });

  test("a layout that is not JSON becomes one tab per terminal, so nothing is unreachable", async () => {
    await withDatabase(async ({ database, records, corrupt }) => {
      const first = terminal();
      const second = terminal({ title: "second" });
      const value = session({
        terminals: [first, second],
        layout: {
          tabs: [
            {
              root: {
                kind: "split",
                axis: "horizontal",
                fraction: 0.5,
                first: { kind: "terminal", id: first.id },
                second: { kind: "terminal", id: second.id },
              },
              focusedTerminalID: first.id,
            },
          ],
          focusedTabIndex: 0,
        },
      });

      await database.sessions.save(value);
      corrupt(`UPDATE Session SET layout = 'not json'`, undefined);

      const read = await database.sessions.find(value.id);

      expect(read?.layout.tabs).toHaveLength(2);
      expect(read?.layout).toEqual({
        tabs: [
          { root: { kind: "terminal", id: first.id }, focusedTerminalID: first.id },
          { root: { kind: "terminal", id: second.id }, focusedTerminalID: second.id },
        ],
        focusedTabIndex: 0,
      });

      expect(records).toContainEqual({
        level: "warning",
        message: "layout unreadable, rebuilt",
        fields: { sessionID: value.id },
      });
    });
  });

  test("a layout whose panes are the wrong shape is rebuilt rather than trusted", async () => {
    await withDatabase(async ({ database, corrupt }) => {
      const only = terminal();
      const value = session({ terminals: [only], layout: oneTab(only.id) });
      await database.sessions.save(value);
      corrupt(
        `UPDATE Session SET layout = '{"tabs":[{"root":{"kind":"grid"},"focusedTerminalID":"x"}],"focusedTabIndex":0}'`,
        undefined,
      );

      expect((await database.sessions.find(value.id))?.layout).toEqual(oneTab(only.id));
    });
  });

  test("a stored tree deeper than the bound loads truncated, and cannot be saved", async () => {
    await withDatabase(async ({ database, records, corrupt }) => {
      const terminals = Array.from({ length: MAXIMUM_PANE_DEPTH + 1 }, (_, index) =>
        terminal({ title: `t${index}` }),
      );

      const ids = terminals.map((t) => t.id);
      const first = ids[0];

      if (first === undefined) throw new Error("no terminals");

      const value = session({ terminals, layout: oneTab(first) });
      await database.sessions.save(value);

      const tooDeep = deepLayout(ids);
      corrupt(`UPDATE Session SET layout = ?`, [JSON.stringify(tooDeep)]);

      const read = await database.sessions.find(value.id);

      expect(read?.layout).toEqual(repairLayout(tooDeep, ids));
      expect(read?.layout).not.toEqual(tooDeep);
      expect(records).toContainEqual({
        level: "warning",
        message: "layout repaired",
        fields: {
          sessionID: value.id,
          reason: `tab 0: split tree deeper than ${MAXIMUM_PANE_DEPTH}`,
        },
      });

      const failure = await failureOf(database.sessions.save({ ...value, layout: tooDeep }));

      expect(failure).toBeInstanceOf(InvalidRecord);
      expect(reasonsOf(failure)).toContain(`tab 0: split tree deeper than ${MAXIMUM_PANE_DEPTH}`);
    });
  });

  test("a pane id that is not a UUID rebuilds the layout, so no terminal is unreachable", async () => {
    await withDatabase(async ({ database, records, corrupt }) => {
      const first = terminal();
      const second = terminal({ title: "second" });
      const value = session({ terminals: [first, second], layout: oneTab(first.id) });
      await database.sessions.save(value);

      corrupt(`UPDATE Session SET layout = ?`, [
        `{"tabs":[{"root":{"kind":"terminal","id":"not-a-uuid"},"focusedTerminalID":"not-a-uuid"}],"focusedTabIndex":0}`,
      ]);

      const read = await database.sessions.find(value.id);

      expect(read?.layout).toEqual({
        tabs: [
          { root: { kind: "terminal", id: first.id }, focusedTerminalID: first.id },
          { root: { kind: "terminal", id: second.id }, focusedTerminalID: second.id },
        ],
        focusedTabIndex: 0,
      });

      expect(records).toContainEqual({
        level: "warning",
        message: "layout unreadable, rebuilt",
        fields: { sessionID: value.id },
      });
    });
  });

  test("a fractional focusedTabIndex is repaired to the first tab, not refused", async () => {
    await withDatabase(async ({ database, records, corrupt }) => {
      const first = terminal();
      const second = terminal({ title: "second" });
      const value = session({ terminals: [first, second], layout: oneTab(first.id) });
      await database.sessions.save(value);

      const stored: SessionLayout = {
        tabs: [
          { root: { kind: "terminal", id: first.id }, focusedTerminalID: first.id },
          { root: { kind: "terminal", id: second.id }, focusedTerminalID: second.id },
        ],
        focusedTabIndex: 0,
      };

      corrupt(`UPDATE Session SET layout = ?`, [
        JSON.stringify({ ...stored, focusedTabIndex: 1.5 }),
      ]);

      const read = await database.sessions.find(value.id);

      expect(read?.layout).toEqual(stored);
      expect(records).toContainEqual({
        level: "warning",
        message: "layout repaired",
        fields: { sessionID: value.id, reason: "focusedTabIndex 1.5 outside 0..1" },
      });

      expect(
        records.filter((record) => record.message === "layout unreadable, rebuilt"),
      ).toHaveLength(0);
    });
  });
});

describe("save refuses", () => {
  test("a layout naming a terminal the session does not have", async () => {
    await withDatabase(async ({ database }) => {
      const value = session();
      const ghost = newTerminalID();
      const failure = await failureOf(database.sessions.save({ ...value, layout: oneTab(ghost) }));

      expect(failure).toBeInstanceOf(InvalidRecord);
      expect(reasonsOf(failure)).toEqual([`tab 0: pane names absent terminal ${ghost}`]);
      expect(await database.sessions.find(value.id)).toBeUndefined();
    });
  });

  test("a folder session that claims a project", async () => {
    await withDatabase(async ({ database }) => {
      const owner = project();
      await database.projects.save(owner);
      const value = session({ projectID: owner.id });

      expect(reasonsOf(await failureOf(database.sessions.save(value)))).toEqual([
        "folder backing must not belong to a project",
      ]);

      expect(await database.sessions.find(value.id)).toBeUndefined();
    });
  });

  test("a worktree binding whose path is not the session directory", async () => {
    await withDatabase(async ({ database }) => {
      const owner = project();
      await database.projects.save(owner);
      const value = worktreeSession(owner.id);
      const moved: Session = {
        ...value,
        backing: {
          kind: "worktree",
          binding: {
            ...(value.backing.kind === "worktree"
              ? value.backing.binding
              : { path: value.directory, ownership: "managed", includedPaths: [] }),
            path: absolutePath("/tmp/somewhere-else"),
          },
        },
      };

      expect(reasonsOf(await failureOf(database.sessions.save(moved)))).toEqual([
        "worktree binding path differs from the session directory",
      ]);
    });
  });

  test("two terminals with the same id, which a layout could not describe", async () => {
    await withDatabase(async ({ database }) => {
      const only = terminal();
      const value = session({ terminals: [only, only], layout: oneTab(only.id) });

      expect(reasonsOf(await failureOf(database.sessions.save(value)))).toContain(
        "terminals contain a duplicate id",
      );
    });
  });

  test("a re-save that would corrupt an existing row leaves the stored one intact", async () => {
    await withDatabase(async ({ database }) => {
      const value = session();
      await database.sessions.save(value);

      await failureOf(database.sessions.save({ ...value, layout: oneTab(newTerminalID()) }));

      expect(await database.sessions.find(value.id)).toEqual(value);
    });
  });
});

describe("referential integrity", () => {
  test("a session naming a project that does not exist is a caller bug that propagates", async () => {
    await withDatabase(async ({ database }) => {
      const value = worktreeSession(newProjectID());
      const failure = await failureOf(database.sessions.save(value));

      expect(failure).toBeDefined();
      expect(failure).not.toBeInstanceOf(InvalidRecord);
      expect(await database.sessions.find(value.id)).toBeUndefined();
    });
  });

  test("two projects cannot share a directory", async () => {
    await withDatabase(async ({ database }) => {
      const directory = absolutePath("/tmp/janela-shared");
      await database.projects.save(project({ directory }));

      expect(await failureOf(database.projects.save(project({ directory })))).toBeDefined();
    });
  });
});
