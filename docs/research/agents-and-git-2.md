# Research: Hosting CLI coding agents + git worktree mechanics (Janela)

Primary sources only. Every non-obvious claim below cites the doc/spec/source that owns it.
Fetched 2026-xx (docs are living; version-gated claims quote the version the doc names).

---

## TOPIC A — CLI coding agents to host

### A1. Claude Code — invocation surface

Primary: <https://code.claude.com/docs/en/cli-reference>, <https://code.claude.com/docs/en/headless>,
<https://code.claude.com/docs/en/sessions>, <https://code.claude.com/docs/en/hooks>,
<https://code.claude.com/docs/en/env-vars>, <https://code.claude.com/docs/en/worktrees>,
<https://code.claude.com/docs/en/terminal-config>.

1. **Two distinct run modes, and Janela must model both.**
   Interactive TUI (`claude`) vs non-interactive `-p`/`--print`. `--output-format` accepts
   `text`, `json`, `stream-json`; `--input-format` accepts `text`, `stream-json`.
   ([cli-reference](https://code.claude.com/docs/en/cli-reference))
   `-p` rejects `--bg`; `--bg` + `--exec` runs a *PTY-backed background job* instead of a Claude
   session. ([cli-reference](https://code.claude.com/docs/en/cli-reference))

2. **Session resume is a first-class, ID/name-addressable surface.**
   `--continue`/`-c` (most recent in cwd), `--resume`/`-r <id|name>` (or picker), `--fork-session`
   (new session ID on resume), `--session-id <uuid>` (caller-chosen UUID), `--name`/`-n`.
   ([cli-reference](https://code.claude.com/docs/en/cli-reference), [sessions](https://code.claude.com/docs/en/sessions))
   *Worktree-relevant*: "When you pass a session ID, Claude Code searches the current project
   directory **and its git worktrees**, then every other project on this machine."
   ([sessions](https://code.claude.com/docs/en/sessions))
   The session picker is worktree-scoped by default; `Ctrl+W` widens to all worktrees of the repo,
   `Ctrl+A` to all projects, `Ctrl+B` filters by git branch. ([sessions](https://code.claude.com/docs/en/sessions))

3. **Transcript storage is a stable *location*, not a stable *format*.**
   "Claude Code stores transcripts as JSONL at `~/.claude/projects/<project>/<session-id>.jsonl`,
   where `<project>` is your working directory path with non-alphanumeric characters replaced by
   `-`" (truncated to 200 chars + hash of the full path when longer). The docs explicitly warn:
   "The entry format is internal to Claude Code and changes between versions, so scripts that parse
   these files directly can break on any release." ([sessions](https://code.claude.com/docs/en/sessions))
   → **Janela must not parse `~/.claude/projects/**.jsonl` as a product feature.** Use hooks,
   `--output-format stream-json`, or `-p --resume` instead (the docs enumerate exactly these four
   "script interfaces"). ([sessions](https://code.claude.com/docs/en/sessions))

4. **Config directory is relocatable — key for multi-account / per-workspace isolation.**
   `CLAUDE_CONFIG_DIR` "Override the configuration directory (default: `~/.claude`). All settings,
   session history, and plugins are stored under this path, as are credentials on Linux and
   Windows; on macOS, credentials are in the system Keychain."
   ([env-vars](https://code.claude.com/docs/en/env-vars))
   Settings sources are selectable per-invocation: `--setting-sources user,project,local`,
   `--settings <path|inline-json>` (file must be ≤2 MiB). ([cli-reference](https://code.claude.com/docs/en/cli-reference))

5. **Env vars Claude Code sets in children — use these to detect nesting, not heuristics.**
   `CLAUDECODE=1` is set in every subprocess Claude Code spawns (Bash/PowerShell tools, tmux
   sessions, hook commands, status line commands, stdio MCP servers); IDE extensions also set it.
   `CLAUDE_CODE_CHILD_SESSION` is set *only by Claude Code itself*, so it "reliably distinguishes a
   nested session from a top-level `claude` launched in an IDE-integrated terminal."
   ([env-vars](https://code.claude.com/docs/en/env-vars))
   → Janela should **not** set `CLAUDECODE` in its own terminals; doing so would make nested agents
   misclassify themselves.

6. **Startup cost has an official escape hatch.**
   `--bare`: "Minimal mode: skip auto-discovery of hooks, skills, plugins, MCP servers, auto memory,
   and CLAUDE.md so scripted calls start faster… Sets `CLAUDE_CODE_SIMPLE`."
   `--safe-mode` disables customizations for troubleshooting (sets `CLAUDE_CODE_SAFE_MODE`).
   ([cli-reference](https://code.claude.com/docs/en/cli-reference))
   With `--mcp-config` + `-p`, Claude Code *blocks the first turn* waiting for MCP servers, up to
   `MCP_TIMEOUT` (default 30 s). ([cli-reference](https://code.claude.com/docs/en/cli-reference))
   → Janela's "quick agent" affordance should default to `--bare` for scripted/one-shot calls.

### A2. What Claude Code needs from a terminal (hard requirements)

1. **It uses the alternate screen and can be forced off it.**
   `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` "disable[s] fullscreen rendering and use[s] the classic
   main-screen renderer. The conversation stays in your terminal's native scrollback… Takes
   precedence over `CLAUDE_CODE_NO_FLICKER` and the `tui` setting."
   ([env-vars](https://code.claude.com/docs/en/env-vars))
   → Janela must implement alt-screen (DECSET 1049) *and* should expose a per-session toggle that
   sets this variable so scrollback/search stay native when the user prefers it.

2. **It uses mouse tracking, including motion/hover and click-to-position.**
   `CLAUDE_CODE_DISABLE_MOUSE=1` "disable[s] mouse tracking in fullscreen rendering. Keyboard
   scrolling with PgUp and PgDn still works." `CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1` disables
   "click, drag, and hover handling… while keeping mouse-wheel scrolling."
   `CLAUDE_CODE_SCROLL_SPEED` sets a wheel multiplier (≤20, fractional allowed).
   ([env-vars](https://code.claude.com/docs/en/env-vars))
   → Requires at minimum SGR mouse (1006) + button-event tracking (1002) and any-event (1003).

3. **It probes for and uses DEC private mode 2026 (synchronized output).**
   `CLAUDE_CODE_FORCE_SYNC_OUTPUT=1` "force-enable DEC private mode 2026 synchronized output when
   your terminal supports it but is not auto-detected… for emulators such as Emacs `eat` that
   implement BSU/ESU but do not reply to the capability probe."
   ([env-vars](https://code.claude.com/docs/en/env-vars))
   → Janela **must answer the DECRQM probe for 2026**, not merely implement BSU/ESU, or Claude Code
   will fall back to unsynchronized painting and flicker.

4. **OSC 8 hyperlinks, terminal title, truecolor, strikethrough are all detected via `TERM_PROGRAM`.**
    `FORCE_HYPERLINK=1` enables OSC 8 "when your terminal supports them but isn't auto-detected";
    `CLAUDE_CODE_FORCE_STRIKETHROUGH=1` covers `~~text~~` "over SSH without `TERM_PROGRAM`
    forwarded"; `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` stops automatic title updates;
    truecolor is clamped to 256 colors when `$TMUX` is set unless `CLAUDE_CODE_ENABLE_TRUECOLOR`-style
    opt-in. ([env-vars](https://code.claude.com/docs/en/env-vars))
    → Janela should set a recognizable `TERM_PROGRAM` (+ `TERM_PROGRAM_VERSION`) and `TERM=xterm-256color`
    (or a Janela terminfo), and support OSC 0/1/2 + OSC 8.

5. **Shift+Enter requires terminal-side modifier encoding.**
    Docs list Ghostty, Kitty, iTerm2, WezTerm, Warp, Apple Terminal, Windows Terminal as
    "Works without setup"; VS Code, Cursor, Alacritty, Zed require `/terminal-setup`; gnome-terminal
    and JetBrains: "Not available". Under tmux it additionally needs `extended-keys`.
    ([terminal-config](https://code.claude.com/docs/en/terminal-config))
    → Janela should implement **kitty keyboard protocol** (CSI > flags u) or at minimum
    xterm `modifyOtherKeys`, so Shift+Enter, Option/Alt-as-Meta, and Ctrl+J work without the user
    running `/terminal-setup`. Option-as-Meta is a per-terminal setting Claude Code documents as
    off-by-default on macOS. ([terminal-config](https://code.claude.com/docs/en/terminal-config))

6. **Notifications: Claude Code natively emits desktop notifications only for three terminals.**
    "By default Claude Code sends a desktop notification only in **Ghostty, Kitty, and iTerm2**. In
    other terminals, set `preferredNotifChannel` to `"terminal_bell"`…"
    ([terminal-config](https://code.claude.com/docs/en/terminal-config))
    → **If Janela advertises itself as an unknown terminal it gets no notifications at all.**
    This is a concrete, testable integration requirement (see A4).

7. **Real TTY / bracketed paste.** Paste handling is explicit: pastes >800 chars or >2 lines are
    collapsed to `[Pasted text #1 +120 lines]` and cached under `~/.claude/paste-cache/`
    ([terminal-config](https://code.claude.com/docs/en/terminal-config)) — this only works with
    bracketed paste (DECSET 2004) so the app can distinguish paste from typing. Hooks run
    **without a controlling terminal**: "The hook process and any child processes can't open
    `/dev/tty` or send escape sequences directly to the Claude Code interface."
    ([hooks](https://code.claude.com/docs/en/hooks)) → the agent itself owns the TTY; Janela must
    allocate a real PTY (openpty/forkpty), not pipes, for interactive mode.

### A3. Claude Code hooks — the highest-value integration point for an IDE

 1. **Event set and cadence.** Once per session: `SessionStart`, `SessionEnd`. Once per turn:
    `UserPromptSubmit`, `Stop`, `StopFailure`. Per tool call: `PreToolUse`, `PostToolUse`.
    Plus `Notification`, `PermissionRequest`, `PermissionDenied`, `SubagentStart/Stop`,
    `PostToolBatch`, `PreCompact/PostCompact`, `CwdChanged`, `DirectoryAdded`, `FileChanged`,
    `ConfigChange`, `TeammateIdle`, `WorktreeCreate`, `WorktreeRemove`, `Elicitation`.
    ([hooks](https://code.claude.com/docs/en/hooks))

 2. **`Notification` matchers give you the exact state machine Janela needs.**
    Matcher values for `Notification` are:
    `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`, `elicitation_url_dialog`,
    `elicitation_complete`, `elicitation_response`, **`agent_needs_input`**, **`agent_completed`**.
    ([hooks](https://code.claude.com/docs/en/hooks))
    → "waiting for input" = `permission_prompt` | `idle_prompt` | `agent_needs_input` | `elicitation_*`.
    → "finished" = `agent_completed` (or the `Stop` event). This is *first-party* and far more
    reliable than PTY heuristics.

 3. **Common hook input fields**: `session_id`, `prompt_id`, `transcript_path`, `cwd`,
    `permission_mode`, `hook_event_name`, plus `agent_id` under `--agent`/subagents.
    ([hooks](https://code.claude.com/docs/en/hooks)) `Stop`/`SubagentStop` carry
    `last_assistant_message` and the docs say to prefer it over reading the transcript, which "is
    written asynchronously and may lag the in-memory conversation."
    ([hooks](https://code.claude.com/docs/en/hooks))

 4. **`terminalSequence` — Claude Code will emit escape sequences on a hook's behalf, restricted to
    a fixed allowlist.**
    "A terminal escape sequence for Claude Code to emit on your behalf, such as a desktop
    notification, window title, or bell. **Restricted to OSC `0`/`1`/`2`/`9`/`99`/`777` and BEL.**
    If the value contains anything outside the allowlist, the field is ignored."
    ([hooks](https://code.claude.com/docs/en/hooks))
    Rationale given: "Hooks run without a controlling terminal, so writing escape sequences directly
    to `/dev/tty` fails… This is race-free, works inside tmux and GNU screen."
    ([hooks](https://code.claude.com/docs/en/hooks))
    → **This is the contract Janela should build against**: parse OSC 0/1/2 (titles), OSC 9
    (iTerm2/ConEmu notification + `9;4` progress), OSC 99 (kitty), OSC 777 (urxvt/VTE), and BEL.
    A Janela-shipped `Notification`/`Stop` hook that returns `terminalSequence` gives exact,
    structured agent state through the PTY with zero screen-scraping.

 5. **Hook exit-code semantics matter for an IDE that installs hooks.** Exit 2 blocks for
    `PreToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `PostToolBatch`, `PreCompact`,
    `TaskCreated/Completed`, `ConfigChange`; it is *ignored* for `Notification`, `PostToolUse`,
    `SessionStart/End`, `StopFailure`. `SessionEnd` hooks share a **1.5-second budget**
    (overridable via `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`).
    ([hooks](https://code.claude.com/docs/en/hooks), [env-vars](https://code.claude.com/docs/en/env-vars))
    → Janela's SessionEnd hook must be a fire-and-forget local IPC write (<1.5 s), e.g. a datagram
    to a per-workspace Unix socket, never a synchronous DB write with contention.

### A4. Claude Code's own worktree model (directly relevant to Janela's "worktree-aware not -centric" stance)

 1. `--worktree`/`-w <name>` "create[s] an isolated worktree and start[s] Claude in it. By default,
    the worktree is created under **`.claude/worktrees/<name>/`** at your repository root, on a new
    branch named **`worktree-<name>`**." ([worktrees](https://code.claude.com/docs/en/worktrees))
 2. Base ref is configurable: `worktree.baseRef` = `"fresh"` (default; branch from remote default
    branch, fetching `origin/HEAD` if stale >24 h, capped at 5 s) or `"head"`.
    ([worktrees](https://code.claude.com/docs/en/worktrees))
 3. **`.worktreeinclude` solves the gitignored-artifacts problem, first-party.** "add a
    `.worktreeinclude` file to your project root. The file uses `.gitignore` syntax. **Only files
    that match a pattern and are also gitignored are copied**, so tracked files are never
    duplicated." ([worktrees](https://code.claude.com/docs/en/worktrees))
 4. **Claude Code takes `git worktree lock` on agent worktrees while an agent runs**: "While an
    agent is running, Claude runs `git worktree lock` on its worktree so that concurrent cleanup
    cannot remove it… The sweep never releases a lock you set yourself with `git worktree lock`."
    ([worktrees](https://code.claude.com/docs/en/worktrees))
    → Janela's own worktree GC **must** respect `locked` and must not release locks it did not set.
 5. Claude Code refuses a worktree whose "`.git` file points at the main repository's own `.git`
    directory, or git resolves its working tree to the main checkout through a `core.worktree`
    redirect", and refuses symlinked `.claude`/`.claude/worktrees`/worktree paths, and refuses
    network paths. ([worktrees](https://code.claude.com/docs/en/worktrees))
    → If Janela creates worktrees itself, it must produce layouts that pass these checks: real
    `git worktree add` output, no symlinked parents, local paths only.
 6. `WorktreeCreate`/`WorktreeRemove` hooks can *replace* git worktree creation entirely (for SVN/
    Perforce/hg) — the hook prints the directory path on stdout; nonzero exit fails creation
    regardless of JSON. ([worktrees](https://code.claude.com/docs/en/worktrees), [hooks](https://code.claude.com/docs/en/hooks))
    → Janela can own worktree placement (e.g. `~/Library/Application Support/Janela/worktrees/...`)
    by shipping a `WorktreeCreate` hook, instead of fighting `.claude/worktrees/`.
    Caveat from docs: with a `WorktreeCreate` hook, `.worktreeinclude` is **not** processed.

### A5. OpenAI Codex CLI

Primary: <https://developers.openai.com/codex/cli/reference>, <https://developers.openai.com/codex/config-reference>,
<https://developers.openai.com/codex/config-basic>, <https://developers.openai.com/codex/concepts/sandboxing>,
<https://developers.openai.com/codex/hooks>, <https://github.com/openai/codex>.

 1. **Config layering.** "Codex stores user-level configuration at `~/.codex/config.toml`. To scope
    settings to a specific project or subfolder, add a `.codex/config.toml` file in your repo…
    Codex loads project `.codex/` layers **only when you trust the project**."
    ([config-basic](https://developers.openai.com/codex/config-basic))
    Trust is itself config: `projects.<path>.trust_level` = `"trusted" | "untrusted"`, and
    "Untrusted projects skip project-scoped `.codex/` layers, including project-local config, hooks,
    and rules." ([config-reference](https://developers.openai.com/codex/config-reference))
    → Janela creating a *new worktree path* means a **new, untrusted project path**. Janela must
    surface trust as an explicit workspace action (or pre-seed `projects.<path>.trust_level`).
 2. **Per-invocation override without touching files**: `-c key=value` where the value is TOML, e.g.
    `codex --config sandbox_workspace_write.network_access=true`, and
    `--profile/-p` layers `$CODEX_HOME/profile-name.config.toml`.
    ([config-advanced](https://developers.openai.com/codex/config-advanced), [cli/reference](https://developers.openai.com/codex/cli/reference))
    → Janela should drive Codex with `-c` flags rather than rewriting the user's `config.toml`.
 3. **Sandbox + approvals are orthogonal axes.**
    `sandbox_mode` ∈ `read-only | workspace-write | danger-full-access`;
    `approval_policy` ∈ `untrusted | on-request | never | { granular = {...} }`;
    `sandbox_workspace_write.{writable_roots, network_access, exclude_slash_tmp, exclude_tmpdir_env_var}`.
    ([config-reference](https://developers.openai.com/codex/config-reference))
    CLI equivalents: `--sandbox/-s`, `--ask-for-approval/-a`.
    ([cli/reference](https://developers.openai.com/codex/cli/reference))
    "By default, the agent runs with network access turned off. Locally, Codex uses an OS-enforced
    sandbox that limits what it can touch (typically to the current workspace)."
    ([agent-approvals-security](https://developers.openai.com/codex/agent-approvals-security))
    → **Worktree consequence**: in `workspace-write`, a worktree outside the workspace root is not
    writable. Janela must add the worktree path (and, if the agent runs `git`, the *main* `.git`)
    to `sandbox_workspace_write.writable_roots`.
 4. **Subcommands Janela should expose.** `codex` (TUI), `codex exec` (alias `codex e`) — "Run Codex
    non-interactively… Stream results to stdout or JSONL and optionally resume previous sessions";
    `codex resume` — "Continue a previous interactive session by ID or resume the most recent chat";
    `codex fork`, `codex archive/unarchive/delete`, `codex app-server`, `codex mcp-server`
    ("Run Codex itself as an MCP server over stdio"), `codex exec-server`, `codex doctor`.
    ([cli/reference](https://developers.openai.com/codex/cli/reference))
 5. **Codex has a remote/app-server transport** — `--remote ws://… | wss://… | unix://PATH`,
    supported for `codex`, `codex resume`, `codex fork`, `codex archive`, `codex delete`,
    `codex unarchive`; other subcommands reject it. `--remote-auth-token-env ENV_VAR` supplies a
    bearer token. ([cli/reference](https://developers.openai.com/codex/cli/reference))
    → A future Janela can talk to Codex over a Unix socket app-server instead of a PTY. That is the
    single strongest argument for keeping the terminal *swappable* and the agent transport abstract.
 6. **Alt screen is controllable**: `--no-alternate-screen` "Disable alternate screen mode for the
    TUI (overrides `tui.alternate_screen` for this run)."
    ([cli/reference](https://developers.openai.com/codex/cli/reference))
 7. **`notify` — Codex's agent-specific notification hook.**
    `notify` : `array<string>` — "Command invoked for notifications; receives a JSON payload from
    Codex." ([config-reference](https://developers.openai.com/codex/config-reference))
    → Janela can set `-c notify='["/Applications/Janela.app/Contents/MacOS/janela-notify"]'` per
    session and get structured "turn complete / needs approval" events out-of-band.
 8. **Codex hooks (2nd, richer channel).** Events: during a turn — `PreToolUse`, `PermissionRequest`,
    `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStop`, `Stop`;
    at start — `SessionStart`, `SubagentStart`; at end — `SessionEnd` (main thread only).
    Discovered at `~/.codex/hooks.json`, `~/.codex/config.toml`, `<repo>/.codex/hooks.json`,
    `<repo>/.codex/config.toml`. ([hooks](https://developers.openai.com/codex/hooks))
    Critical operational details:
    - "Before a non-managed command hook can run, Codex requires you to **review and trust** the
      exact hook definition. Codex records trust against the hook's **current hash**, so new or
      changed hooks are marked for review and skipped until trusted." (`/hooks` to review;
      `--dangerously-bypass-hook-trust` for one-off automation.)
    - `SessionEnd` default timeout is **1 second, max 3**.
    - "Only `type: "command"` handlers run today. `prompt` and `agent` handlers are parsed but skipped."
    - Plugin hooks get `PLUGIN_ROOT`/`PLUGIN_DATA` and, for compatibility,
      `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA`.
    ([hooks](https://developers.openai.com/codex/hooks))
    → **Janela cannot silently install Codex hooks.** Any hook-based integration needs a guided
    "run `/hooks` and trust Janela's hook" onboarding step, and it re-triggers on every Janela
    update that changes the hook command string.
 9. **AGENTS.md knobs are config**: `project_doc_fallback_filenames` ("Additional filenames to try
    when `AGENTS.md` is missing"), `project_doc_max_bytes` ("Maximum bytes read from `AGENTS.md`"),
    `project_root_markers`, `model_instructions_file` ("Replacement for built-in instructions
    instead of `AGENTS.md`"). ([config-reference](https://developers.openai.com/codex/config-reference))
10. `log_dir` "defaults to `$CODEX_HOME/log`. Setting this explicitly also enables the opt-in
    plaintext TUI log, `codex-tui.log`." ([config-reference](https://developers.openai.com/codex/config-reference))
    → Cheap, first-party diagnostics surface for Janela's "agent troubleshooting" panel.

### A6. OpenCode

Primary: <https://opencode.ai/docs/cli/>, <https://opencode.ai/docs/server/>, <https://opencode.ai/docs/config/>,
<https://opencode.ai/docs/tui/>.

 1. **Server/TUI split is explicit and stable.** "When you run `opencode` it starts a TUI **and** a
    server. Where the TUI is the client that talks to the server. The server exposes an OpenAPI 3.1
    spec endpoint" at `http://<host>:<port>/doc`. "When you start the TUI it randomly assigns a port
    and hostname. You can instead pass in the `--hostname` and `--port` flags."
    ([server](https://opencode.ai/docs/server/))
    → **Janela should launch OpenCode with fixed `--hostname 127.0.0.1 --port <allocated>` and treat
    the HTTP API as the source of truth**, using the PTY purely as a renderer.
 2. **Event stream**: `GET /event` — "Server-sent events stream. First event is `server.connected`,
    then bus events." Also `GET /session/status` → `{ [sessionID]: SessionStatus }`.
    ([server](https://opencode.ai/docs/server/))
    → This is the cleanest "agent busy / waiting / done" signal of the three agents. No PTY parsing.
 3. **Drive the TUI from outside**: `POST /tui/append-prompt`, `/tui/submit-prompt`,
    `/tui/clear-prompt`, `/tui/execute-command`, `/tui/show-toast`, `/tui/open-sessions`,
    `GET /tui/control/next` + `POST /tui/control/response`. "This setup is used by the OpenCode IDE
    plugins." ([server](https://opencode.ai/docs/server/))
    → Janela gets "insert this file path into the agent prompt" for free.
 4. **Headless / attach modes**: `opencode serve` (default port 4096, hostname 127.0.0.1),
    `opencode attach <url>` ("Attach a terminal to an already running OpenCode backend server"),
    `opencode run --attach http://localhost:4096 "…"` ("to avoid MCP server cold boot times on every
    run"). Auth via `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME` HTTP basic.
    ([cli](https://opencode.ai/docs/cli/), [server](https://opencode.ai/docs/server/))
    → **Directly relevant to Janela's "many concurrent sessions" goal**: one shared `opencode serve`
    per workspace + N attached TUIs amortizes MCP cold start.
 5. **Session commands**: `--continue/-c`, `--session/-s <id>`, `--fork`, `opencode session list
    [--format json]`, `opencode session delete <id>`, `opencode export [sessionID]`.
    ([cli](https://opencode.ai/docs/cli/))
 6. **Config split (recent, breaking-ish)**: server/runtime config in `opencode.json` (global
    `~/.config/opencode/opencode.json`, project `opencode.json`), TUI config in **`tui.json`/`tui.jsonc`**;
    "legacy `theme`/`keybinds`/`tui` keys in `opencode.json{,c}` are deprecated and moved."
    ([config](https://opencode.ai/docs/config/), [tui](https://opencode.ai/docs/tui/),
    [PR: split tui/server config](https://github.com/anomalyco/opencode/pull/13968),
    [source](https://github.com/sst/opencode/blob/69a80663/packages/opencode/src/config/tui.ts))
 7. **`tui.json` has a built-in attention/notification block** — `attention: { enabled, notifications,
    sound, volume, sound_pack }`, plus `mouse: true`, `cursor`, `scroll_speed`, `diff_style`.
    ([tui](https://opencode.ai/docs/tui/))
    → OpenCode expects mouse reporting on by default; Janela must support it.
 8. `POST /session/:id/init` — "Analyze app and create `AGENTS.md`". ([server](https://opencode.ai/docs/server/))

### A7. AGENTS.md convention

 1. **Format + precedence**: plain Markdown, no required fields. "Agents automatically read the
    nearest file in the directory tree, so the closest one takes precedence"; "The closest AGENTS.md
    to the edited file wins; explicit user chat prompts override everything."
    ([agents.md](https://agents.md/))
 2. **Who reads it (per agents.md itself)**: "AGENTS.md emerged from collaborative efforts across the
    AI software development ecosystem, including OpenAI Codex, Amp, Jules from Google, Cursor, and
    Factory," and is "now stewarded by the Agentic AI Foundation under the Linux Foundation."
    Aider needs `read: AGENTS.md` in `.aider.conf.yml`; Gemini CLI needs
    `{"context": {"fileName": "AGENTS.md"}}` in `.gemini/settings.json`. ([agents.md](https://agents.md/))
 3. Codex confirms it first-party via `project_doc_fallback_filenames` / `project_doc_max_bytes`
    (finding 33). OpenCode creates one via `POST /session/:id/init`
    ([server](https://opencode.ai/docs/server/)). Claude Code's first-party memory file is
    `CLAUDE.md` (+ `.claude/rules/*.md`), surfaced via the `InstructionsLoaded` hook event —
    "When a CLAUDE.md or `.claude/rules/*.md` file is loaded into context"
    ([hooks](https://code.claude.com/docs/en/hooks)). **No primary Anthropic doc found stating
    Claude Code reads `AGENTS.md`** — do not assume it.

### A8. Detecting "waiting for input" vs "finished" from a PTY stream

Ranked by reliability, all primary-sourced:

 1. **Tier 0 — out-of-band, structured (preferred).**
    - Claude Code: `Notification` hook matchers `agent_needs_input` / `agent_completed` /
      `permission_prompt` / `idle_prompt`, plus `Stop`/`StopFailure`
      ([hooks](https://code.claude.com/docs/en/hooks)).
    - Codex: `notify` command receiving a JSON payload
      ([config-reference](https://developers.openai.com/codex/config-reference)); or `Stop` /
      `PermissionRequest` / `SessionEnd` hooks ([hooks](https://developers.openai.com/codex/hooks)).
    - OpenCode: `GET /event` SSE + `GET /session/status` ([server](https://opencode.ai/docs/server/)).
    - Also for Claude Code: `-p --output-format stream-json` with `--include-hook-events`,
      `--include-partial-messages`, `--forward-subagent-text`
      ([cli-reference](https://code.claude.com/docs/en/cli-reference)).

 2. **Tier 1 — in-band escape sequences the agents are already allowed to emit.**
    Claude Code's `terminalSequence` allowlist is exactly **OSC 0/1/2/9/99/777 + BEL**
    ([hooks](https://code.claude.com/docs/en/hooks)). Specs Janela must parse:
    - **OSC 9 (iTerm2)** — "To post a notification: `OSC 9 ; [Message content goes here] ST`".
      Progress bar extension: `OSC 9 ; 4 ; [st] ; [pr] ST`, st ∈ {0 clear, 1 set %, 2 error,
      3 indeterminate, 4 warning}. ([iTerm2 escape codes](https://iterm2.com/documentation-escape-codes.html))
      Ghostty documents the same sequence and the ConEmu `OSC 9;n` disambiguation problem
      ([ghostty OSC 9](https://ghostty.org/docs/vt/osc/9),
      [ghostty ConEmu OSC 9;n](https://ghostty.org/docs/vt/osc/conemu)).
    - **OSC 99 (kitty)** — `<OSC> 99 ; metadata ; payload <ST>`; metadata is colon-separated
      `key=value`; `p=title|body`, `i=<id>`, `d=0|1` for chunking, `e=1` for base64 payloads,
      `f=`app-name and `t=`type (base64) for filtering, `a=report,focus` for activation callbacks
      (reply is `OSC 99 ; i=<id> ; ST`). Payload limit "no longer than 2048 bytes, *before being
      encoded* or 4096 encoded bytes." ([kitty desktop notifications](https://sw.kovidgoyal.net/kitty/desktop-notifications/))
    - **OSC 777 (urxvt/VTE)** — VTE commit "Add sequences and signals for desktop notification":
      `OSC 777 ; notify ; SUMMARY ; BODY BEL`, `OSC 777 ; notify ; SUMMARY BEL`, and the `ST`
      variants. ([GNOME/vte commit](https://lists.gnome.org/archives/commits-list/2021-March/msg10780.html),
      [vteseq.cc](https://github.com/GNOME/vte/blob/master/src/vteseq.cc))
      Note **both the 3-field and 2-field (summary-only) forms are valid.**
    - **BEL** — Claude Code's `preferredNotifChannel: "terminal_bell"`
      ([terminal-config](https://code.claude.com/docs/en/terminal-config)).

 3. **Tier 2 — OSC 133 semantic prompts (FinalTerm).** Canonical spec:
    <https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/semantic-prompts.md>
    (referenced as the spec by Ghostty:
    [ghostty semantic_prompt.zig](https://github.com/ghostty-org/ghostty/blob/d31ac2be/src/terminal/osc/parsers/semantic_prompt.zig)).
    iTerm2's normative description: `OSC 133;A ST` = FTCS_PROMPT ("Sent just before start of shell
    prompt"), `133;B` = FTCS_COMMAND_START, `133;C` = FTCS_COMMAND_EXECUTED ("just before start of
    command output"), `133;D ; [Ps] ST` = FTCS_COMMAND_FINISHED where "A status of 0 is considered
    'success' and nonzero indicates 'failure'"; `D` may also signal an aborted command; "If neither
    FTCS_COMMAND_START nor FTCS_COMMAND_EXECUTED was sent prior to FTCS_COMMAND_FINISHED it should
    be ignored." ([iTerm2 shell integration](https://iterm2.com/documentation-escape-codes.html))
    Ghostty's shell integration doc restates A/B/C/D and adds the kitty `redraw`/`click_events`
    options ([Ghostty shell integration](https://ghostty-org-ghostty.mintlify.app/features/shell-integration),
    [kitty shell integration](https://sw.kovidgoyal.net/kitty/shell-integration/)).
    **Limitation to be blunt about: OSC 133 is emitted by the *shell*, not by the agent TUI.**
    It tells Janela "the `claude` process exited with status N", i.e. *session* boundaries, not
    *turn* boundaries. Useful for "agent process finished/crashed"; useless for "agent is waiting
    for approval".

 4. **Tier 3 — heuristics (last resort, must be behind a feature flag).** Available weak signals:
    alternate-screen enter/exit (DECSET/DECRST 1049), mouse-mode changes, DEC 2026 sync-output
    windows, cursor-visibility, and PTY idleness. None are specified as agent state. Do not ship
    prompt-regex scraping of the agent TUI: Claude Code's renderer is theme-configurable
    (`~/.claude/themes/*.json` with `base` + `overrides`
    ([terminal-config](https://code.claude.com/docs/en/terminal-config))) and has at least two
    renderers (fullscreen vs classic), so any pixel/text pattern is version- and config-fragile.

 5. **What an IDE should expose for all three agents (derived from the above, not opinion-free):**
    a launch spec `{argv, cwd, env, ptySize}`; a per-agent capability record
    `{supportsResume, resumeArgv(id), supportsHeadlessJSON, hasStructuredEventChannel, notificationMechanism}`;
    a session identity that survives restart (`--session-id` UUID for Claude Code
    ([cli-reference](https://code.claude.com/docs/en/cli-reference)); `codex resume <id>`
    ([cli/reference](https://developers.openai.com/codex/cli/reference)); `opencode --session <id>`
    ([cli](https://opencode.ai/docs/cli/))); and a normalized state enum
    `{starting, thinking, awaitingApproval, awaitingInput, idle, finished, failed}` fed by Tier 0/1.

---

## TOPIC B — git worktree mechanics

Primary: <https://git-scm.com/docs/git-worktree>, <https://git-scm.com/docs/gitrepository-layout>,
libgit2 `include/git2/worktree.h`.

### B1. Command semantics

 1. `git worktree add [-f] [--detach] [--checkout] [--lock [--reason <s>]] [--orphan]
    [(-b|-B) <new-branch>] <path> [<commit-ish>]`;
    `list [-v | --porcelain [-z]]`; `lock`; `move`; `prune [-n] [-v] [--expire <t>]`;
    `remove [-f]`; `repair [<path>…]`; `unlock`. ([git-worktree](https://git-scm.com/docs/git-worktree))
 2. **Implicit branch creation is a footgun for an IDE.** "`git worktree add <path>` automatically
    creates a new branch whose name is the final component of `<path>`"; if `<commit-ish>` is
    omitted and the branch exists it is checked out "if it's not checked out anywhere else,
    otherwise the command will refuse to create the worktree (unless `--force` is used)".
    With no valid local branches it behaves "as if `--orphan` was passed".
    ([git-worktree](https://git-scm.com/docs/git-worktree))
    → **Janela must always pass an explicit `-b <branch>` or `--detach`.** Never rely on basename inference.
 3. `--detach` / `-d`: "detach HEAD in the new worktree". `-b` refuses if branch exists; `-B` resets
    it to `<commit-ish>`. `--no-checkout` "suppress[es] checkout in order to make customizations,
    such as configuring sparse-checkout". `--lock [--reason]` at add time is "equivalent of
    `git worktree lock` after `git worktree add`, but **without a race condition**".
    ([git-worktree](https://git-scm.com/docs/git-worktree))
 4. **remove/move restrictions.** "Only clean worktrees (no untracked files and no modification in
    tracked files) can be removed. Unclean worktrees **or ones with submodules** can be removed with
    `--force`. The main worktree cannot be removed." "the main worktree or linked worktrees
    containing submodules **cannot be moved** with this command." `--force` twice is required to
    remove/move a **locked** worktree. ([git-worktree](https://git-scm.com/docs/git-worktree))
 5. **prune vs lock.** `prune` removes `$GIT_DIR/worktrees` entries "for worktrees whose working
    trees are missing"; stale entries are also removed automatically per `gc.worktreePruneExpire`.
    `lock` adds a `locked` file that "prevent[s] its administrative files from being pruned…
    also prevents it from being moved or deleted." ([git-worktree](https://git-scm.com/docs/git-worktree))
 6. **repair** reconnects main↔linked worktrees after manual moves, in both directions.
    ([git-worktree](https://git-scm.com/docs/git-worktree))

### B2. On-disk layout (what Janela may read, and what it must not)

 1. "Each linked worktree has a private sub-directory in the repository's `$GIT_DIR/worktrees`
    directory. The private sub-directory's name is usually the base name of the linked worktree's
    path, **possibly appended with a number to make it unique**" (`test-next` → `test-next1`).
    ([git-worktree](https://git-scm.com/docs/git-worktree))
    → **The worktree "id" is not the path basename.** Never derive it; read it.
 2. Inside a linked worktree, `$GIT_DIR` points at that private dir and `$GIT_COMMON_DIR` points back
    at the main `.git`; "These settings are made in a `.git` **file**" at the worktree root.
    ([git-worktree](https://git-scm.com/docs/git-worktree))
    The gitfile mechanism: "a plain text file `.git` at the root of your working tree, containing
    `gitdir: <path>`". ([gitrepository-layout](https://git-scm.com/docs/gitrepository-layout))
 3. Admin files: `worktrees/<id>/gitdir` — "A text file containing the absolute path back to the
    .git file that points to here… The mtime of this file should be updated every time the linked
    repository is accessed." `worktrees/<id>/locked` — presence prevents pruning, "The file may
    contain a string explaining why". `worktrees/<id>/config.worktree` — per-worktree config.
    `commondir` — sets `$GIT_COMMON_DIR`. ([gitrepository-layout](https://git-scm.com/docs/gitrepository-layout))
 4. **Refs sharing rules.** "In general, all pseudo refs are per-worktree and all refs starting with
    `refs/` are shared… There are exceptions: refs inside `refs/bisect`, `refs/worktree` and
    `refs/rewritten` are not shared." Cross-worktree access via `main-worktree/HEAD` and
    `worktrees/<id>/HEAD`. ([git-worktree](https://git-scm.com/docs/git-worktree))
 5. **Config sharing.** "By default, the repository `config` file is shared across all worktrees."
    Per-worktree config requires `git config extensions.worktreeConfig true`, after which values live
    at `git rev-parse --git-path config.worktree`. Explicit guidance: "`core.worktree` should never
    be shared"; "`core.sparseCheckout` should not be shared, unless you are sure you always use
    sparse checkout for all worktrees"; **"Older Git versions will refuse to access repositories
    with this extension."** ([git-worktree](https://git-scm.com/docs/git-worktree))
 6. **Path resolution rule (do not hand-roll).** "The rule of thumb is do not make any assumption
    about whether a path belongs to `$GIT_DIR` or `$GIT_COMMON_DIR`… Use `git rev-parse --git-path`
    to get the final path." ([git-worktree](https://git-scm.com/docs/git-worktree))
 7. `worktree.useRelativePaths=true` "implies enabling the `extensions.relativeWorktrees` config…
    thus making it incompatible with older versions of Git."
    ([git-worktree](https://git-scm.com/docs/git-worktree))
    → Useful if Janela ever moves/copies workspaces, at the cost of git-version compatibility.

### B3. Enumerating programmatically

 1. `git worktree list --porcelain -z` is the contract. "This format will remain stable across Git
    versions and regardless of user configuration. It is recommended to combine this with `-z`."
    `-z` "Terminate each line with a NUL rather than a newline… makes it possible to parse the
    output when a worktree path contains a newline character."
    ([git-worktree](https://git-scm.com/docs/git-worktree))
 2. Record grammar: "one line per attribute… label and value separated by a single space. Boolean
    attributes (like `bare` and `detached`) are listed as a label only, and are present only if the
    value is true. Some attributes (like `locked`) can be listed as a label only or with a value…
    The first attribute of a worktree is always `worktree`, an empty line indicates the end of the
    record." Attributes observed in the doc's example: `worktree <path>`, `bare`, `HEAD <oid>`,
    `branch refs/heads/<name>`, `detached`, `locked [reason]`, `prunable <reason>`.
    ([git-worktree](https://git-scm.com/docs/git-worktree))
 3. **Without `-z`, lock reasons are quoted/escaped per `core.quotePath`** (`locked "reason\\nwhy is
    locked"`). ([git-worktree](https://git-scm.com/docs/git-worktree))
    → Another reason `-z` is mandatory, not optional.
 4. `--expire <time>` on `list` "annotate[s] missing worktrees as prunable if they are older than
    <time>" — i.e. Janela can ask "what *would* be pruned" without mutating anything, and
    `prune -n --verbose` dry-runs the removal. ([git-worktree](https://git-scm.com/docs/git-worktree))
 5. **Dirty state is *not* in `worktree list`.** Use a separate, per-worktree
    `git -C <path> status --porcelain=v2 -z --branch [--untracked-files=…]`.
    (`worktree list` exposes only bare/HEAD/branch/detached/locked/prunable —
    [git-worktree](https://git-scm.com/docs/git-worktree).)

### B4. Cost model and making creation fast

 1. `git worktree add` performs a **full checkout** of `<commit-ish>` by default; the only
    first-party lever documented is `--no-checkout`, offered specifically "in order to make
    customizations, such as configuring sparse-checkout" (see "Sparse checkout" in `git-read-tree`).
    ([git-worktree](https://git-scm.com/docs/git-worktree))
    → Fast-creation recipe on large repos, all primary-documented pieces:
    `git worktree add --no-checkout -b <b> <path> <base>` →
    `git -C <path> sparse-checkout set --cone <dirs>` (or `init --cone`) → `git -C <path> checkout`.
    Note finding 61: `core.sparseCheckout` "should not be shared" ⇒ enable
    `extensions.worktreeConfig` first, or you change sparsity for every worktree.
 2. Object storage is shared: a linked worktree "shar[es] everything except per-worktree files such
    as `HEAD`, `index`, etc." ([git-worktree](https://git-scm.com/docs/git-worktree))
    → Creation cost ≈ index write + working-tree materialization, not object copy. On APFS the
    dominant cost is file creation count; sparse-checkout is the only supported lever.
 3. `--lock` at creation avoids the add→lock race ([git-worktree](https://git-scm.com/docs/git-worktree));
    combine with a Janela-owned reason string so Janela's GC can distinguish its own locks from the
    user's (mirroring Claude Code's documented rule that it never releases user-set locks —
    [worktrees](https://code.claude.com/docs/en/worktrees)).

### B5. What breaks in a worktree

 1. **Submodules — officially unsupported.** git-worktree BUGS: "Multiple checkout in general is
    still experimental, and the **support for submodules is incomplete. It is NOT recommended to
    make multiple checkouts of a superproject.**" ([git-worktree](https://git-scm.com/docs/git-worktree))
    Corroborating specifics in the same doc: `move` refuses worktrees containing submodules;
    `remove` needs `--force` for them.
 2. **Hooks are shared, not per-worktree.** Hooks live under `$GIT_COMMON_DIR` (they are not listed
    among the per-worktree files `HEAD`/`index`; the per-worktree exceptions are enumerated as
    pseudo-refs plus `refs/bisect`, `refs/worktree`, `refs/rewritten`)
    ([git-worktree](https://git-scm.com/docs/git-worktree)). Anything a hook resolves relative to
    `$GIT_DIR` must go through `git rev-parse --git-path` (finding 62).
 3. **Sparse-checkout state is per-worktree only if `extensions.worktreeConfig` is on** (finding 61).
 4. **Index is per-worktree** ("per-worktree files such as `HEAD`, `index`")
    ([git-worktree](https://git-scm.com/docs/git-worktree)) — so a stale `index.lock` in one worktree
    does not block another, but `.git/worktrees/<id>/index` corruption is local and recoverable by
    `git -C <path> reset`.
 5. **Gitignored artifacts are simply absent.** Confirmed first-party by Anthropic: "A worktree is a
    fresh checkout, so untracked files like `.env` or `.env.local` from your main repository are not
    present." Their fix is `.worktreeinclude` (gitignore syntax; only files that are *both* matched
    and gitignored are copied) ([worktrees](https://code.claude.com/docs/en/worktrees)).
    → **This is the single best-attested "what real tools do" datapoint.** Janela should implement
    the same semantics and, for interop, read the repo's existing `.worktreeinclude` if present.
 6. **LFS**: no statement in git-worktree docs; treat as unverified (see Gaps).

### B6. libgit2 / SwiftGit2 vs shelling out to `/usr/bin/git`

 1. **libgit2's worktree API is a strict subset of the CLI.** From
    [`include/git2/worktree.h`](https://github.com/libgit2/libgit2/blob/main/include/git2/worktree.h)
    the *entire* public surface is:
    `git_worktree_list`, `git_worktree_lookup`, `git_worktree_open_from_repository`,
    `git_worktree_free`, `git_worktree_validate`, `git_worktree_add_options_init`,
    `git_worktree_add`, `git_worktree_lock`, `git_worktree_unlock`, `git_worktree_is_locked`,
    `git_worktree_name`, `git_worktree_path`, `git_worktree_prune_options_init`,
    `git_worktree_is_prunable`, `git_worktree_prune`.
 2. **Missing vs the CLI**: there is **no `remove`**, **no `move`**, **no `repair`**, no
    `--detach`-equivalent beyond passing `opts.ref`, no `--orphan`, no `-B`, no `--guess-remote`,
    no relative-paths mode, and no dirty/prunable *reason* strings beyond `giterr_last`.
    `git_worktree_add_options` carries only `{version, lock, checkout_existing, ref,
    checkout_options}` ([worktree.h](https://github.com/libgit2/libgit2/blob/main/include/git2/worktree.h)).
    `git_worktree_prune` deletes only "the git data structures on disk" — the working directory
    removal that `git worktree remove` performs is the caller's problem
    ([worktree.h](https://github.com/libgit2/libgit2/blob/main/include/git2/worktree.h)).
    `git_worktree_list` returns **names**, not paths, and gives no HEAD/branch/locked/prunable
    record — you must `lookup` + `is_locked` + `is_prunable` per entry, i.e. N× the syscalls of one
    `git worktree list --porcelain -z`.
 3. **Verdict (stated clearly, as requested): shelling out to `/usr/bin/git` is more reliable for
    worktrees.** Evidence, not preference: (a) the porcelain format is contractually stable across
    git versions ([git-worktree](https://git-scm.com/docs/git-worktree)) whereas libgit2 exposes no
    equivalent aggregate query; (b) `remove`, `move`, and `repair` — the three operations an IDE
    needs for lifecycle management — have **no** libgit2 equivalent (finding 79); (c) libgit2 does
    not implement the `worktree.guessRemote`, `--orphan`, or relative-paths behaviors the CLI
    documents; (d) git's own docs instruct callers to use `git rev-parse --git-path` rather than
    reasoning about `$GIT_DIR`/`$GIT_COMMON_DIR` (finding 62), which is a CLI call regardless.
    → Keep the chosen "shell out to `/usr/bin/git`" decision. If a linked library is ever wanted,
    scope it to *read-only, hot-path* queries (status, diff, blame) behind the same protocol, and
    keep worktree lifecycle on the CLI.

---

## Implications for Janela — concrete recommendations

### Agent hosting

- **A1. Model an agent as `AgentAdapter` with a `StateChannel`, not as "a terminal running a binary."**
  Three concrete channels exist today and they are all better than screen-scraping:
  Claude Code hooks (`Notification`/`Stop` + `terminalSequence`), Codex `notify` + hooks,
  OpenCode `GET /event` SSE. Build the normalized state enum in finding 50.
- **A2. Ship a Janela hook bundle, install it per-agent, and make trust an onboarding step.**
  Claude Code: write to a Janela-owned settings file and pass `--settings <path>` +
  `--setting-sources user,project,local` so you never mutate the user's `~/.claude/settings.json`.
  Codex: hooks require *manual* `/hooks` trust keyed to the hook's **hash** — plan the UX for that,
  and re-prompt on every Janela version bump that changes the hook command.
- **A3. Prefer `terminalSequence` OSC over a side-channel where possible.** Because Claude Code will
  emit OSC 0/1/2/9/99/777 + BEL on a hook's behalf, Janela's PTY parser can be the *only* transport:
  no sockets, no ports, works over SSH and inside tmux (Anthropic's stated rationale). Implement all
  four OSC notification dialects; do not pick one.
- **A4. Identify Janela to agents.** Set `TERM_PROGRAM=Janela`, `TERM_PROGRAM_VERSION`,
  `TERM=xterm-256color`, `COLORTERM=truecolor`. Answer the DECRQM probe for mode **2026**.
  Support OSC 8, alt screen 1049, bracketed paste 2004, SGR mouse 1006 + 1002/1003, focus reporting
  1004, and kitty keyboard (or modifyOtherKeys) so Shift+Enter works without `/terminal-setup`.
  **Do not set `CLAUDECODE`.**
- **A5. Startup time**: default one-shot/scripted Claude Code invocations to `--bare`; for OpenCode,
  run one `opencode serve` per workspace and use `opencode attach` / `run --attach` for the N
  sessions (OpenCode's own docs cite MCP cold-boot as the reason).
- **A6. Session persistence**: allocate the session ID yourself where you can
  (`claude --session-id <uuid>`), so Janela's SQLite row is the primary key and resume is
  deterministic. For Codex/OpenCode, capture the ID from `resume`/`session list --format json`.
- **A7. Codex sandbox is a first-class workspace setting.** Any Janela-created worktree must be added
  to `sandbox_workspace_write.writable_roots` and marked `projects.<path>.trust_level = "trusted"`,
  otherwise project `.codex/` layers (incl. AGENTS-adjacent config and hooks) silently do not load.
- **A8. Never parse `~/.claude/projects/**/*.jsonl`.** Anthropic documents the format as internal
  and version-unstable. Same caution for any OpenCode/Codex on-disk session store; use their APIs.

### Git / worktrees

- **B1. Keep `/usr/bin/git`.** Evidence in finding 80. Put it behind a `GitRunner` protocol with a
  process pool; every command gets `--porcelain`/`-z` where offered and an explicit `-C <path>`.
- **B2. Canonical enumeration query**: `git worktree list --porcelain -z --expire <ttl>`, parsed as
  NUL-terminated `label [value]` records with empty-record separators. Do **not** derive the worktree
  id from the path basename (uniquifying suffix, finding 57). Follow with per-worktree
  `git -C <p> status --porcelain=v2 -z --branch` for dirty state, on a bounded concurrency queue.
- **B3. Creation policy**: always `git worktree add --detach` or `-b <explicit-branch>`; add `--lock
  --reason "janela:<session-id>"` at creation to avoid the documented race; never release a lock whose
  reason Janela did not write.
- **B4. Fast creation on large repos**: `--no-checkout` → `extensions.worktreeConfig true` →
  `sparse-checkout set --cone` → `checkout`. Gate it on repo size and expose it as opt-in; note the
  older-git incompatibility of `extensions.worktreeConfig` and `extensions.relativeWorktrees`.
- **B5. Gitignored artifacts**: implement `.worktreeinclude` with Anthropic's exact semantics
  (gitignore syntax; copy only files that match *and* are gitignored). Offer an APFS clonefile
  (`clonefile(2)`)-backed copy for large dirs, but treat `node_modules` as opt-in — semantics of a
  cloned `node_modules` with absolute paths in `.bin` symlinks are a real hazard.
- **B6. Hard-block worktrees for superprojects with submodules** (git BUGS section) — or at minimum
  warn loudly and disable `move`.
- **B7. Never touch `$GIT_DIR` paths directly.** Resolve every internal path via
  `git rev-parse --git-path <p>`; this is git's own explicit instruction.
- **B8. Removal**: `git worktree remove` (add `--force` once for unclean, twice for locked), then
  `git worktree prune` on a schedule; use `prune -n -v` to preview and surface `prunable <reason>`
  from `list --porcelain` in the UI.
- **B9. Worktree-aware, not worktree-centric — validated.** Claude Code itself models the repo as the
  unit and worktrees as a view: session pickers default to the current worktree with `Ctrl+W` to
  widen to all worktrees of the repo, and session-ID resume searches "the current project directory
  and its git worktrees" first. Janela's workspace = repo; worktrees = child scopes. Match that.

### Explicit contradictions / risks in the already-chosen stack

- **⚠️ CONTRADICTED (partially) — "SwiftTerm for VT emulation".** SwiftTerm covers a lot of what the
  agents need — OSC 133 semantic prompts with click routing, DEC 2026 synchronized output, kitty
  keyboard flags, bracketed paste, SGR/pixel mouse modes, alt buffer, OSC 7/8/52, OSC 9;4 progress —
  see `Sources/SwiftTerm/Terminal.swift` (`TerminalDelegate.synchronizedOutputChanged`,
  `semanticPromptClickBehavior`, `keyboardEnhancementFlags`, `bracketedPasteMode`,
  `progressReport(source:report:)`, `oscSemanticPrompt(_:)`)
  <https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/Terminal.swift>.
  **But its notification coverage does not match Claude Code's allowlist:**
  - `Terminal.oscNotification(_:)` requires `parts.count >= 3 && parts[0] == "notify"`, so the
    **valid VTE 2-field form `OSC 777;notify;SUMMARY` is silently dropped** (VTE explicitly supports
    `OSC 777 ; notify ; SUMMARY BEL` —
    [GNOME/vte commit](https://lists.gnome.org/archives/commits-list/2021-March/msg10780.html)).
    *Severity: high* — this is exactly what a Claude Code `terminalSequence` hook may emit.
  - There is **no OSC 99 (kitty) handler** and no plain **OSC 9 message** notification delegate
    (only `progressReport` for `OSC 9;4`); `TerminalDelegate` has `notify(source:title:body:)` but
    no kitty-protocol equivalent (chunking `i=`/`d=`, base64 `e=1`, `a=report` round-trip).
    *Severity: high* — 2 of the 6 allowlisted OSC codes are unhandled.
  - Mitigation exists and is cheap: `Terminal.registerOscHandler(code:handler:)` is public
    (same file), so Janela can install its own 9 / 99 / 777 handlers. **Do this in Janela code, not
    by forking SwiftTerm**, and keep them behind the swappable terminal protocol.
  - Also verify before committing: SwiftTerm's synchronized-output path has a documented 16 ms
    debounce and recent input-latency work
    ([PR #553](https://github.com/migueldeicaza/SwiftTerm/pull/553),
    [releases](https://github.com/migueldeicaza/SwiftTerm/releases)). For "many concurrent sessions"
    this coalescing is a *feature* for background sessions and a *liability* for the focused one.
    Benchmark focused-session keystroke→glyph latency early; it is the one thing that would justify
    swapping the emulator.
- **⚠️ RISK — "unsandboxed + hardened runtime".** Correct for Janela itself, but note Codex ships its
  own OS-enforced sandbox for model-run commands and defaults to network-off
  ([sandboxing](https://developers.openai.com/codex/concepts/sandboxing)). Janela must not appear to
  weaken that: surface the effective `sandbox_mode`/`approval_policy` per session in the UI, and
  never inject `--dangerously-skip-permissions` / `--sandbox danger-full-access` implicitly.
- **✅ NOT CONTRADICTED — shelling out to `/usr/bin/git`.** Reinforced; see finding 80. Do **not**
  adopt SwiftGit2/libgit2 for worktree lifecycle.
- **✅ NOT CONTRADICTED — GRDB/SQLite for metadata**, provided nothing on the SessionEnd hook path
  does a blocking write: Claude Code gives SessionEnd hooks **1.5 s** total and Codex gives **1 s
  (max 3)**. Use a non-blocking IPC write, drain into GRDB asynchronously.
- **⚠️ GAP — terminal identity.** With an unrecognized `TERM_PROGRAM`, Claude Code sends **no**
  desktop notification (only Ghostty/Kitty/iTerm2 are native) and disables OSC 8 hyperlinks and
  strikethrough by default. Janela must either be detected or the user must set
  `preferredNotifChannel: "terminal_bell"` / `FORCE_HYPERLINK=1`. Plan to (a) parse the OSC
  notification codes anyway (they arrive via `terminalSequence`), and (b) file/track upstream
  detection for Janela.

---

## Sources

Kept (primary):

- Claude Code CLI reference / headless / sessions / hooks / settings / env-vars / terminal-config /
  worktrees — code.claude.com/docs/en/* — normative flags, hook events, OSC allowlist, worktree behavior.
- OpenAI Codex: cli/reference, config-reference, config-basic, config-advanced, concepts/sandboxing,
  agent-approvals-security, hooks — developers.openai.com/codex/* — normative config keys and events.
- OpenCode: docs/cli, docs/server, docs/config, docs/tui + `packages/opencode/src/config/tui.ts` —
  server/TUI split, SSE event stream, config file split.
- agents.md — the AGENTS.md convention, precedence rule, adopter list, stewardship.
- git-scm.com/docs/git-worktree and /docs/gitrepository-layout — worktree semantics and on-disk layout.
- libgit2 `include/git2/worktree.h` — exact libgit2 worktree API surface.
- iTerm2 proprietary escape codes — OSC 9, OSC 9;4, OSC 133 A/B/C/D normative descriptions.
- kitty desktop-notifications — OSC 99 protocol.
- GNOME/vte commit + `src/vteseq.cc` — OSC 777 `notify` forms.
- Ghostty docs/source — OSC 9 vs ConEmu OSC 9;n, OSC 133 parser and spec reference.
- SwiftTerm `Sources/SwiftTerm/Terminal.swift`, `EscapeSequences.swift` — actual emulator capabilities.

Dropped:

- Claude Academy / SFEIR "headless mode" tutorials — secondary restatements of `-p`.
- terminfo.dev extension pages — useful index, but a third-party compatibility table; used only to
  locate the primary VTE/kitty/iTerm2 sources, never cited as evidence.
- anomalyco/opencode issue mirrors — used only to locate the sst/opencode source file.

## Gaps

1. **Git LFS in linked worktrees** — no primary statement found in git-scm.com docs. Next step: read
   `git-lfs/git-lfs` `lfs/config.go` / `commands/command_install.go` for `$GIT_COMMON_DIR` handling,
   and the smudge-filter path resolution.
2. **OSC 133 semantic-prompts canonical spec text** — gitlab.freedesktop.org blocked the fetch
   (anti-bot). Cited via iTerm2's normative A/B/C/D descriptions + Ghostty's parser, which both name
   the same spec URL. Next step: fetch the raw file from a git mirror.
3. **Codex `notify` JSON payload schema** — the config reference documents the key but not the
   payload shape. Next step: `openai/codex` Rust source (`codex-rs/core/src/…` user-notification).
4. **Whether Claude Code reads `AGENTS.md`** — not stated in any Anthropic doc found; only `CLAUDE.md`
   and `.claude/rules/*.md` are documented. Treat as "no" until proven.
5. **SwiftTerm OSC dispatch-table registration** for codes 9/777 lives outside `Terminal.swift`;
   verify at build time which codes are pre-registered before writing `registerOscHandler` overrides.
6. **`git worktree add` wall-clock cost on a 100k-file repo** — no benchmark from a primary source.
   Measure locally: full checkout vs `--no-checkout` + cone sparse-checkout, on APFS.
