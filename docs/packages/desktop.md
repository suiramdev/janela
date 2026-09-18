# `apps/desktop`

Layer 10: the Tauri shell and the composition root. `src-tauri/` is a thin Rust
shell; `src/` is the FSD `app` layer. `@tauri-apps/*` is gated to this package by
`scripts/layers.ts`.

## `src/environment.ts` — the composition root

Everything is constructed once and injected downward: no service locator, no
singleton graph, no module-level mutable state. This process is a **client** — it
does not own a PTY, a database or a git checkout, and none of those packages are
linked, so it could not if it tried.

- **The window paints before the daemon answers.** Connecting is started here and
  awaited nowhere; a launch that blocks on a socket hands the daemon a veto over the
  launch budget, which is the coupling the two-process split exists to remove
  (`performance.md` § Launch). Nothing here opens a database or runs a migration
  either — those live in the daemon, where a failure surfaces as a connection that
  does not come up rather than an app that will not launch.
- `openTransport` is a factory called once per attempt: the retry loop, the backoff
  and the re-subscribe are `@janela/client`'s, and the shell makes one connect
  attempt and never retries (#28, #30).
- `LaunchAgentStatus` adds two states to the Rust side's set: `"unknown"` before the
  check answers, and `"unavailable"` when the invoke itself failed.
  `"requires-approval"` is a **supported state, not an error** — the app works,
  terminals die when it quits, and it says so with a link to the settings pane.
  Refusing to work at all would be worse. The settled status is logged because a
  screenshot of an empty window cannot tell "registered" from "terminals die when you
  quit".
- Registration is fired, not awaited: it talks to `smd`, which can take a moment and
  can ask the user for approval.
- `TerminalFocus` is an installed function rather than an import because
  `liveEnvironment` must not depend on `@janela/ui` — a graph that needs a React tree
  to construct is not one a headless test can build. Until the view installs one, a
  notification click selects the session and stops there.
- `stopBackgroundService` **disconnects first**. The client's reconnect loop runs
  `launchctl kickstart` through the bridge on every failed attempt, so stopping the
  daemon while it is running would restart the process the user just asked us to stop.
- Attention routing is subscribed at construction rather than in `start()`:
  registering a handler spawns nothing, and a signal cannot arrive before the
  connection does.
- `document.hasFocus()` is the browser's answer to "is this window frontmost", and it
  is synchronous — the policy is consulted on the signal path.

## `src/main.tsx`

- The log sink is installed before anything can log, so a client log and a daemon log
  carry the same shapes and can be read side by side. `notice` has no counterpart in
  the plugin's five levels and maps to `info`; writing is fire-and-forget, because a
  log line must never be something the caller waits for.
- `view` and the confirmation queue are built here rather than in `liveEnvironment()`
  so the composition root stays about the daemon connection. The queue needs both the
  window it was silenced in and the storage the next launch reads.
- `connect()` and the native menu are started in an effect, after first paint, and
  neither is awaited. StrictMode fires the effect twice in development, which is
  harmless: `connect()` is idempotent while a loop is running, and registration
  reports the existing status rather than registering twice.
- `renderSettings` is declared outside `App` so its identity is stable across
  renders, and outside `@janela/ui` because `pages/settings` and `pages/main-window`
  are siblings there — composing them is this layer's job.
- `ROOT_ELEMENT_ID` is exported so `index.html` and this file cannot disagree.
- The `requestAnimationFrame` line is the launch-budget instrument until
  `@janela/support`'s `begin("launch")` exists: navigation start → first animation
  frame, read next to the shell's own "window loaded" line.

## `src/adapters/transport.ts`

**A WebView cannot open a Unix socket**, so the Rust shell opens it and this relays
frames across Tauri's IPC. It is the concrete cost of the Tauri decision and the
concrete proof the seam is real: a browser client replaces exactly this file.

- **The performance rule.** Tauri's IPC can carry raw bytes without a JSON
  round-trip, and it must: base64 through IPC would inflate every repaint by a third
  and add two passes per frame. So a frame goes out as the invoke's *whole body* and
  comes back as an `ArrayBuffer`, and the connection id travels in a header — the
  moment it joined the body, every repaint would be inside a JSON object
  (`performance.md` § Terminal throughput).
- **Back-pressure is the shell's, and nothing is dropped.** A WebView that stops
  draining for 32 output frames or 64 control frames has its connection severed and
  `incoming()` throws `BridgeRefused` named `bridge-stalled`. That is lossless — the
  client reconnects into a full snapshot and full repaints — where dropping a repaint
  would not be: repaints are deltas, so a lost one is a grid that stays quietly wrong
  and a daemon that cannot know. Input has no queue at all; `bridge_send` awaits the
  socket write, so the returned promise *is* the back-pressure.
- `BridgeRefused` carries its reason as the error's **name** because Tauri rejects
  with the raw string the Rust side returned, and every logger in `@janela/client`
  reduces a thrown value to `error.name` — an unwrapped rejection is logged as
  `"unknown"`, losing the reason exactly where a bug report needs it. The reason set
  is closed and ours (`bridge.rs`), so it is safe as a log field: never peer-supplied
  text.
- One decoder per transport: a decoder that has thrown is finished, and a reconnect
  gets a new transport rather than a reset one.
- A zero-length `bridge_receive` response is the shell saying the socket ended.
  `end()` then throws `truncated` if a frame was in flight, which is the distinction
  `MessageTransport` documents: a clean close finishes the sequence, a dirty one
  throws.
- `close` swallows its failure — the connection may already be gone — and it is also
  what unblocks the shell's parked `bridge_receive`, which is how `incoming()`
  finishes.
- `CONNECTION_HEADER` mirrors the Rust constant of the same name; there is
  deliberately no third place that knows the string.

## `src/adapters/notification-delivery.ts`

A real system notification, not a toast: an in-page imitation would live inside a
window the user is by definition not looking at, which is the one situation the
feature exists for.

**What the plugin can and cannot do on macOS today.** Its desktop backend registers
three commands — `is_permission_granted`, `request_permission`, `notify` — and posts
through `notify-rust`, discarding the response. So posting works;
`request_permission` answers `granted` unconditionally and the real prompt is
macOS's own on the first post from a signed bundle; `remove_active` does not exist,
so a banner cannot be pulled back; and there is no click listener, so `onAction`
never fires. The last two are probed once, degraded and never retried — a capability
does not appear later in the same process — and nothing here pretends a withdrawal
happened.

- Nothing happens until the first delivery: no permission asked, no listener
  registered, no invoke. A user who never leaves the app never sees a prompt, and
  launch stays off the critical path.
- Authorization is settled once and never revisited; a denial is treated as final
  because asking again on every signal would be a prompt loop.
- `MAXIMUM_OUTSTANDING_NOTIFICATIONS` (64) and `MAXIMUM_IN_FLIGHT_DELIVERIES` (16) are
  the documented bounds (§ Non-negotiables 9). Losing the oldest id means the oldest
  banner cannot be withdrawn, by which time macOS has collapsed it into the
  Notification Centre list. The in-flight window is only ever open on the very first
  delivery, so it guards a pathological burst during that one prompt rather than
  being a queue.
- In-flight entries are mutable objects rather than ids, because `withdraw` has to
  reach a delivery that has no notification id yet — which is exactly the delivery
  that would otherwise post a banner for a session that was just deleted. **A session
  removed while a delivery is still deciding never posts at all**, which is the part
  that works regardless of the plugin's gaps.
- Ids are dropped from `outstanding` even when removal is unsupported: holding them
  would be an unbounded list of things we cannot act on.
- The body goes in exactly one place. `extra` carries ids only, so the click route
  needs nothing that identifies content. The design wanted the session name in the
  title and the terminal title in the subtitle; the backend has no subtitle, so both
  routing facts share the title and the body stays exactly what the program supplied
  — also the cleaner privacy line. A body is never synthesised from scrollback.
- A click withdraws **every** banner for that session, not only the one clicked: the
  user is looking at that session now, so the rest are stale.
- `raiseWindow` asks for `setFocus` alone: `show` and `unminimize` are separate
  capability entries, and asking for permissions a click does not need is how a
  capability set stops meaning anything. `core:window:allow-set-focus` may be absent,
  in which case the session is still selected and the window simply did not come
  forward.
- The bare-bell branch in `notificationContent` exists so the mapping is total, not
  because the policy ever delivers one.
- The privacy test drives the whole lifecycle past a recording logger and pins all
  four strings, not just the body: the composed title carries the terminal's OSC 0
  title, which is the user's output too. It also asserts something *was* logged and
  that the content did travel, so it cannot pass vacuously.

## `src/adapters/window-controls.ts`

The title bar is an overlay, so the traffic lights sit inside the window on the
sidebar's first row — except in fullscreen, where the system takes them away and the
row should have its leading space back. Only the shell can answer that.

- **Why a resize event and not a fullscreen one:** there is no fullscreen event. tao
  reports a resize on the way in and out, and the window can answer `isFullscreen()`
  — so the answer is re-asked on every resize with **at most one question
  outstanding**, because a live resize drag fires at frame rate. Nothing blocks; being
  wrong for a frame costs a row 68px of leading space. It is also asked once at
  construction, so a window that opens into a restored fullscreen Space is not waiting
  for a resize that may never come.
- A window that will not answer is assumed to be an ordinary one: the cost of being
  wrong is cosmetic.
- `titleBarStyle`, `hiddenTitle` and `trafficLightPosition` are macOS-only keys, so
  anywhere else the window keeps its own decorations *above* the WebView, nothing
  overlaps that row, and this answers `false` for the life of the process. That is the
  intent, not a gap: the app's name is in the window's own title bar there, and a
  sidebar that repeats it is the duplication this removed.
- The platform default is read from the user agent, the one platform fact a WebView
  carries without a plugin, a permission or an invoke.
- `window-controls.test.ts` pins `tauri.conf.json` to what the views are laid out for,
  because the two cannot import each other and nothing notices when they disagree —
  the buttons simply sit on top of the search control. `Overlay` is what puts content
  under the buttons (`Transparent` would leave a 28px strip), and `decorations` must
  stay on: the buttons need the frame, only the *title* goes.
- `dragDropEnabled` is **off**, and the same test pins it. Tauri's native handler
  exists to hand *files* dropped from Finder to Rust, and on macOS it answers the
  drag session before the page does: `dragstart` fires, so a tab or a pane bar can
  be picked up, but `dragover` and `drop` never reach the DOM and nothing lands.
  Nothing here consumes the native events, and every drag in `@janela/ui` — tab
  reorder, pane docking — is HTML5 DnD on the page.

## `src/adapters/{native,menu}.ts`

- **Native shell and directory picker:** the app performs file selection and the
  daemon is handed paths. That keeps macOS permission prompts attributed to the app
  the user just clicked rather than to a background binary they have never heard of.
  A `null` from the dialog is a cancellation, which is an answer rather than a
  failure. The picker is `ClientEnvironment.directories`, a port every client has —
  the browser client answers it with the daemon's listing and its own column view —
  and this one is the real `NSOpenPanel` because the machine that has Finder should
  not be shown a lesser one. `openPath(path, "Terminal")` names Terminal.app
  explicitly, which the capability scopes to exactly that — the user's *default*
  handler would be Finder again. Confirmations used to live here as the plugin's
  `ask()`; they are the application's own dialog now. Finder and Terminal.app,
  together with `stop`/`stopAndUnregister` and `restartDaemon`, are
  `ClientEnvironment.local`: the ports only a client on the daemon's own Mac can
  answer. The browser client leaves `local` undefined and the views hide what needs
  it.
- **Menu:** the command table is handed to the shell once at startup, so adding a row
  to `COMMANDS` adds a menu item with no Rust change and no second list. An id this
  build does not know is a version skew between the menu and the table, and dropping
  it beats dispatching a guess. A failed install is logged and nothing else: every
  command is still reachable from ⌘⇧P. `COMMAND_EVENT` is paired with the Rust
  constant of the same name.
- **Accelerators follow the settings.** `syncNativeShortcuts` watches the view and
  hands the shell the merged table (`commandsWithShortcuts`) whenever the overrides
  change, through `set_menu_accelerators`. It sends nothing while every shortcut is
  the default, because the Rust menu already has the defaults, and it sends the
  whole table rather than a diff so a reset reaches the menu as the default chord
  and not as silence. While the Shortcuts pane is recording, it sends the table with
  every accelerator `null` and restores it when recording ends: a native menu answers
  a chord before the WebView sees it, so ⌘T pressed into the recorder would otherwise
  open a terminal instead of being recorded. The applier is a typed function rather
  than the raw bridge so the test can read what was sent without asserting on argv.
- **Testing:** both files take the plugin function they call as an optional
  dependency — `open`, `openPath`, `revealItemInDir`, `listen` — defaulting to the
  real `@tauri-apps/*` export, the same shape as `LiveEnvironmentDeps.invoke`.
  `menu.test.ts` and `native.test.ts` drive them with fakes under `bun test`, so
  nothing here needs a window: the cancelled-dialog answer, the Terminal.app target,
  the unknown-id drop, and the unsubscribe-before-registered race (a listener
  released *after* the subscriber has gone would otherwise leak for the window's
  lifetime). This is the full extent of what the shell's TypeScript can prove
  headlessly; the assembled window — real `WKWebView`, real menu bar, real IPC —
  is a human with `bun run desktop`, and the launchd half is
  [`survival-proof.md`](../survival-proof.md).
- **Clipboard and settings storage** are not Tauri's: they are web-platform ports,
  implemented once in `@janela/ui`'s `shared/lib/web-platform/` and shared with the
  browser client ([`ui.md`](ui.md) § web-platform). The stylesheet and its token
  test live in `@janela/design` for the same reason ([`design.md`](design.md)).

## `scripts/` — the bundle gate

The bundle's shape is a contract between three places that cannot import each other:
`tauri.conf.json`, the LaunchAgent plist, and the registration code in the Rust
shell. `bundle-layout.ts` is the TypeScript side; `bundle-verification.ts` is what
stops the three drifting silently. Four failures it exists to catch, each of which
passes `cargo build` and `tauri build` happily:

1. the sidecar unsigned, or signed without the hardened runtime — notarization
   rejects it and `SMAppService.register()` refuses it;
2. the entitlements missing — the daemon then runs interpreted (47× slower) or cannot
   `dlopen` its PTY library at all;
3. the LaunchAgent plist absent from the signature's sealed resources — `smd` refuses
   to load a plist whose bundle fails a static signature check (`errSecCSBadResource`,
   -67054);
4. the sidecar in `Contents/Resources`, where Tauri's bundler does not sign it (Apple
   treats a Mach-O under `Resources` as data rather than code).

- `MAIN_EXECUTABLE_NAME` is the Cargo binary's name — lowercase, and *not*
  `productName`. It is compared as a string against `Info.plist` because macOS
  filesystems are case-insensitive by default, so `existsSync` would accept
  `Contents/MacOS/Janela` here and the app would vanish on a case-sensitive volume.
- `FORBIDDEN_LAUNCH_AGENT_KEYS` each undo a decision: `Sockets` because socket
  activation was dropped (#39) and a launchd-owned socket publishes its path only into
  the GUI login session; `Program`/`ProgramArguments` because an absolute path into
  the bundle is user-specific and `BundleProgram` is the relative form SMAppService
  wants; `RunAtLoad` because registering must not start a daemon nobody asked for;
  `StandardOutPath`/`StandardErrorPath` because launchd expands no `~` and this plist
  is sealed once for every user of the machine, so the only path either could name is
  a shared one — the daemon owns its log instead (#45).
- The entitlement lists are measured, not defensive. App Sandbox is asserted by its
  *absence*, because absence is what "off" means.
- Every check runs even after an earlier one fails, so one run lists everything wrong
  with a bundle.
- A missing tool throws rather than becoming a problem: there is no fallback for
  `codesign`, and reporting "the bundle is unsigned" because the verifier could not
  look would be a lie. `codesign --display` writes its report to stderr, and its
  verdict is the last non-empty line — the `--prepared:`/`--validated:` progress comes
  first.
- `CodeResources` holds `<data>` hashes, which have no JSON form, so the seal check
  reads the XML rather than converting it.
- Notarization requires a secure timestamp, and `codesign` omits the `Timestamp=` line
  without one.
- `bundle-verification.test.ts` fakes nothing: the behaviour under test *is* the
  signing tool's, and a fake would only assert that we know what `codesign` does —
  exactly the knowledge that turns out to be wrong when a bundle fails on a user's
  machine. Each fixture is a miniature Janela.app signed inside out, in the bundler's
  order: sidecar, app executable, bundle.
- What the expectation checks depends on the environment, because that is what decides
  what the build could do: with no `APPLE_*` variables the bundle is ad-hoc signed,
  which still exercises the hardened runtime, the entitlements and the sealed plist.
  With release credentials it additionally requires a Developer ID authority, a secure
  timestamp, a stapled ticket and Gatekeeper acceptance. `APPLE_SIGNING_IDENTITY` must
  be set explicitly whenever `APPLE_CERTIFICATE` is used, because Tauri checks that
  the identity is contained in the certificate's name.
- Notarization and stapling happen *inside* `tauri build` (`notarytool submit --wait`,
  then stapling unless `--skip-stapling`). There is no separate step and no release
  workflow yet; a release is produced by running `bun run desktop:build` from the
  repository root with `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` and
  `APPLE_TEAM_ID` set.
- `sidecar.ts` runs before `tauri dev`, `tauri build` and the CI shell job, because
  tauri-build copies the sidecar at *compile* time and fails if it is missing. It is a
  copy, not a symlink: the bundler needs a real file to sign.

## `vite.config.ts`

`port`/`strictPort` must agree with `build.devUrl` in `tauri.conf.json` — the Tauri
CLI waits for that exact URL before it starts cargo. The build target is `safari18`,
the WKWebView on the macOS 15 floor.
