# CLI Coding Agents and Git Worktree Mechanics — Primary Source Research

Scope: what Janela (native macOS agentic IDE, terminal-first, workspace-centric, worktree-aware)
must know to host Claude Code, OpenAI Codex CLI, and OpenCode as PTY-backed child processes, and
what git actually does when you create/enumerate/destroy worktrees.

Every non-obvious claim below cites the source that owns it (official docs, spec text, or repo
source file). No blog posts, no secondary write-ups. Retrieved 2026-02.

---

# PART A — CLI coding agents

## A1. Claude Code

### Invocation and process shape

- Interactive: `claude`. Non-interactive/headless: `claude -p "<prompt>"` (alias `--print`).
  Non-interactive mode reads stdin, so it composes as a normal Unix filter
  (`cat build-error.txt | claude -p '...' > output.txt`); piped stdin is **capped at 10 MB** and
  exceeding the cap exits non-zero.
  [Run Claude Code programmatically](https://code.claude.com/docs/en/headless.md)
- `--output-format` accepts `text` (default), `json`, `stream-json`. `stream-json` is
  newline-delimited JSON; the **last line is a `result` message** with final text, cost and session
  metadata. Real-time token streaming requires `--output-format stream-json --verbose
  --include-partial-messages`.
  [headless.md](https://code.claude.com/docs/en/headless.md)
- `--input-format {text,stream-json}` enables bidirectional NDJSON, and `--replay-user-messages`
  re-emits user messages on stdout for acknowledgment (requires both input and output to be
  `stream-json`). This is the closest thing to a supported "IDE drives the agent over pipes"
  protocol without adopting the SDK.
  [CLI reference](https://code.claude.com/docs/en/cli-reference.md)
- `--bare`: "Minimal mode: skip auto-discovery of hooks, skills, plugins, MCP servers, auto memory,
  and CLAUDE.md so scripted calls start faster." Sets `CLAUDE_CODE_SIMPLE`. In bare mode Claude Code
  **never reads OAuth credentials or the system keychain** — `ANTHROPIC_API_KEY` is required. Docs
  state bare "will become the default for `-p` in a future release."
  [cli-reference.md](https://code.claude.com/docs/en/cli-reference.md),
  [headless.md](https://code.claude.com/docs/en/headless.md)
- `--safe-mode`: starts with all customizations disabled (CLAUDE.md, skills, plugins, hooks, MCP,
  custom commands/agents, output styles, workflows, themes, keybindings, status line, LSP). Sets
  `CLAUDE_CODE_SAFE_MODE`. Useful as Janela's "reproduce without user config" escape hatch.
  [cli-reference.md](https://code.claude.com/docs/en/cli-reference.md)

### Session resume

- `--resume`/`-r` takes a **session ID or a name**, or opens an interactive picker. "When you pass a
  session ID, Claude Code searches the current project directory **and its git worktrees**, then
  every other project on this machine."
- `--continue`/`-c` continues the most recent session; `--fork-session` creates a new session ID
  instead of reusing the original (use with `--resume`/`--continue`).
- `--session-id <uuid>` forces a specific session ID (must be a valid UUID) — this is the hook for
  an IDE that wants to own session identity.
- `--name`/`-n` sets a display name shown in `/resume` **and the terminal title**; a named session
  can be resumed by name.
- `--no-session-persistence` (print mode only) disables on-disk persistence.
  [cli-reference.md](https://code.claude.com/docs/en/cli-reference.md)

### Background / multi-session surface (directly relevant to "many concurrent sessions")

- `--bg`/`--background` starts the session as a background agent and returns immediately, printing
  the session ID and management commands. **Cannot be combined with `-p`/`--print`.**
- `claude agents` opens the agent view; `--cwd <path>` filters to sessions started under that
  directory and `--json` prints active sessions as a JSON array (`--json --all` includes completed
  background sessions). **"Opening agent view requires an interactive terminal."**
- `claude attach <id>` attaches to a background session; `claude rm <id>` removes it from the list
  while keeping the transcript resumable via `claude --resume`.
  [cli-reference.md](https://code.claude.com/docs/en/cli-reference.md)

Implication: Claude Code already models "many sessions, some detached" and exposes it as machine
readable JSON (`claude agents --json`). An IDE should read that rather than invent its own registry.

### Config file locations and precedence

- Settings files: `~/.claude/settings.json` (user), `.claude/settings.json` (project, committable),
  `.claude/settings.local.json` (project-local, gitignored when Claude Code writes to it), plus
  managed policy settings. Merge order: managed first, then **local > project > user**, with CLI
  flags and env vars as a further override layer.
  [settings](https://code.claude.com/docs/en/settings.md),
  [debug-your-config](https://code.claude.com/docs/en/debug-your-config)
- `CLAUDE_CONFIG_DIR` overrides `~/.claude` entirely: "All settings, session history, and plugins are
  stored under this path, as are credentials on Linux and Windows; on macOS, credentials are in the
  system Keychain." Docs give the multi-account alias pattern
  (`CLAUDE_CONFIG_DIR=~/.claude-work claude`).
  [env-vars](https://code.claude.com/docs/en/env-vars.md)

### CLAUDE.md / AGENTS.md discovery (exact algorithm)

From [How Claude remembers your project](https://code.claude.com/docs/en/memory.md):

1. Load order, broadest → narrowest: managed policy CLAUDE.md
   (`/Library/Application Support/ClaudeCode/CLAUDE.md` on macOS) → `~/.claude/CLAUDE.md` →
   `./CLAUDE.md` or `./.claude/CLAUDE.md` → `./CLAUDE.local.md`.
2. Discovery walks **up** the directory tree from cwd, checking each directory for `CLAUDE.md` and
   `CLAUDE.local.md`. All discovered files are concatenated (not overridden), ordered filesystem
   root → cwd. Within a directory, `CLAUDE.local.md` is appended after `CLAUDE.md`.
3. Files in **subdirectories** below cwd are discovered but loaded lazily, when Claude reads files
   in those subdirectories.
4. `@path/to/file` imports are expanded at launch, max depth 4 hops, relative to the importing file.
   Imports inside code spans/fences are skipped. External imports (outside the working directory)
   trigger a one-time approval dialog, except in user-scope memory files.
5. **Claude Code does not read `AGENTS.md`.** The documented interop is `@AGENTS.md` inside
   `CLAUDE.md`, or `ln -s AGENTS.md CLAUDE.md`.
6. `.claude/rules/*.md` are discovered recursively; rules without `paths:` frontmatter load at launch
   with the same priority as `.claude/CLAUDE.md`; `paths:`-scoped rules load on demand.
7. `claudeMdExcludes` (glob against absolute paths, mergeable across settings layers) suppresses
   ancestor CLAUDE.md files — the monorepo escape hatch. Managed policy CLAUDE.md cannot be excluded.
8. `--add-dir` does **not** load memory from the added directory unless
   `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`.
9. Worktree-relevant: "If you work across multiple git worktrees of the same repository, a gitignored
   `CLAUDE.local.md` only exists in the worktree where you created it."

### Hooks (the machine-readable state channel)

[Hooks reference](https://code.claude.com/docs/en/hooks.md). Events fall into three cadences:
once per session (`SessionStart`, `SessionEnd`), once per turn (`UserPromptSubmit`, `Stop`,
`StopFailure`), and per tool call (`PreToolUse`, `PostToolUse`). Standalone async events include
`Notification`, `ConfigChange`, `InstructionsLoaded`, `CwdChanged`, `FileChanged`, `DirectoryAdded`,
`WorktreeCreate`, `WorktreeRemove`, `TeammateIdle`.

Key mechanics for an IDE:

- Hook input arrives as JSON on **stdin** (command hooks) or as an HTTP POST body (http hooks).
  Common fields include `session_id`, `transcript_path`, `cwd`, `hook_event_name`.
- **"Hooks run without a controlling terminal."** The hook process and its children cannot open
  `/dev/tty` or write escape sequences to the Claude Code interface.
- To emit terminal side effects a hook returns `{"terminalSequence": "..."}` and Claude Code writes
  it through its own terminal write path. The allowlist is **OSC `0`/`1`/`2`/`9`/`99`/`777` and BEL**
  — anything else and the field is ignored. Docs: "This is race-free, works inside tmux and GNU
  screen, and works on Windows where there is no `/dev/tty`." Requires v2.1.141+.
  Also: Claude Code writes the sequence **only in an interactive session and only while its interface
  is on screen**; in `-p` mode and the SDK the field is ignored.
- `Stop` / `SubagentStop` hooks carry `last_assistant_message`; docs explicitly warn that
  `transcript_path` "is written asynchronously and may lag the in-memory conversation", so hooks
  needing the final turn text must use `last_assistant_message`, not the transcript file.
- `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` are substituted and also
  exported into the hook process env.
- Exit-code semantics are non-obvious: for most events **only exit 2 blocks**; exit 1 is a
  non-blocking error. The exception is `WorktreeCreate`, where **any non-zero exit aborts** worktree
  creation.

### "Waiting for input" vs "finished" — Claude Code's own answer

`Notification` hook matcher values are the authoritative state vocabulary
([hooks.md](https://code.claude.com/docs/en/hooks.md)):

| matcher | fires when |
| --- | --- |
| `permission_prompt` | Claude needs tool approval and you haven't typed for ~6s |
| `idle_prompt` | Claude finished responding ~60s ago and you haven't typed since |
| `auth_success` | authentication completed |
| `elicitation_dialog` / `elicitation_url_dialog` | MCP elicitation open, ~6s gate |
| `agent_needs_input` | a **background session** starts waiting on input (agent view open, v2.1.198+) |
| `agent_completed` | a background session finishes or fails (agent view open, v2.1.198+) |

Critical timing detail: `permission_prompt`, `idle_prompt` and the elicitation types are gated on
"you appear to be away" — 6s of no typing for prompts, ~60s after a turn for idle. **They are not
immediate turn-boundary signals.** For an immediate signal on every permission ask, docs say to use
the `PermissionRequest` event instead. For immediate turn-end, use `Stop`/`StopFailure`.

### What Claude Code emits to the terminal

- **Desktop notifications by default only in Ghostty, Kitty and iTerm2.** In other terminals you set
  `preferredNotifChannel: "terminal_bell"` in `settings.json` to ring BEL instead, or configure a
  `Notification` hook. iTerm2 additionally requires Settings → Profiles → Terminal → "Notification
  Center Alerts" + "Filter Alerts" → "Send escape sequence-generated alerts".
  [terminal-config](https://code.claude.com/docs/en/terminal-config.md)
- The documented hook example emits `printf '\033]777;notify;%s;%s\007' "$title" "$body"` — i.e.
  **OSC 777 `notify`** is the canonical Claude Code desktop-notification sequence, with OSC 9 and
  OSC 99 also allowlisted. [hooks.md](https://code.claude.com/docs/en/hooks.md)
- Under tmux, notifications and the progress bar require `set -g allow-passthrough on`; Shift+Enter
  requires `set -s extended-keys on` and `set -as terminal-features 'xterm*:extkeys'`.
  [terminal-config](https://code.claude.com/docs/en/terminal-config.md)
- Rendering: default mode is **inline (scrollback-preserving)**, not alt-screen. There is an opt-in
  fullscreen renderer (`/tui fullscreen`) where "you scroll with the mouse or PageUp inside Claude
  Code rather than with your terminal's native scrollback". Flicker is handled via **DEC private mode
  2026 synchronized output**; `CLAUDE_CODE_FORCE_SYNC_OUTPUT=1` forces it on for emulators that
  implement BSU/ESU but do not answer the capability probe (**no effect under tmux**), and
  `CLAUDE_CODE_NO_FLICKER` exists as a separate knob.
  [terminal-config](https://code.claude.com/docs/en/terminal-config.md),
  [env-vars](https://code.claude.com/docs/en/env-vars.md)
- TTY requirement: agent view explicitly "requires an interactive terminal"; `-p` mode does not
  (it is designed for pipes, and it ignores `terminalSequence`). So Claude Code needs a **real PTY
  for interactive/agent-view use** and works fine on pipes only in print mode.

### Environment variables worth wiring in Janela

`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` (disables auto-update, telemetry,
error reporting, `/feedback`, release notes, gateway model discovery, availability checks),
`DISABLE_TELEMETRY`, `DO_NOT_TRACK`, `CLAUDE_CODE_FORCE_SYNC_OUTPUT`, `CLAUDE_CODE_NO_FLICKER`,
`MAX_THINKING_TOKENS`, `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`, `CLAUDE_CODE_SIMPLE` (set by
`--bare`), `CLAUDE_CODE_SAFE_MODE` (set by `--safe-mode`), `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT`.
Boolean parsing is inconsistent by design: some variables read only whether they are set at all, so
even `0` turns them on — the docs enumerate that set explicitly.
[env-vars](https://code.claude.com/docs/en/env-vars.md)

Note also: Claude Code **strips `OTEL_*` exporter variables** from the hook process environment.
[hooks.md](https://code.claude.com/docs/en/hooks.md)

---

## A2. OpenAI Codex CLI

Repo: <https://github.com/openai/codex>. Note the repo's `docs/config.md` is now a stub that
redirects to `developers.openai.com/codex/...`
([raw docs/config.md](https://raw.githubusercontent.com/openai/codex/main/docs/config.md)) — cite the
developers site, not the repo markdown.

### Invocation

- `codex` starts the interactive TUI; `codex exec` is the non-interactive path
  ("For non-interactive runs, use `codex exec --sandbox workspace-write`; Codex keeps older
  `codex exec --full-auto` invocations as a deprecated compatibility path and prints a warning").
  [Agent approvals & security](https://developers.openai.com/codex/agent-approvals-security)
- `codex resume` reopens a recent chat from the current repository or searches across local chats.
  [Codex CLI](https://developers.openai.com/codex/cli)
- Other documented entry points: `codex app`, `codex cloud`, `codex mcp`, `codex completion`,
  `codex sandbox macos|linux|windows` (aliased `codex debug`, `codex sandbox seatbelt`).
- Install on macOS arm64: `codex-aarch64-apple-darwin.tar.gz` from GitHub Releases, or
  `brew install --cask codex`, or `npm i -g @openai/codex`.
  [README](https://raw.githubusercontent.com/openai/codex/main/README.md)

### Architecture (matters for IDE hosting)

Codex's TUI is a thin client over an **app server**. `codex-rs/tui/src/lib.rs` defines
`AppServerTarget::{Embedded, LocalDaemon{endpoint}, Remote{endpoint}}` and
`resolve_remote_addr()` accepts `ws://host:port`, `wss://host:port`, `unix://`, or `unix://PATH`;
`maybe_probe_default_daemon_socket()` probes the default control socket with a 50 ms timeout
(`AUTO_CONNECT_DAEMON_CONNECT_TIMEOUT`) and silently falls back to an embedded server.
[codex-rs/tui/src/lib.rs](https://github.com/openai/codex/blob/main/codex-rs/tui/src/lib.rs)
(symbols `AppServerTarget`, `resolve_remote_addr`, `maybe_probe_default_daemon_socket`,
`app_server_target_for_launch`, ~lines 250–520 of the 3.4k-line file)

The same file imports `codex_protocol::config_types::AltScreenMode` and declares modules
`notifications`, `terminal_title`, `terminal_probe`, `terminal_hyperlinks`, `custom_terminal`,
`insert_history` — i.e. Codex does its own scrollback insertion and alt-screen management and
probes terminal capabilities. Treat it as requiring a **real PTY with full capability negotiation**.

### Config

- Layer precedence, highest first: CLI flags and `-c/--config` overrides → project
  `.codex/config.toml` from project root down to cwd (closest wins, **trusted projects only**) →
  profile files `~/.codex/profile-name.config.toml` selected with `--profile` → `~/.codex/config.toml`
  → `/etc/codex/config.toml` → built-in defaults.
  [Config basics](https://developers.openai.com/codex/local-config)
- Marking a project untrusted skips all project `.codex/` layers including project hooks and rules.
  `projects.<path>.trust_level` = `"trusted"|"untrusted"` — and the docs note it applies to a
  **project or worktree**. [Config reference](https://developers.openai.com/codex/config-reference)
- Managed machines can enforce `requirements.toml` (e.g. forbidding `approval_policy = "never"` or
  `sandbox_mode = "danger-full-access"`).

Config keys Janela will care about (all from
[Configuration Reference](https://developers.openai.com/codex/config-reference)):

| key | meaning |
| --- | --- |
| `sandbox_mode` | `read-only` \| `workspace-write` \| `danger-full-access` |
| `approval_policy` | `untrusted` \| `on-request` \| `never` \| `{ granular = {...} }` |
| `sandbox_workspace_write.writable_roots` / `.network_access` / `.exclude_slash_tmp` / `.exclude_tmpdir_env_var` | sandbox surface |
| `notify` | "Command invoked for notifications; receives a JSON payload from Codex" |
| `hooks.<Event>[]` | inline lifecycle hooks; events `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `UserPromptSubmit`, `Stop` |
| `project_doc_fallback_filenames` | additional filenames tried when `AGENTS.md` is missing |
| `project_doc_max_bytes` | max bytes read from `AGENTS.md` |
| `project_root_markers` | filenames used to find the project root when walking parents |
| `model_instructions_file` | replaces built-in instructions instead of `AGENTS.md` |
| `log_dir` | log location; setting it also enables the plaintext `codex-tui.log` |
| `shell_environment_policy.{filters,set,inherit,exclude}` | what env reaches spawned commands; `ignore_default_excludes` defaults to `true`, i.e. names containing `KEY`/`SECRET`/`TOKEN` are **not** auto-filtered unless you set it to `false` |
| `history.persistence` | `save-all` \| `none` (transcripts in `history.jsonl` under `CODEX_HOME`) |
| `sqlite_home` | SQLite-backed state DB for agent jobs and resumable runtime state |
| `features.unified_exec` | "Use the unified PTY-backed exec tool" (default true except Windows) |

`CODEX_HOME` is the root for logs/history/state (`log_dir` defaults to `$CODEX_HOME/log`).

### AGENTS.md discovery

Codex is the reference implementation of AGENTS.md. Source lives in
`codex-rs/core/src/agents_md.rs` (16.9 KB), with `agents_md_manager.rs` and a 55 KB
`agents_md_tests.rs`
([directory listing via GitHub contents API](https://api.github.com/repos/openai/codex/contents/codex-rs/core/src)).
Behavior is tunable via `project_doc_fallback_filenames`, `project_doc_max_bytes`, and
`project_root_markers` (above), i.e. **discovery is a parent-walk to a project root marker, with a
byte cap**. The spec-level contract — nearest `AGENTS.md` wins, nested files per subproject — is at
[agents.md](https://agents.md/).

### Sandbox modes (macOS specifics)

From [Agent approvals & security](https://developers.openai.com/codex/agent-approvals-security):

- macOS enforcement is **Seatbelt**: "runs commands using `sandbox-exec` with a profile (`-p`) that
  corresponds to the `--sandbox` mode you selected." Linux uses `bwrap` + `seccomp`.
- Default preset ("Auto") = `--sandbox workspace-write --ask-for-approval on-request`. Workspace =
  cwd plus temp dirs like `/tmp`; inspect with `/status`.
- **Protected paths inside writable roots**: `<root>/.git` is read-only whether directory or file;
  if `<root>/.git` is a **pointer file (`gitdir: ...`) — i.e. a linked worktree — the resolved git
  directory is also protected read-only**. `<root>/.agents` and `<root>/.codex` are read-only when
  present. Protection is recursive.
- `--yolo` = `--dangerously-bypass-approvals-and-sandbox`.
- On launch Codex recommends `Auto` for version-controlled folders and `read-only` otherwise, and
  may start read-only until the working directory is explicitly trusted.

The `.git`-pointer-file rule is the single most worktree-relevant fact here: Codex resolves the
gitfile indirection and protects the real `$GIT_DIR` under `.git/worktrees/<id>`.

---

## A3. OpenCode (sst/opencode)

### Invocation and split

- Bare `opencode` starts the TUI **and a server**; "the TUI is the client that talks to the server."
  `opencode serve` runs a standalone headless server (default `--port 4096`,
  `--hostname 127.0.0.1`); if a TUI is already running, `serve` starts a *new* server.
  When the TUI starts on its own it **randomly assigns a port and hostname** unless you pass
  `--hostname`/`--port`. [Server](https://opencode.ai/docs/server/)
- `opencode attach [url]` attaches a TUI to an already-running backend (`serve`/`web`), with
  `--dir`, `-c/--continue`, `-s/--session`, `--fork`, basic-auth flags.
  [CLI](https://opencode.ai/docs/cli/)
- `opencode run [message..]` is the non-interactive path, with `--format default|json` (raw JSON
  events), `--attach <url>` to reuse a running server and skip MCP cold-boot, `-c/--continue`,
  `-s/--session`, `--fork`, `--agent`, `--auto` (auto-approve non-denied permissions).
- `opencode acp` starts an **Agent Client Protocol** server speaking nd-JSON over stdin/stdout.
- Auth is stored at `~/.local/share/opencode/auth.json`.
- `opencode serve`/`web` support HTTP basic auth via `OPENCODE_SERVER_PASSWORD` /
  `OPENCODE_SERVER_USERNAME`.

### HTTP surface (the cleanest state channel of the three)

[Server](https://opencode.ai/docs/server/):

- `GET /doc` — OpenAPI 3.1 spec (used to generate the SDK).
- `GET /event` — **server-sent events stream; first event is `server.connected`, then bus events.**
- `GET /global/event` — global SSE stream. `GET /global/health` → `{healthy, version}`.
- `GET /project`, `GET /project/current`.
- `/tui/control/next` (wait for next control request) and `POST /tui/control/response` — the
  documented way to *drive* the TUI from outside; "This setup is used by the OpenCode IDE plugins."

### Config

- Global server/runtime config: `~/.config/opencode/opencode.json` (schema
  `https://opencode.ai/config.json`). **TUI config is a separate file**: `~/.config/opencode/tui.json`
  (schema `https://opencode.ai/tui.json`), with a project-local `tui.json` alongside project config.
  JSONC accepted. [Config](https://opencode.ai/docs/config/)
- Config discovery: files are collected walking from the project root toward the current directory,
  then the same for files inside `.opencode` directories — so a `.opencode` config **overrides a
  closer plain config**. [Config](https://opencode.ai/v2/docs/config)
- `tui.json` keys include `theme`, `keybinds` (with `leader`), `scroll_speed`,
  `scroll_acceleration`, `diff_style`, `cursor.{style,blinking}`, **`mouse`**, and
  **`attention: { enabled, notifications, sound, volume }`** — OpenCode's built-in "agent wants you"
  channel. [TUI](https://opencode.ai/docs/tui/)

### AGENTS.md discovery and Claude Code compatibility

[Rules](https://opencode.ai/docs/rules/): lookup order is (1) local files by traversing up from cwd
(`AGENTS.md`, then `CLAUDE.md`), (2) global `~/.config/opencode/AGENTS.md`, (3)
`~/.claude/CLAUDE.md`. First match wins **per category**. Additional files come from the
`instructions` array in `opencode.json` (globs and remote URLs allowed; remote fetch timeout 5 s).
Disable Claude compat with `OPENCODE_DISABLE_CLAUDE_CODE`,
`OPENCODE_DISABLE_CLAUDE_CODE_PROMPT`, `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`.

### Env vars an IDE should set

From [CLI § Environment variables](https://opencode.ai/docs/cli/): `OPENCODE_CONFIG`,
`OPENCODE_TUI_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT` (inline JSON),
`OPENCODE_DISABLE_AUTOUPDATE`, **`OPENCODE_DISABLE_TERMINAL_TITLE`**, **`OPENCODE_DISABLE_MOUSE`**
("Disable mouse capture in the TUI"), `OPENCODE_PERMISSION` (inline JSON permissions),
`OPENCODE_DISABLE_LSP_DOWNLOAD`, `OPENCODE_DISABLE_PRUNE`, `OPENCODE_CLIENT` (defaults `cli`),
`OPENCODE_SERVER_PASSWORD`/`_USERNAME`. `OPENCODE_EXPERIMENTAL_WORKSPACES` exists but is
experimental.

`OPENCODE_DISABLE_MOUSE` is direct evidence that OpenCode **captures the mouse by default** — a
terminal host must implement mouse reporting (SGR 1006 et al.) or provide a way to turn it off.

---

## A4. What all three have in common, and how to detect agent state from a PTY

### Common shape

1. **Interactive TUI + a non-interactive/print mode** (`claude -p`, `codex exec`, `opencode run`),
   all with a JSON output format (`--output-format stream-json` / `--format json`).
2. **Session identity + resume** (`claude --resume/--session-id/--fork-session`, `codex resume`,
   `opencode --session/--continue/--fork`).
3. **Layered config**: user home → project → local, with a documented precedence and an env var to
   relocate the config root (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `OPENCODE_CONFIG_DIR`).
4. **A project instruction file discovered by parent-walk** (`CLAUDE.md` / `AGENTS.md`), with
   documented cross-reading between them.
5. **A sandbox/permission mode axis** that an IDE should surface as a first-class control
   (`--permission-mode`, `--sandbox`/`--ask-for-approval`, `OPENCODE_PERMISSION`/`--auto`).
6. **A lifecycle-hook system** that is the only *reliable* structured state channel
   (Claude hooks, Codex `hooks.<Event>` + `notify`, OpenCode `/event` SSE).

### Detecting "waiting for input" vs "finished" from a PTY stream

Ranked by reliability, all primary-sourced:

**Tier 1 — out-of-band structured signals (use these).**

- Claude Code: `Notification` hook (`permission_prompt`, `idle_prompt`, `agent_needs_input`,
  `agent_completed`), `PermissionRequest` for immediate approval asks, `Stop`/`StopFailure` for turn
  end. [hooks.md](https://code.claude.com/docs/en/hooks.md)
- Codex: `notify = ["<cmd>"]` — "Command invoked for notifications; receives a JSON payload from
  Codex" — plus `hooks.Stop`, `hooks.PermissionRequest`, `hooks.SessionEnd`.
  [config-reference](https://developers.openai.com/codex/config-reference)
- OpenCode: `GET /event` SSE bus. [Server](https://opencode.ai/docs/server/)

**Tier 2 — in-band OSC notifications the agents actually emit.**

- Claude Code's allowlist is exactly **OSC 0/1/2 (titles), OSC 9, OSC 99, OSC 777, and BEL**, and its
  own documented example uses `ESC ] 777 ; notify ; <title> ; <body> BEL`.
  [hooks.md](https://code.claude.com/docs/en/hooks.md)
- OSC 99 is kitty's extensible desktop-notification protocol; it supports feature querying
  (`OSC 99 ; i=<id> : p=? ST`, answered with `key=value` pairs), and the documented probe technique is
  "send the query action followed by a request for primary device attributes — if DA1 answers and the
  query does not, the terminal doesn't support it."
  [kitty desktop notifications](https://sw.kovidgoyal.net/kitty/desktop-notifications/)
- Practical consequence: a terminal that implements OSC 9, OSC 777 `notify`, OSC 99 and BEL captures
  essentially all agent-originated attention signals **without** any hook configuration.

**Tier 3 — OSC 133 semantic prompt marks (do not rely on these for agents).**

- The spec is the FinalTerm-derived
  [semantic-prompts proposal](https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/semantic-prompts.md):
  `OSC 133;A` prompt start, `;B` command input start, `;C` output start, `;D` command finished with
  exit code.
- Ghostty parses the full spec including the `aid`, `cl`, `prompt_kind`, `err`, `cmdline`,
  `cmdline_url`, `redraw` and `click_events` options —
  [`src/terminal/osc/parsers/semantic_prompt.zig`](https://github.com/ghostty-org/ghostty/blob/d31ac2be/src/terminal/osc/parsers/semantic_prompt.zig)
  (`pub const Option = enum { aid, cl, prompt_kind, err, cmdline, cmdline_url, redraw, ... }`);
  the `redraw` option is kitty's, extended by Ghostty with `last`.
  Ghostty 1.3.0 shipped `click-events` and `cl=line`
  ([release notes](https://ghostty.org/docs/install/release-notes/1-3-0)); region-based (vs
  row-based) semantic prompts are still open work
  ([ghostty#5932](https://github.com/ghostty-org/ghostty/issues/5932)).
- **These marks are emitted by shell integration, not by the agents.** Ghostty injects integration
  for bash/elvish/fish/nushell/zsh and it "will be lost" if you exec another shell inside the session
  ([Shell Integration](https://ghostty.org/docs/features/shell-integration)). So OSC 133 tells you
  where the *shell* prompt is — useful for `janela`'s shell terminals, useless for detecting whether
  Claude Code is mid-turn.

**Tier 4 — heuristics on the raw stream (last resort).** BEL, cursor-position, alt-screen
enter/leave, and title changes (agents set titles: Claude Code shows the session `--name` in the
terminal title; OpenCode has `OPENCODE_DISABLE_TERMINAL_TITLE`; Codex has a `terminal_title` module).
Title change is the cheapest cross-agent progress hint but is not a state machine.

### AGENTS.md convention

[agents.md](https://agents.md/) — "a README for agents", plain Markdown, no required fields.
Documented rules: nested `AGENTS.md` files per subproject, **"agents automatically read the nearest
file in the directory tree, so the closest one takes precedence"**, and "the closest AGENTS.md to the
edited file wins; explicit user chat prompts override everything." Stewarded by the Agentic AI
Foundation (Linux Foundation); originated with OpenAI Codex, Amp, Jules, Cursor, Factory.
Reader status among our three: **Codex reads it natively** (`project_doc_fallback_filenames`,
`agents_md.rs`); **OpenCode reads it natively with `CLAUDE.md` fallback**
([Rules](https://opencode.ai/docs/rules/)); **Claude Code does not** and requires `@AGENTS.md` import
or a symlink ([memory.md](https://code.claude.com/docs/en/memory.md)).

---

# PART B — git worktree mechanics

All statements in B1–B4 are from
[git-worktree(1)](https://git-scm.com/docs/git-worktree) and
[gitrepository-layout(5)](https://git-scm.com/docs/gitrepository-layout) unless noted.

## B1. Commands and semantics

- `git worktree add [-f] [--detach] [--checkout] [--lock [--reason <s>]] [--orphan] [(-b|-B) <branch>] <path> [<commit-ish>]`
- With no `<commit-ish>` and no `-b/-B/--detach`, git creates a branch named `$(basename <path>)`;
  if that branch already exists and is checked out elsewhere, **add refuses** unless `--force`.
- `<commit-ish>` may be a bare `-`, meaning `@{-1}`.
- If `<branch>` doesn't exist locally but exists in exactly one remote, add behaves as
  `--track -b <branch> <path> <remote>/<branch>`; `checkout.defaultRemote` disambiguates.
  `worktree.guessRemote` makes the remote-guessing behavior the default.
- `-d`/`--detach` → detached HEAD. `-B` resets an existing branch. `--orphan` creates an empty index
  and an unborn branch.
- `--no-checkout` "can be used to suppress checkout in order to make customizations, such as
  configuring sparse-checkout."
- `--lock [--reason]` at add time is "the equivalent of `git worktree lock` after `git worktree add`,
  but without a race condition."
- `--relative-paths` / `worktree.useRelativePaths` links worktrees with relative paths; setting it
  true **implies `extensions.relativeWorktrees`, making the repo incompatible with older git**.
- `remove` only removes clean worktrees; unclean ones or ones with submodules need `--force`;
  a locked worktree needs `--force --force`. **The main worktree cannot be removed.**
- `move` cannot move the main worktree or linked worktrees containing submodules.
- `prune` removes `$GIT_DIR/worktrees` entries whose working trees are missing; automatic pruning is
  governed by `gc.worktreePruneExpire`.
- `repair` reestablishes links after a manual move of the main worktree or of linked worktrees.
- Worktree identification accepts a unique trailing path component (`ghi` or `def/ghi` for
  `/abc/def/ghi`).

### Refs sharing rules (non-obvious)

"In general, all pseudo refs are per-worktree and all refs starting with `refs/` are shared…
There are exceptions: refs inside `refs/bisect`, `refs/worktree` and `refs/rewritten` are not
shared." Per-worktree refs of another worktree are reachable via the `main-worktree/…` and
`worktrees/<id>/…` pseudo-paths. The docs are explicit: "To access refs, it's best not to look inside
`$GIT_DIR` directly. Instead use commands such as `git rev-parse` or `git update-ref`."

## B2. On-disk layout

- Linked worktree root contains a **`.git` *file*** (a "gitfile") holding `gitdir: <path>`, pointing
  at `$GIT_DIR/worktrees/<id>`. `<id>` is normally the basename of the worktree path, suffixed with a
  number on collision (`test-next`, `test-next1`).
- Inside a linked worktree, `$GIT_DIR` = `<main>/.git/worktrees/<id>` and `$GIT_COMMON_DIR` =
  `<main>/.git`.
- `worktrees/<id>/gitdir` is "a text file containing the absolute path back to the .git file that
  points to here… **The mtime of this file should be updated every time the linked repository is
  accessed.**" (gitrepository-layout) — that mtime is what makes prune-expiry work.
- `worktrees/<id>/locked` — presence blocks pruning; contents are the reason string.
- `worktrees/<id>/config.worktree` — read after `.git/config`, only when
  `extensions.worktreeConfig` is enabled.
- `commondir` file: sets `$GIT_COMMON_DIR` if not explicitly set; "The repository with commondir is
  incomplete without the repository pointed by commondir."
- **Shared via `$GIT_COMMON_DIR` (i.e. one copy for all worktrees):** `config`, `hooks`, `info`
  (including `info/exclude` and `info/sparse-checkout`), `objects`, `logs`, `shallow`, `branches`.
  Each of these is documented as "ignored if $GIT_COMMON_DIR is set and $GIT_COMMON_DIR/<x> will be
  used instead."
- **Per-worktree:** `HEAD`, `index`, and the other pseudo refs.
- Rule of thumb from the docs: "do not make any assumption about whether a path belongs to `$GIT_DIR`
  or `$GIT_COMMON_DIR`… Use `git rev-parse --git-path` to get the final path."

### Worktree-specific config

`git config extensions.worktreeConfig true` moves per-worktree config to
`git rev-parse --git-path config.worktree`, writable via `git config --worktree`. When enabled, the
special-casing of `core.bare`/`core.worktree` disappears and you **must** move them yourself. Docs
call out that `core.worktree` should never be shared, `core.bare=true` should not be shared, and
`core.sparseCheckout` should not be shared unless every worktree is sparse. **Older git refuses to
access repositories with this extension.**

## B3. What breaks

- **Submodules.** The BUGS section is blunt: "Multiple checkout in general is still experimental, and
  the support for submodules is incomplete. It is NOT recommended to make multiple checkouts of a
  superproject." Concretely: `worktree move` refuses worktrees containing submodules, and
  `worktree remove` needs `--force` for them.
- **Hooks.** `hooks/` lives in the common dir, so *every* worktree runs the *same* hook scripts, from
  the main repository, regardless of what the worktree's own checkout contains. A hook that assumes
  `cwd == main worktree` will misbehave.
- **Sparse-checkout.** `info/sparse-checkout` is a common-dir file, and `core.sparseCheckout` is a
  shared config key unless `extensions.worktreeConfig` is on — hence the explicit warning that
  `core.sparseCheckout` "should not be shared, unless you are sure you always use sparse checkout for
  all worktrees." Per-worktree sparse checkout is only correct with `extensions.worktreeConfig` +
  `config.worktree`. The intended creation recipe is `git worktree add --no-checkout`, then configure
  sparse-checkout, then check out.
- **Index state.** The index is per-worktree, so staged state does not leak — but it also means every
  new worktree starts with a **cold index and cold stat cache**; the first `git status` in a new
  worktree lstat()s the whole tree.
- **Ignored files (LFS, `node_modules`, `.env`).** `git worktree add` performs a checkout, so
  gitattributes smudge filters (git-lfs is implemented as a clean/smudge filter) run for every
  filtered file, and **nothing that is gitignored exists in the new worktree at all**.
- **`core.bare` / `core.worktree`** in a shared `config` apply to the main worktree only when
  `extensions.worktreeConfig` is disabled — a subtle trap when converting a repo to bare + worktrees.

## B4. Enumerating and classifying worktrees programmatically

Use `git worktree list --porcelain -z`. The format is contractually stable: "This format will remain
stable across Git versions and regardless of user configuration. It is recommended to combine this
with `-z`." `-z` NUL-terminates records so **worktree paths containing newlines parse correctly**,
and it also disables the `core.quotePath` escaping/quoting that the non-`-z` porcelain applies to
lock reasons.

Record grammar: one attribute per line, `label value` or bare `label` for booleans; the first
attribute of a record is always `worktree`; an empty line ends the record. Attributes:

```
worktree <path>
bare                          # boolean, main bare repo
HEAD <40-hex>
branch refs/heads/<name>      # absent when detached
detached                      # boolean
locked [<reason>]             # label-only or with reason
prunable <reason>             # e.g. "gitdir file points to non-existent location"
```

- **Locked** → `locked` attribute (equivalently: `worktrees/<id>/locked` exists).
- **Prunable** → `prunable` attribute; `git worktree list --expire <time>` annotates missing
  worktrees as prunable only if older than `<time>`; `git worktree prune -n -v` dry-runs.
- **Dirty** is *not* in the worktree list output. Get it per worktree with
  `git -C <path> status --porcelain=v2 -z` (or `--porcelain -z`). Under `-z`, "pathnames are printed
  as is and without any quoting and lines are terminated with a NUL"; in rename entries the two
  pathnames are NUL-separated instead of TAB-separated. Ignored files require `--ignored` (`!!`).
  [git-status(1)](https://git-scm.com/docs/git-status)
- Cheap dirtiness for UI: `git status --porcelain=v2 --untracked-files=no` is far cheaper than the
  default in repos with large ignored trees; the `# branch.ab +N -M` header line gives ahead/behind
  in the same call.

## B5. Cost model, and making creation fast on large repos

What `git worktree add` actually creates (from the DETAILS section + layout doc):

1. A directory `$GIT_DIR/worktrees/<id>` containing small text files: `HEAD`, `gitdir`, `commondir`,
   optionally `locked`, `config.worktree`.
2. A `.git` **file** at the new worktree root (one line, `gitdir: …`).
3. A **fresh per-worktree `index`**.
4. **A full checkout of the tree at `<commit-ish>`** into the new path.

What it does **not** copy: `objects/` (shared via common dir), `config`, `hooks`, `info`, `logs`,
refs under `refs/`. So the object database cost is zero; the cost is entirely (a) writing N files,
(b) running smudge/clean filters (LFS!) on filtered paths, (c) building the index, and (d) later,
the first `git status` populating the stat cache.

Levers, all documented:

- `git worktree add --no-checkout <path>`, then set up sparse-checkout, then check out — the
  documented pattern for "customizations, such as configuring sparse-checkout".
  Combine with `extensions.worktreeConfig` so `core.sparseCheckout` stays per-worktree.
- Sparse-checkout in **cone mode** is the supported fast path; `git sparse-checkout set --cone`
  restricts patterns to directory prefixes so pattern matching is O(depth) rather than O(patterns).
  [git-sparse-checkout(1)](https://git-scm.com/docs/git-sparse-checkout)
- `--detach` avoids branch creation entirely (no ref write, no `-b` collision handling) — the right
  default for ephemeral agent scratch trees.
- `--lock --reason "<why>"` at creation time avoids the add→lock race.
- `worktree.useRelativePaths=true` makes the whole set relocatable, at the cost of
  `extensions.relativeWorktrees` (incompatible with older git).

## B6. The gitignored-files problem (node_modules, build output, `.env`)

A new worktree is a fresh checkout, so *by construction* nothing gitignored exists in it. Primary
sources for how shipping tools solve it:

- **Claude Code `.worktreeinclude`** — a file at the project root using `.gitignore` syntax. "Only
  files that match a pattern and are also gitignored are copied, so tracked files are never
  duplicated." Applies to every worktree Claude Code creates with git: `--worktree`, subagent
  worktrees (`isolation: "worktree"`), and desktop parallel sessions.
  [Run parallel sessions with worktrees](https://code.claude.com/docs/en/worktrees.md)
- Claude Code places its own worktrees under `.claude/worktrees/` and recommends adding that path to
  `.gitignore`; setup (dependency install) is explicitly the user's job: "A worktree is a fresh
  checkout, so initialize your development environment there."
- **`WorktreeCreate` / `WorktreeRemove` hooks** replace git entirely: the `WorktreeCreate` command
  hook receives `{name: "<slug>"}` on stdin and must **print the worktree path as the last non-empty
  line of stdout** (ANSI codes are stripped first; everything else must go to stderr); the HTTP form
  returns `hookSpecificOutput.worktreePath`. **Any non-zero exit aborts creation.** When a
  `WorktreeCreate` hook is configured, `.worktreeinclude` is **not** processed — copying `.env` etc.
  becomes the hook's responsibility. `WorktreeRemove` receives `worktree_path`.
  Security: since v2.1.216 Claude Code rejects a returned path whose components traverse a symlink
  inside the repository, "because a symlink committed to the repository could redirect the worktree
  outside it."
  [hooks.md § WorktreeCreate](https://code.claude.com/docs/en/hooks.md)
- Claude Code's permission approvals granted inside a worktree are (since v2.1.211) saved to the main
  checkout and survive worktree removal — worth mirroring conceptually: **session-scoped state should
  not die with the worktree.** [worktrees.md](https://code.claude.com/docs/en/worktrees.md)

No primary source found for a git-native solution; git has none. The design space is exactly:
copy (`.worktreeinclude`), symlink (fragile — Codex's symlink screening above shows why), clone-file
(APFS `clonefile(2)`, macOS-only, cheap), or re-run install.

## B7. libgit2 / SwiftGit2 vs shelling out to `/usr/bin/git`

libgit2 **does** have a worktree API — from
[`include/git2/worktree.h`](https://github.com/libgit2/libgit2/blob/main/include/git2/worktree.h):

```c
git_worktree_list(git_strarray *out, git_repository *repo);
git_worktree_lookup / _open_from_repository / _free / _validate
typedef struct git_worktree_add_options {
    unsigned int version;
    int lock;                 /* lock newly created worktree */
    int checkout_existing;    /* allow checkout of existing branch matching worktree name */
    git_reference *ref;       /* reference to use for the new worktree HEAD */
    git_checkout_options checkout_options;
} git_worktree_add_options;
git_worktree_add(out, repo, name, path, opts);
git_worktree_lock(wt, reason); git_worktree_unlock(wt); git_worktree_is_locked(&buf, wt);
git_worktree_name(wt); git_worktree_path(wt);
typedef enum { GIT_WORKTREE_PRUNE_VALID = 1<<0, GIT_WORKTREE_PRUNE_LOCKED = 1<<1,
               GIT_WORKTREE_PRUNE_WORKING_TREE = 1<<2 } git_worktree_prune_t;
git_worktree_is_prunable(wt, opts); git_worktree_prune(wt, opts);
```

What is **missing** relative to git-worktree(1), by inspection of that header:

- No `move` / `repair` equivalent.
- No `--orphan`, no `--guess-remote`/`--track` remote-guessing, no `-B` reset semantics; branch
  selection is only "supply a `git_reference *ref`".
- No relative-path linking (`worktree.useRelativePaths` / `extensions.relativeWorktrees`).
- No porcelain listing — `git_worktree_list` returns **names only**, so HEAD/branch/detached/locked/
  prunable state must be reassembled from separate calls per worktree.
- `git_worktree_add_options` has been at `VERSION 1` with these four fields; there is no
  `--no-checkout` flag, only `git_checkout_options` (you'd use `GIT_CHECKOUT_NONE`).

Beyond worktrees, libgit2 does not implement git's full filter pipeline as external processes the way
git does (git-lfs is a `filter` driver; `.gitattributes`-driven external filters, hooks, and
`core.fsmonitor` are git-CLI behaviors), so a libgit2 checkout of an LFS repo is not equivalent to a
`git worktree add`.

**Statement of position: shelling out to `/usr/bin/git` is more reliable for worktree management.**
Reasons, each grounded above: (1) `git worktree list --porcelain -z` is a documented-stable machine
format that gives locked/prunable/detached/branch/HEAD in one call, and libgit2 has no equivalent;
(2) `move`/`repair`/`--orphan`/relative paths simply do not exist in libgit2; (3) checkout fidelity
(LFS smudge, external filters, hooks, `core.fsmonitor`) matches the user's own git only when you use
the user's own git; (4) git's docs themselves tell you not to read `$GIT_DIR` directly but to use
`git rev-parse --git-path`, which is a CLI contract. Use libgit2/SwiftGit2, if at all, for read-only
hot paths that must not fork a process (fast `HEAD` resolution, ref listing, blob reads for diff
rendering) — never for mutation. Note also that SwiftGit2 is a third-party binding whose worktree
coverage is a subset of libgit2's; no first-party guarantee exists for it.

---

# Implications for Janela

**Agent hosting**

1. **Model an agent as (binary, argv template, env overlay, cwd, config-root override, session-id).**
   All three agents give you a config-root env var (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
   `OPENCODE_CONFIG_DIR`) — use it to give each Janela *profile* (not each session) an isolated
   config root, so a user can run work/personal accounts side by side without shell aliases.
2. **Own the session ID.** Launch Claude Code with an explicit `--session-id <uuid>` you generated,
   so Janela's session registry is authoritative and `--resume`/`--fork-session` are trivially
   correct after a crash. Do the same conceptually for OpenCode (`-s/--session`) and Codex
   (`codex resume`).
3. **Prefer the server/daemon transports over screen-scraping where they exist.** OpenCode:
   `opencode serve --port <fixed>` + `GET /event` SSE + `opencode attach` for the TUI, and
   `/tui/control/*` to prefill prompts (this is exactly what OpenCode's own IDE plugins do). Codex:
   its TUI already speaks to an app server over `unix://`/`ws://` and auto-probes the default daemon
   socket with a 50 ms timeout — assume that becomes the supported integration path.
4. **Install a Janela-managed `Notification` + `Stop` + `PermissionRequest` hook for Claude Code and
   a `notify` command for Codex**, both pointing at a tiny Janela helper binary that writes to a
   per-session Unix socket. This gives exact "needs input" / "finished" / "failed" state with zero
   PTY parsing. Do not depend on `idle_prompt` for turn-end: it is gated on ~60 s of user inactivity.
   Do not depend on `terminalSequence` either: Claude Code emits it only in interactive sessions
   while its UI is on screen.
5. **The PTY must be a real PTY, and must implement, at minimum:** OSC 0/1/2 titles, BEL, OSC 9,
   OSC 777 `notify`, OSC 99 (with the query-action + DA1 handshake so kitty-protocol clients can
   feature-detect), DEC 2026 synchronized output (Claude Code probes for it and there is an env var
   to force it), bracketed paste, SGR mouse reporting (OpenCode captures the mouse by default —
   `OPENCODE_DISABLE_MOUSE` exists), alt screen, and extended keys (Claude Code's Shift+Enter path
   needs them; under tmux it needs `extended-keys` + `xterm*:extkeys`). Also implement OSC 133 for
   Janela's own shell terminals — but do not use it to infer agent state.
6. **Do not run agents under tmux internally.** tmux swallows notifications and progress unless
   `allow-passthrough on`, and `CLAUDE_CODE_FORCE_SYNC_OUTPUT` explicitly has no effect under tmux.
   If Janela needs session persistence across app restarts, build it on the agents' own background
   modes (`claude --bg` + `claude agents --json` + `claude attach`, `opencode serve` + `attach`)
   rather than a multiplexer.
7. **Startup budget.** Offer a "fast start" toggle that maps to `claude --bare` (skips hooks, skills,
   plugins, MCP, auto memory, CLAUDE.md discovery) for scripted/one-shot panes, and a "safe mode"
   toggle mapping to `--safe-mode` for debugging a user's broken config. Also set
   `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `OPENCODE_DISABLE_AUTOUPDATE` and
   `OPENCODE_DISABLE_LSP_DOWNLOAD` by default: Janela, not the agent, should decide when to hit the
   network on launch.
8. **Instruction files.** Janela should show, per workspace, the resolved instruction set: the
   ancestor-walk chain of `CLAUDE.md`/`CLAUDE.local.md` with `@` imports expanded, `.claude/rules/`,
   `AGENTS.md` (nearest-wins), and `opencode.json.instructions`. Warn loudly when `AGENTS.md` exists
   but no `CLAUDE.md` imports it — that is the single most common cross-agent drift, and Anthropic's
   own docs prescribe the `@AGENTS.md` import or symlink fix.
9. **Surface the permission/sandbox axis as a first-class, per-session control**, since the three
   agents disagree about defaults: Codex defaults to Seatbelt `workspace-write` + `on-request` in a
   VCS folder and `read-only` otherwise; Claude Code has `--permission-mode
   default|acceptEdits|plan|auto|dontAsk|bypassPermissions`; OpenCode has `--auto` /
   `OPENCODE_PERMISSION`. Show the effective mode in the session chrome, always.

**Worktrees**

 1. **Worktree-aware, not worktree-centric — implement it as: workspace = repository; worktrees are a
    *view* attribute of sessions.** Enumerate with a single `git worktree list --porcelain -z` per
    repository (stable format, NUL-safe), then lazily fan out `git -C <wt> status --porcelain=v2 -z
    --untracked-files=no` only for worktrees that are visible in the UI. Never parse `git worktree
    list` without `--porcelain -z`.
 2. **Shell out to `/usr/bin/git` for all worktree mutation.** libgit2 lacks `move`, `repair`,
    `--orphan`, relative-path linking, and porcelain listing, and does not reproduce git's external
    filter pipeline (LFS). Consider libgit2/SwiftGit2 only for read-only hot paths where forking is
    measurably too slow, and treat it as an optimization with a CLI fallback.
 3. **Default new agent worktrees to `git worktree add --detach --lock --reason "janela:<session>"`.**
    Detached avoids branch-name collisions and the remote-guessing path entirely; `--lock` at add
    time is race-free and prevents `gc.worktreePruneExpire` from eating a worktree belonging to a
    long-idle session. Unlock+remove on session teardown.
 4. **For large repos, offer `--no-checkout` + cone-mode sparse-checkout as the fast path**, and only
    then check out. Enable `extensions.worktreeConfig` first (via `git config --worktree`) so
    `core.sparseCheckout` does not leak into the user's other worktrees — git's own docs call this
    out as a sharing hazard. Guard the feature behind a git-version check; `extensions.worktreeConfig`
    and `extensions.relativeWorktrees` both break older git.
 5. **Adopt `.worktreeinclude` semantics verbatim** (gitignore syntax; copy only files that both match
    a pattern *and* are gitignored) so Janela is compatible with what Claude Code users already have
    committed. On APFS, use `clonefile(2)` for the copy so `node_modules` materialization is O(1) in
    bytes; fall back to copy on other filesystems. Reject any include path that traverses a symlink
    inside the repository — Claude Code added exactly that screening for a reason.
 6. **Never assume `.git` is a directory.** In a linked worktree it is a one-line gitfile; resolve
    every git path with `git rev-parse --git-path <name>` / `--git-common-dir`, as git's docs
    explicitly instruct. Codex's Seatbelt policy already resolves this indirection and marks the real
    `$GIT_DIR` read-only — Janela's own file watcher and indexer should do the same, i.e. watch
    `$GIT_COMMON_DIR` once per repository, not once per worktree.
 7. **Expect shared hooks.** Every worktree runs the *main* repo's `hooks/` from the common dir. If
    Janela ever installs a hook, it is repo-global and visible in every worktree and to every agent —
    treat hook installation as a repository-level, explicitly-consented action.
 8. **Refuse worktree operations on superprojects with submodules by default**, surfacing git's own
    BUGS text. `move` is impossible, `remove` needs `--force`, and silent breakage here is worse than
    a clear refusal.
 9. **Prune UI, not prune automation.** Show `locked`/`prunable` from the porcelain output with the
    reason string, and require an explicit user action to prune. Remember that a worktree's liveness
    signal is the mtime of `.git/worktrees/<id>/gitdir`, so a Janela session that merely *displays* a
    worktree without running git in it does not keep it alive.

---

## Sources

Kept:

- <https://git-scm.com/docs/git-worktree> — normative worktree semantics, porcelain format, DETAILS layout, BUGS.
- <https://git-scm.com/docs/gitrepository-layout> — which files are per-worktree vs `$GIT_COMMON_DIR`; `worktrees/<id>/{gitdir,locked,config.worktree}`.
- <https://git-scm.com/docs/git-status> — `-z` and porcelain v2 parsing rules for dirtiness.
- <https://git-scm.com/docs/git-sparse-checkout> — cone mode.
- <https://github.com/libgit2/libgit2/blob/main/include/git2/worktree.h> — exact libgit2 worktree API surface and its gaps.
- <https://code.claude.com/docs/en/cli-reference.md>, `/settings.md`, `/env-vars.md`, `/memory.md`, `/hooks.md`, `/headless.md`, `/terminal-config.md`, `/worktrees.md` — Claude Code invocation, config, CLAUDE.md discovery, hook/notification state model, `terminalSequence` OSC allowlist, `.worktreeinclude`, `WorktreeCreate`/`WorktreeRemove`.
- <https://developers.openai.com/codex/config-reference>, `/local-config`, `/agent-approvals-security`, `/cli` — Codex config layering, `notify`, hooks events, Seatbelt sandbox, `.git`-pointer protection.
- <https://github.com/openai/codex> (`README.md`, `codex-rs/tui/src/lib.rs`, `codex-rs/core/src/agents_md*.rs`) — install artifacts, app-server/daemon architecture, AGENTS.md implementation location.
- <https://opencode.ai/docs/{cli,server,config,tui,rules}/> — TUI/server split, `/event` SSE, `tui.json` `attention`/`mouse`, AGENTS.md precedence, env vars.
- <https://agents.md/> — AGENTS.md convention and nearest-file precedence.
- <https://sw.kovidgoyal.net/kitty/desktop-notifications/> — OSC 99 protocol and capability query.
- <https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/semantic-prompts.md> (via Ghostty's parser) — OSC 133 A/B/C/D.
- <https://github.com/ghostty-org/ghostty/blob/d31ac2be/src/terminal/osc/parsers/semantic_prompt.zig>, <https://ghostty.org/docs/features/shell-integration>, <https://ghostty.org/docs/install/release-notes/1-3-0> — real-world OSC 133 option set and shell-integration injection limits.

Dropped:

- <https://terminfo.dev/extensions/osc-133-semantic-prompts> and <https://ansicode.eversources.app/...> — accurate but secondary; the freedesktop proposal and Ghostty's parser own the facts.
- `https://github.com/anomalyco/opencode/...` PR — a fork; used only to confirm `tui.json` exists, which the official docs already state.
- `raw.githubusercontent.com/openai/codex/main/docs/{config,sandbox}.md` — now redirect stubs; superseded by developers.openai.com.

## Gaps

- The freedesktop semantic-prompts spec page is behind a bot check; OSC 133 A/B/C/D semantics here are
  quoted through Ghostty's parser source and release notes rather than the spec text itself. Fetch it
  from a git checkout of `Per_Bothner/specifications` if exact spec wording matters.
- Codex's `notify` JSON payload schema is documented only as "receives a JSON payload from Codex". The
  concrete shape (event names, fields) must be read from `codex-rs` source before Janela depends on it.
- No primary source located for git-lfs behavior specifically inside a linked worktree; the claim here
  is derived from "worktree add performs a checkout" + LFS being a gitattributes filter driver. Verify
  empirically on a real LFS repo before quoting numbers.
- Whether Codex's TUI enters the alternate screen unconditionally is inferred from
  `AltScreenMode` in `codex_protocol::config_types` and the `#![deny(clippy::print_stdout)]` comment;
  the exact terminal-setup call site (`codex-rs/tui/src/tui.rs`) was not read.
- OpenCode's `/event` event-name vocabulary (the analogue of Claude's `Notification` matchers) is not
  enumerated in the docs; it must be read from `GET /doc` on a running server.
