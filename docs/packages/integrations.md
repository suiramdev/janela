# @janela/integrations

The hooks Janela installs into other people's coding agents, and nothing else.

This package is not a runtime. It never runs while an agent works: it writes
configuration files, reads them back to say whether what it wrote is still there,
and removes them again. Everything that happens at the moment an agent changes
state happens inside the harness, in a hook the harness itself runs, against a
file this package wrote weeks earlier.

It sits on the daemon side because it touches `$HOME` and probes `PATH`. The
daemon exposes it over the protocol (`integrations`, `installIntegration`,
`removeIntegration`) so a future CLI installs the same hooks by the same path the
app does.

## The escape grammar

A hook's only job is to write one OSC sequence to one file descriptor:

```
ESC ] 7770 ; <payload> BEL
```

The payload is `working`, `waiting;permission`, `waiting;input`,
`finished;completed` or `finished;failed` — `formatAgentActivity` in
`@janela/core` is the only place that spelling exists, and both the shell
one-liner and the two JavaScript templates build their strings from it or from
`agentActivityEscape`. The number `7770` lives in `AGENT_ACTIVITY_OSC`. Nothing
in this package writes an escape by hand.

`@janela/terminal` parses the same sequence out of the terminal's byte stream.
The grammar is the contract between the two packages; this one only has to
produce it.

## `JANELA_TTY`

The hook writes to `$JANELA_TTY`, a variable Janela exports into every terminal
it spawns, and does nothing at all when it is unset.

That guard is the whole safety story. The user's `~/.claude/settings.json` is
one file, shared by every Claude Code they start — in Terminal.app, in an editor,
over SSH, from a cron job. A hook that wrote to `/dev/tty` would spray escape
sequences into terminals that have never heard of Janela. Because the variable
only exists in a PTY this daemon spawned, an agent run anywhere else executes
the hook, finds nothing, and exits. Installing a Janela integration therefore
changes nothing the user can observe outside Janela.

Writing to the path rather than to standard output matters for the same reason:
a hook's stdout belongs to the harness, which parses it as JSON.

## The shell one-liner

Claude Code and Codex both take a command string. It is identical for both, one
line, and it is exactly:

```sh
[ -n "$JANELA_TTY" ] && printf '\033]7770;<payload>\a' > "$JANELA_TTY" 2>/dev/null; printf '{}'
```

Two measured decisions are in that line.

**It never reads standard input.** An earlier draft began `cat >/dev/null 2>&1;`
to drain stdin so the harness could never see `EPIPE`. Measured against a real
Codex: Codex does not close stdin for its `Stop` hook, so `cat` blocked until the
ten-second timeout elapsed and Codex reported `hook: Stop Failed` — and the
`finished` report never arrived, which is the one report the feature exists for.
Claude Code was measured on the other side of the same question: a hook that
never reads a large stdin, across nineteen `PostToolUse` calls over a 400 KB
file, produced no hook error. Not reading stdin is safe on both and necessary on
one.

**It always prints `{}`.** Permission-style hooks fail closed on empty stdout —
an empty reply is read as a refusal, not as silence. Printing an empty object is
how a hook says "no opinion". The `;` before it, rather than `&&`, is deliberate:
the object is printed whether or not the report was written.

`isJanelaHookCommand` decides whether an entry in someone's config is ours. A
command is ours when it contains both `]7770;` and `$JANELA_TTY`. That pairing is
the marker; there is no comment, no name field, and no sentinel to get out of
sync with the command itself.

## What each harness gets

| Harness | Directory | File | Owned |
| --- | --- | --- | --- |
| Claude Code | `$CLAUDE_CONFIG_DIR` or `~/.claude` | `settings.json` | our entries only |
| Codex | `$CODEX_HOME` or `~/.codex` | `hooks.json`, `config.toml` | our entries and trust blocks only |
| OpenCode | `$XDG_CONFIG_HOME` or `~/.config` | `opencode/plugins/janela-activity.js` | the whole file |
| Oh My Pi | `$PI_CODING_AGENT_DIR` or `~/.omp/agent` | `extensions/janela-activity.ts` | the whole file |

The event maps:

**Claude Code** — `UserPromptSubmit` → working; `PreToolUse` with matcher
`AskUserQuestion` → waiting for input; `PermissionRequest` → waiting for
permission; `PostToolUse` → working; `Stop` → finished, completed;
`StopFailure` → finished, failed.

**Codex** — `UserPromptSubmit` → working; `PermissionRequest` → waiting for
permission; `PostToolUse` → working; `Stop` → finished, completed. Each handler
carries `timeout: 10`.

**OpenCode** — `session.status` busy → working, idle → finished, completed;
`session.idle` → finished, completed; `session.error` → finished, failed;
`permission.asked` and `permission.updated` → waiting for permission;
`question.asked` → waiting for input; `permission.replied`, `question.replied`
and `question.rejected` → working.

**Oh My Pi** — `agent_start` → working; `agent_end` → finished, completed;
`tool_approval_requested` → waiting for permission; `tool_approval_resolved` →
working; `tool_execution_start` and `tool_execution_end` for the `ask` tool →
waiting for input and working.

Claude Code and Codex hold a shared JSON shape — a `hooks` object of event name
to an array of entries — so one module reads, edits and reports on both. The
user's file is round-tripped: everything outside our entries is parsed and
written back untouched, re-serialised with a two-space indent and a trailing
newline. Removing our entries deletes an event key whose array emptied, and the
`hooks` key when nothing is left; a `settings.json` that held nothing but our
hooks is deleted rather than left as `{}`.

OpenCode and Oh My Pi take whole files Janela owns outright, so `installed`
means byte-equality with the template and `outdated` means any edit at all.

## Codex trust blocks

Codex will not run a hook it has not been told to trust. Trust lives in
`config.toml`, one block per handler:

```toml
[hooks.state."/Users/you/.codex/hooks.json:stop:0:0"]
trusted_hash = "sha256:a03ddc38…"
```

The key is `<absolute hooks.json path>:<label>:<groupIndex>:<handlerIndex>`,
where the label is Codex's own name for the event (`user_prompt_submit`,
`permission_request`, `post_tool_use`, `stop`), the group index is the position
of the entry within that event's array, and the handler index is the position
within the entry's `hooks` array.

The hash is the identity of what is being trusted. It is the SHA-256 of
`JSON.stringify` over the key-sorted object

```json
{ "event_name": "<label>", "hooks": [{ "async": false, "command": "…", "timeout": 10, "type": "command" }] }
```

plus a `matcher` member when the event is a tool event and a matcher was given.
`timeout` is clamped to at least one second, as Codex clamps it. This is not
guessed: `codex-trust.test.ts` asserts a hash Codex itself wrote into a real
`config.toml`, against the command that produced it.

The key is **index-based**, which is why the trust blocks are computed after the
`hooks.json` layout is known rather than alongside it. Appending our entry to an
event that already holds another tool's hook puts us at group index 1, and a
block naming index 0 would trust the wrong hook — the other tool's. Install
therefore builds the new document first, reads the indices our entries actually
landed on, and writes blocks for those.

`config.toml` is edited line-wise so the user's own bytes, comments and ordering
survive: a block runs from its `[hooks.state."…"]` header to the next `[` header
or end of file, ours are removed by key, and the new ones are appended at the end
after a blank line. A missing `config.toml` is created holding only our blocks.

`status` reports `outdated` when the hook entries are right but a trust block is
missing or holds a different hash. That is precisely the state in which Codex
stops and prompts the user, so it has to be visible as something to fix rather
than as `installed`.

Separately measured: `codex exec` runs `hooks.json` hooks without consulting the
trust blocks — `UserPromptSubmit` and `Stop` both fired. The trust mechanism is
what the interactive TUI checks, not the hook system as a whole.

## What this package does not do

- It does not read transcripts, session files or any other harness state.
- It does not parse a harness's output. The report is what the harness
  volunteers through its own hook API, nothing more.
- It does not run anything while an agent works. Every line it writes is a line
  the harness runs, in the harness's own process.
- It does not affect an agent running outside Janela. The `$JANELA_TTY` guard
  makes every installed hook a no-op there.
- It does not touch configuration it did not write. Foreign entries survive an
  install, an uninstall and a repair; a file it cannot parse is reported as
  `unreadable` and left exactly as it was found.

## Adding a harness

Three edits, in this order:

1. One id in `INTEGRATION_IDS` in `@janela/core`. It is a closed union, and the
   protocol schema derives from it.
2. One file here implementing `Integration` — `configPath`, `status`, `install`,
   `remove`, plus the `reports` strings Settings shows. A harness taking a JSON
   hooks file reuses `hook-document.ts`; one taking a whole file follows
   `opencode.ts`, building its escapes from `agentActivityEscape`.
3. One entry in `INTEGRATIONS` in `service.ts`. Order is the order Settings
   lists them.

The three `reports` strings are the only user-facing copy in the package, and
they say what the harness will make Janela show — not what was installed where.

## A note on OpenCode

The OpenCode plugin was written against its documented v1 plugin API and could
not be executed against a real OpenCode on the authoring machine. Its template is
loaded as ESM and driven through its event handler in `templates.test.ts`, so the
file is known to be valid, to report the right escape for each event it claims to
handle and to stay silent when `JANELA_TTY` is unset — but the event names
themselves are taken from the documentation rather than observed. The other three
were checked against real configuration written by the harnesses.
