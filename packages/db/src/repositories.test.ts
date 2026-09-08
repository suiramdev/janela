import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import type {
  AutomationCommand,
  LaunchProfile,
  LaunchProfileID,
  Pane,
  Project,
  ProjectID,
  Session,
  SessionLayout,
  TerminalDescriptor,
  TerminalID,
} from "@janela/core";
import {
  BUILT_IN_PROFILES,
  MAXIMUM_PANE_DEPTH,
  absolutePath,
  newAutomationID,
  newLaunchProfileID,
  newProjectID,
  newSessionID,
  newTerminalID,
  now,
  repairLayout,
} from "@janela/core";
import type { LogRecord, Logger } from "@janela/support";

import { temporaryDatabase } from "./database.ts";
import type { TemporaryDatabase } from "./database.ts";
import { CorruptRecord, InvalidRecord } from "./errors.ts";

interface Record_ {
  readonly level: LogRecord["level"];
  readonly message: string;
  readonly fields: LogRecord["fields"];
}

/**
 * A structural fake. `@janela/test-support`'s recording sink is global and
 * unimplemented; the logger here is injected, so a local fake is enough.
 */
function recordingLogger(): { logger: Logger; records: Record_[] } {
  const records: Record_[] = [];
  const at =
    (level: Record_["level"]) =>
    (message: string, fields?: LogRecord["fields"]): void => {
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

interface Fixture {
  readonly database: TemporaryDatabase;
  readonly records: readonly Record_[];
  /**
   * The side door: SQL straight at the file, for writing rows the repositories
   * would refuse. Every corruption test needs one, and the alternative — an
   * injectable "write a bad row" seam — would be a hole in the real API.
   */
  corrupt(sql: string, parameters?: readonly (string | number | null)[]): void;
}

async function withDatabase(work: (fixture: Fixture) => Promise<void>): Promise<void> {
  const { logger, records } = recordingLogger();
  const database = await temporaryDatabase({ log: logger });
  try {
    await work({
      database,
      records,
      corrupt(sql, parameters = []): void {
        const side = new Database(database.path);
        try {
          side.run(sql, [...parameters]);
        } finally {
          side.close();
        }
      },
    });
  } finally {
    await database.dispose();
  }
}

// ---- Fixtures. Built with the real minting and branding functions, because a
// hand-branded id would not prove that what we write can be read back.

function profile(overrides: Partial<LaunchProfile> = {}): LaunchProfile {
  return {
    id: newLaunchProfileID(),
    name: "Claude",
    iconName: "sparkles",
    command: ["zsh", "-lc", 'echo "a b" | wc', ""],
    environment: { FOO: "a=b", EMPTY: "" },
    isAgent: true,
    isBuiltIn: false,
    ...overrides,
  };
}

function automation(overrides: Partial<AutomationCommand> = {}): AutomationCommand {
  return {
    id: newAutomationID(),
    event: "sessionStart",
    command: ["pnpm", "dev"],
    isEnabled: true,
    timeoutSeconds: 30,
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: newProjectID(),
    name: "janela",
    directory: absolutePath(`/tmp/janela-${crypto.randomUUID()}`),
    settings: {
      worktreeRoot: { kind: "siblingDirectory" },
      automation: [],
      isForgeEnabled: true,
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

/** A worktree-backed session in `parent`, whose binding path is its directory. */
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

/** A left-nested chain, one terminal per level, so depth equals `ids.length`. */
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

async function failureOf(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function reasonsOf(error: unknown): readonly string[] {
  if (error instanceof CorruptRecord || error instanceof InvalidRecord) return error.reasons;
  throw error instanceof Error
    ? error
    : new Error(`expected a record failure, got ${String(error)}`);
}

// ---- Launch profiles.

describe("launch profiles", () => {
  test("a profile round-trips, argv and environment intact", async () => {
    await withDatabase(async ({ database }) => {
      const value = profile();
      await database.launchProfiles.save(value);
      expect(await database.launchProfiles.find(value.id)).toEqual(value);
    });
  });

  test("all is name-ordered, and an absent id is undefined rather than a throw", async () => {
    await withDatabase(async ({ database }) => {
      // Sequentially, so insertion order is the opposite of name order and the
      // assertion is about `all()` and not about luck.
      for (const name of ["Zsh", "Codex", "Aider"]) {
        // oxlint-disable-next-line no-await-in-loop
        await database.launchProfiles.save(profile({ name }));
      }
      expect((await database.launchProfiles.all()).map((p) => p.name)).toEqual([
        "Aider",
        "Codex",
        "Zsh",
      ]);
      expect(await database.launchProfiles.find(newLaunchProfileID())).toBeUndefined();
    });
  });

  test("an argv stored as a shell string is refused, never read as one word", async () => {
    await withDatabase(async ({ database, corrupt }) => {
      const value = profile();
      await database.launchProfiles.save(value);
      corrupt(`UPDATE LaunchProfile SET command = '"claude --dangerous"'`);

      const failure = await failureOf(database.launchProfiles.find(value.id));
      expect(failure).toBeInstanceOf(CorruptRecord);
      expect(failure instanceof CorruptRecord ? failure.table : undefined).toBe("LaunchProfile");
      expect(reasonsOf(failure)).toEqual(["command is not a JSON array of strings"]);
    });
  });

  test("an environment stored as an array is refused", async () => {
    await withDatabase(async ({ database, corrupt }) => {
      const value = profile();
      await database.launchProfiles.save(value);
      corrupt(`UPDATE LaunchProfile SET environment = '["FOO=bar"]'`);
      expect(reasonsOf(await failureOf(database.launchProfiles.find(value.id)))).toEqual([
        "environment is not a JSON object of strings",
      ]);
    });
  });

  test("seeding twice yields one set, and never overwrites an edit", async () => {
    await withDatabase(async ({ database }) => {
      await database.launchProfiles.seedBuiltIns();
      await database.launchProfiles.seedBuiltIns();
      expect(await database.launchProfiles.all()).toHaveLength(BUILT_IN_PROFILES.length);

      const claude = (await database.launchProfiles.all()).find((p) => p.name === "Claude Code");
      expect(claude).toBeDefined();
      if (claude === undefined) return;
      await database.launchProfiles.save({ ...claude, command: ["claude", "--resume"] });

      await database.launchProfiles.seedBuiltIns();
      const after = await database.launchProfiles.all();
      expect(after).toHaveLength(BUILT_IN_PROFILES.length);
      expect(after.find((p) => p.name === "Claude Code")?.command).toEqual(["claude", "--resume"]);
    });
  });
});

// ---- Projects.

describe("projects", () => {
  test("a project round-trips with git, a custom worktree root and ordered automation", async () => {
    await withDatabase(async ({ database }) => {
      const defaultProfile = profile();
      await database.launchProfiles.save(defaultProfile);

      const first = automation({ event: "worktreeCreated", command: ["cp", ".env"] });
      const second = automation({ event: "sessionTeardown", isEnabled: false, timeoutSeconds: 5 });
      const value = project({
        git: { remoteURL: "git@github.com:x/y.git", defaultBranch: "main", forge: "gitHub" },
        settings: {
          worktreeRoot: { kind: "custom", directory: absolutePath("/tmp/worktrees") },
          automation: [first, second],
          defaultProfileID: defaultProfile.id,
          isForgeEnabled: false,
        },
        accent: "blue",
        isExpanded: false,
      });

      await database.projects.save(value);
      expect(await database.projects.find(value.id)).toEqual(value);

      // Re-saving with one command gone reconciles rather than merges.
      await database.projects.save({
        ...value,
        settings: { ...value.settings, automation: [second] },
      });
      expect((await database.projects.find(value.id))?.settings.automation).toEqual([second]);
    });
  });

  test("an empty git descriptor reads back as no git at all", async () => {
    await withDatabase(async ({ database }) => {
      const value = project({ git: {} });
      const { git: _empty, ...withoutGit } = value;
      await database.projects.save(value);
      const read = await database.projects.find(value.id);
      // The documented rule, and the contract it implies for whoever registers a
      // repository: always record `defaultBranch`, or the project reads back as
      // not a repository.
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
      // Sequential, so insertion order is not name order.
      // oxlint-disable-next-line no-await-in-loop
      for (const name of ["zed", "atlas", "meta"]) await database.projects.save(project({ name }));
      expect((await database.projects.all()).map((p) => p.name)).toEqual(["atlas", "meta", "zed"]);
    });
  });

  test("an unknown forge degrades to absent, with a warning, rather than failing the load", async () => {
    await withDatabase(async ({ database, records, corrupt }) => {
      const value = project({ git: { remoteURL: "ssh://git@example.test/x", forge: "gitHub" } });
      await database.projects.save(value);
      corrupt(`UPDATE Project SET forge = 'bitbucket'`);

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
          automation: [],
          isForgeEnabled: true,
        },
      });
      await database.projects.save(value);
      corrupt(`UPDATE Project SET worktreeRootPath = NULL`);

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
          automation: [automation()],
          isForgeEnabled: true,
        },
      });
      await database.projects.save(value);
      corrupt(`UPDATE AutomationCommand SET event = 'onTuesday'`);

      expect(reasonsOf(await failureOf(database.projects.find(value.id)))).toEqual([
        "automation 0: event unknown",
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

// ---- Sessions.

describe("sessions", () => {
  test("a worktree-backed session round-trips whole: terminals, tabs, splits, titles", async () => {
    await withDatabase(async ({ database }) => {
      const owner = project();
      await database.projects.save(owner);
      const profileValue = profile();
      await database.launchProfiles.save(profileValue);

      const shell = terminal({ profileID: profileValue.id });
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
      // Sequential on purpose: `position` is max+1 at insert, so concurrent
      // saves would be asserting about a race rather than about the order.
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
      // Re-saving is not a reorder: the interface has no reorder entry point, so
      // `save` must never move a session in the list.
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

// ---- Cascades. These are the product rules, so they are tested as such.

describe("cascades", () => {
  test("removing a project takes its sessions, terminals and automation with it", async () => {
    await withDatabase(async ({ database }) => {
      const doomed = project();
      const survivor = project({ name: "survivor" });
      await database.projects.save({
        ...doomed,
        settings: { ...doomed.settings, automation: [automation()] },
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
      expect(rowCount(database, "AutomationCommand")).toBe(0);
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

  test("removing a profile keeps the terminal that used it, with no profile", async () => {
    await withDatabase(async ({ database }) => {
      const owner = project();
      const profileValue = profile();
      await database.launchProfiles.save(profileValue);
      await database.projects.save({
        ...owner,
        settings: { ...owner.settings, defaultProfileID: profileValue.id },
      });

      const attached = terminal({ profileID: profileValue.id });
      const value = worktreeSession(owner.id, {
        terminals: [attached],
        layout: oneTab(attached.id),
      });
      await database.sessions.save(value);

      await database.launchProfiles.remove(profileValue.id);

      const read = await database.sessions.find(value.id);
      expect(read?.terminals).toHaveLength(1);
      expect(read?.terminals[0]?.profileID).toBeUndefined();
      expect((await database.projects.find(owner.id))?.settings.defaultProfileID).toBeUndefined();
    });
  });
});

function rowCount(database: TemporaryDatabase, table: string): number {
  const side = new Database(database.path, { readonly: true });
  try {
    return Number(
      side.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "${table}"`).get()?.n ?? -1,
    );
  } finally {
    side.close();
  }
}

// ---- Half-populated discriminators.

describe("a backing that is representable in SQL and meaningless in the domain", () => {
  test("a worktree session missing its ownership is refused, by name", async () => {
    await withDatabase(async ({ database, corrupt }) => {
      const owner = project();
      await database.projects.save(owner);
      const value = worktreeSession(owner.id);
      await database.sessions.save(value);

      corrupt(`UPDATE Session SET worktreeOwnership = NULL`);

      expect(reasonsOf(await failureOf(database.sessions.find(value.id)))).toEqual([
        "worktreeOwnership is not managed or adopted",
      ]);
      // `all()` is not more forgiving than `find()`: one bad row fails the list,
      // because a list quietly missing a session is worse than an error.
      expect(await failureOf(database.sessions.all())).toBeInstanceOf(CorruptRecord);
    });
  });

  test("worktree columns on a folder backing are refused, one reason per column", async () => {
    await withDatabase(async ({ database, corrupt }) => {
      const value = session();
      await database.sessions.save(value);
      corrupt(`UPDATE Session SET worktreeBranch = 'main', worktreeOwnership = 'managed'`);

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
      corrupt(`UPDATE Session SET projectId = NULL`);

      expect(reasonsOf(await failureOf(database.sessions.find(value.id)))).toEqual([
        "projectDirectory backing requires a project",
      ]);
    });
  });

  test("an unknown backing kind is refused", async () => {
    await withDatabase(async ({ database, corrupt }) => {
      const value = session();
      await database.sessions.save(value);
      corrupt(`UPDATE Session SET backingKind = 'symlink'`);

      expect(reasonsOf(await failureOf(database.sessions.find(value.id)))).toEqual([
        "backingKind is not folder, projectDirectory or worktree",
      ]);
    });
  });

  test("an unknown terminal role is refused, because a role decides what runs", async () => {
    await withDatabase(async ({ database, corrupt }) => {
      const value = session();
      await database.sessions.save(value);
      corrupt(`UPDATE Terminal SET role = 'daemon'`);

      expect(reasonsOf(await failureOf(database.sessions.find(value.id)))).toEqual([
        "terminal 0: role unknown",
      ]);
    });
  });

  test("an unknown accent degrades to none, with a warning", async () => {
    await withDatabase(async ({ database, records, corrupt }) => {
      const value = session({ accent: "pink" });
      await database.sessions.save(value);
      corrupt(`UPDATE Session SET accent = 'plaid'`);

      expect((await database.sessions.find(value.id))?.accent).toBe("none");
      expect(records).toContainEqual({
        level: "warning",
        message: "accent unknown, defaulted",
        fields: { table: "Session", id: value.id },
      });
    });
  });
});

// ---- Layout: repaired on the way out, refused on the way in.

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
      corrupt(`UPDATE Session SET layout = 'not json'`);

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

      // The other direction: encode refuses it, so the daemon never writes what
      // it would then have to truncate.
      const failure = await failureOf(database.sessions.save({ ...value, layout: tooDeep }));
      expect(failure).toBeInstanceOf(InvalidRecord);
      expect(reasonsOf(failure)).toContain(`tab 0: split tree deeper than ${MAXIMUM_PANE_DEPTH}`);
    });
  });
});

// ---- Writes that are refused, before any I/O.

describe("save refuses", () => {
  test("a layout naming a terminal the session does not have", async () => {
    await withDatabase(async ({ database }) => {
      const value = session();
      const ghost = newTerminalID();
      const failure = await failureOf(database.sessions.save({ ...value, layout: oneTab(ghost) }));

      expect(failure).toBeInstanceOf(InvalidRecord);
      // One reason, not two: the focus names a terminal the *tree* contains, so
      // `layoutViolations` has nothing to add about it.
      expect(reasonsOf(failure)).toEqual([`tab 0: pane names absent terminal ${ghost}`]);
      // Nothing was written: the row does not exist, rather than existing badly.
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

// ---- The profile id a session names must exist; that is the schema's rule.

describe("referential integrity", () => {
  test("a terminal naming a profile that does not exist is a caller bug that propagates", async () => {
    await withDatabase(async ({ database }) => {
      const orphan = terminal({ profileID: newLaunchProfileID() as LaunchProfileID });
      const value = session({ terminals: [orphan], layout: oneTab(orphan.id) });
      const failure = await failureOf(database.sessions.save(value));

      // Not an `InvalidRecord`: this is the database's foreign key doing its job,
      // and dressing it up as a repository rule would give us two copies of it.
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
