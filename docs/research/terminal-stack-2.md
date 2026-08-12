# Research: Terminal emulation + PTY on macOS for a native Swift app (Janela)

Scope: primary sources only — repository source code, headers, official docs, man pages, specs.
Target: Janela, a native macOS agentic IDE (Xcode 26.6 / Swift 6.3.3 / macOS 26 SDK / arm64 / deployment target macOS 15), terminal-first, hosting many concurrent CLI agent sessions.

All non-obvious claims below cite a URL; source-code claims cite repo path + symbol.

---

## 0. Executive summary (read this first)

1. **SwiftTerm is no longer a CoreText-only renderer.** As of commit `3c45fdc` (2026-03-15, "Gpu backend, inspired by the Ghostty GPU engine", +4208/−119 across 22 files) it ships a Metal renderer with a glyph atlas, alongside the CoreGraphics/CoreText path. This invalidates the most common objection to SwiftTerm.
   - <https://github.com/migueldeicaza/SwiftTerm/commit/3c45fdcfcf4395c72d2a4ee23c0bce79017b5391>
   - `Sources/SwiftTerm/Apple/Metal/MetalTerminalRenderer.swift` (143 KB), `GlyphAtlas.swift`, `CoreTextGlyphRasterizer.swift`, `Shaders.metal` — <https://github.com/migueldeicaza/SwiftTerm/tree/main/Sources/SwiftTerm/Apple/Metal>
2. **libghostty-vt is now consumable from Swift today, officially, as an SPM `binaryTarget` XCFramework.** Ghostty ships `example/swift-vt-xcframework` with `zig build -Demit-lib-vt` producing `zig-out/lib/ghostty-vt.xcframework`. This is a real, first-party path — but it is VT/state/render-state only, has an explicitly unstable API, and requires Zig 0.16.x in the build chain.
   - <https://github.com/ghostty-org/ghostty/tree/main/example/swift-vt-xcframework>
   - <https://github.com/ghostty-org/ghostty/blob/main/example/swift-vt-xcframework/Package.swift>
3. **The full libghostty embedding API (`include/ghostty.h`, surfaces + Metal rendering + PTY spawn) is not a third-party API.** Its own header says the only consumer is the macOS app and there is no documentation beyond Zig source. Official docs say the API is "not stable".
   - <https://github.com/ghostty-org/ghostty/blob/main/include/ghostty.h>
   - <https://ghostty-org-ghostty.mintlify.app/api/overview>
4. **Ghostty's own macOS app is NOT sandboxed** — `macos/Ghostty.entitlements` contains no `com.apple.security.app-sandbox` key. This is direct primary evidence supporting Janela's unsandboxed + hardened-runtime choice.
   - <https://github.com/ghostty-org/ghostty/blob/main/macos/Ghostty.entitlements>
5. **Writing your own VT parser is a multi-engineer-year commitment** if you want xterm-level coverage: the xterm ctlseqs spec is at Patch #410 (2026/04/19) with ~78 DEC private modes and ~41 OSC commands, before you touch reflow, scrollback, sixel, or Kitty graphics.
   - <https://invisible-island.net/xterm/ctlseqs/ctlseqs.txt>

---

## 1. SwiftTerm

### 1.1 Identity, license, maintenance

- MIT licensed; 1653 stars, 437 forks, 72 open issues; last push **2026-08-12**; not archived.
  - <https://api.github.com/repos/migueldeicaza/SwiftTerm> (fields `license.spdx_id: "MIT"`, `pushed_at`, `open_issues_count`)
  - <https://github.com/migueldeicaza/SwiftTerm/blob/main/LICENSE>
- Actively maintained by the author plus a stream of outside contributors. Recent open PR titles from the issues API show ongoing renderer/perf work:
  - #619 "Cache shaped lines so unchanged rows skip CoreText typesetting"
  - #603 "Mac: repaint the rows where screen updates actually land while scrolled back"
  - #556 "Bound Buffer.resize to populated lines (don't materialize the full scrollback ring)"
  - #555 "macOS: defer buffer reflow during live-resize"
  - #614 "Metal: align the caret to the rounded glyph cell grid"
  - #627 "New io"
  - Source: <https://api.github.com/repos/migueldeicaza/SwiftTerm/issues?state=open&sort=updated>
- Production users named in README: Secure Shellfish, La Terminal, CodeEdit. <https://github.com/migueldeicaza/SwiftTerm/blob/main/README.md>

### 1.2 Architecture

- One SPM target `SwiftTerm`. Engine is UI-agnostic; platform front-ends compile conditionally. `Sources/SwiftTerm/Mac` (AppKit), `Sources/SwiftTerm/iOS` (UIKit), `Sources/SwiftTerm/Apple` (shared). Package excludes `Apple/Mac/iOS` on Linux/Windows.
  - <https://github.com/migueldeicaza/SwiftTerm/blob/main/Package.swift> (`platformExcludes`)
- Platforms declared: iOS 14, macOS 11, tvOS 13, visionOS 1 — well below Janela's macOS 15 floor, so no deployment-target conflict.
- **`swiftLanguageModes: [.v5]`** in `Package.swift`. SwiftTerm is *not* built in Swift 6 language mode. Under Swift 6.3 with strict concurrency in Janela's own package this is fine (the dependency compiles in its own mode), but SwiftTerm types you touch from Janela will largely be non-`Sendable`, and `TerminalView`/`LocalProcess` are not actor-isolated. Plan for `@MainActor` confinement at your boundary.
  - <https://github.com/migueldeicaza/SwiftTerm/blob/main/Package.swift>
- No third-party runtime dependencies for the library target (argument-parser and docc-plugin are only for the `termcast` executable and docs).

### 1.3 Renderers

Two renderers exist on Apple platforms:

- **CoreGraphics/CoreText** path — the historical renderer, credited to Marcin Krzyzanowski in the README.
- **Metal** path — `Sources/SwiftTerm/Apple/Metal/`:
  - `MetalTerminalRenderer.swift` (143,807 bytes)
  - `GlyphAtlas.swift` (12,999 bytes)
  - `CoreTextGlyphRasterizer.swift` — glyphs are rasterized with CoreText into a Metal atlas (hybrid, exactly like Ghostty/Windows Terminal)
  - `MetalBufferingMode.swift`, `MetalError.swift`, `Shaders.metal`
  - Listing: <https://api.github.com/repos/migueldeicaza/SwiftTerm/contents/Sources/SwiftTerm/Apple/Metal>
  - `Shaders.metal` is declared as a package resource via `.process("Apple/Metal/Shaders.metal")` in `Package.swift`.
- README: "Optional GPU-accelerated rendering via Metal (macOS, iOS, visionOS)". <https://github.com/migueldeicaza/SwiftTerm/blob/main/README.md>

**Why the Metal renderer exists** — issue #202 (opened 2022-01-02 by the author, closed 2026-03-15 as completed) states the original perf problem verbatim:

> "Currently we use CoreText to render glyphs which works great, but poses one problem: alternating attributes between characters can be quite costly (various test cases that change the attribute from glyph to glyph can show this performance problem). The solution is not trivial, as there is a conflict between per-cell coloring and composited glyphs."

- <https://github.com/migueldeicaza/SwiftTerm/issues/202>

This is directly relevant to Janela: agent output (Claude Code, Codex) is heavily SGR-attributed per token — exactly the pathological case #202 describes. **Use the Metal renderer, not the default CoreText path.**

Known Metal-path defects are being filed and fixed (e.g. #614 caret drift growing with column index), i.e. the renderer is new enough that you should expect to hit and report bugs. That is the maintenance risk you are buying.

### 1.4 Emulation coverage (from README, which is the maintainer's own claim, backed by test infra in-repo)

- UTF-8, grapheme clusters, emoji, combining marks.
- BiDi per the terminal-wg recommendation, with Arabic shaping, BDSM (`CSI 8 h/l`), SCP (`CSI Ps SP k`), DEC private modes 2500/2501/1243, DECRQM + XTSAVE/XTRESTORE.
- Colors: ANSI/256/TrueColor. Attributes incl. SGR 2 dim.
- Mouse events, resize, OSC 8 hyperlinks, search, selection.
- Graphics: **Sixel, iTerm2 (imgcat), Kitty graphics** — all three.
- Test suites: xterm.js and Ghostty cases imported; `esctest` (freedesktop/terminal-wg) wired via `make clone-esctest`; a fuzzer target `SwiftTermFuzz`; terminfo fixtures include `xterm-ghostty.infocmp`.
  - <https://github.com/migueldeicaza/SwiftTerm/blob/main/Package.swift> (test resources)
  - <https://github.com/migueldeicaza/SwiftTerm/blob/main/README.md>

Known open correctness gaps relevant to a coding IDE (from the open-issue list):

- #494 "Buffer reflow produces duplicate/orphan lines when narrowing terminal" — **reflow on narrowing is buggy.** This matters: Janela will resize panes constantly.
- #565 pending-wrap cursor arithmetic (CUU/CUB from the phantom column).
- #583 alternate-screen scrollback via trackpad not supported (Terminal.app/iTerm2 do).
- #12 Accessibility is still an open "Missing:" issue on macOS.
- #87 mouse selection under tmux broken (old, still open).
- <https://api.github.com/repos/migueldeicaza/SwiftTerm/issues?state=open>

### 1.5 Embedding API surface (what you actually call)

AppKit:

- `TerminalView: NSView` + `TerminalViewDelegate` — the reusable, data-source-agnostic view.
- `LocalProcessTerminalView: TerminalView, TerminalViewDelegate, LocalProcessDelegate` — the batteries-included PTY host. `startProcess(executable:args:environment:execName:currentDirectory:)`.
- `LocalProcessTerminalViewDelegate`: `sizeChanged`, `setTerminalTitle`, `hostCurrentDirectoryUpdate` (OSC 7), `processTerminated(source:exitCode:)`.
- `Sources/SwiftTerm/Mac/MacLocalTerminalView.swift` — <https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/Mac/MacLocalTerminalView.swift>

Notable, from the same file's own doc comment:

> "Generally, for the `LocalProcessTerminalView` to be useful, you will want to disable the sandbox for your application, otherwise the underlying shell will not have access to much … For this, you need to disable for your target in 'Signing and Capabilities' the sandbox entirely."

That is a first-party statement that the sandbox is incompatible with this use case.

Also note `getWindowSize()` in that file: it fills `winsize.ws_xpixel/ws_ypixel` in **backing-store pixels** (`cellDimension * cols * backingScaleFactor`). If you swap renderers behind a protocol, preserve that convention or sixel/Kitty-graphics sizing will be wrong on Retina.

### 1.6 PTY and process handling inside SwiftTerm (`Sources/SwiftTerm/LocalProcess.swift`)

This file is the single best primary reference for "how to do PTY on macOS in Swift", because it documents its own failure modes in comments. Key facts:

- Class doc: *"This implementation uses swift-subprocess with openpty/login_tty for pseudo-terminal support."* — but the live code path is `startProcessWithForkpty(...)`; the Subprocess path is compiled out with `#if false`.
- `Package.swift` states the reason explicitly:
  > "We can not use Swift Subprocess, because there is no way of configuring the child process to be a controlling terminal, as it is posix-spawn based."
  - <https://github.com/migueldeicaza/SwiftTerm/blob/main/Package.swift>
  - **This is the primary-source answer to "Foundation `Process`/`posix_spawn` vs fork+exec": posix_spawn cannot make the PTY replica the controlling terminal.** `POSIX_SPAWN_SETSID` gets you a new session but not `TIOCSCTTY`. You need `fork()` + `login_tty()` (or `forkpty()`).
- `readSize = 128*1024`. Reads via **`DispatchIO(type: .stream, fileDescriptor: childfd, queue:)`** with `setLimit(lowWater: 1)` / `setLimit(highWater: readSize)`, delivering on a dedicated `readQueue` and hopping to the delegate queue. The code comments explain why a naive DispatchSource/read loop is wrong:
  > "`done`: DispatchIO invokes this handler several times per read op (partial deliveries with done=false, then a final done=true). Re-arming on every invocation spawns an extra concurrent read chain per partial delivery — under a fast producer the chains multiply and hundreds of MB of in-flight reads pile up. One op must spawn exactly one successor."
- Backpressure: `pendingChunkFlushThreshold = 32`, `pendingTimeSliceNs = 4_000_000` (4 ms) — it batches chunks and yields every 4 ms so the main queue is not starved by a fast producer. **Copy this idea; it is exactly the "many concurrent agent sessions blasting output" scenario.**
- FD lifetime: the DispatchIO `cleanupHandler` is what calls `close(fd)`, with a comment that closing earlier causes *"BUG IN CLIENT OF LIBDISPATCH: Unexpected EV_VANISHED"* crashes.
- Child exit: `DispatchSource.makeProcessSource(identifier: shellPid, eventMask: .exit)` on macOS, with a comment that the handler must be installed **before** `activate()` because NOTE_EXIT is delivered at most once; and `shellPid` must be published before arming, otherwise `waitpid(0, ...)` targets the caller's process group and never matches the `setsid` child.
- Writes: `DispatchIO.write(toFileDescriptor: childfd, data:, runningHandlerOn: .global(qos: .userInitiated))`.
- Window size: `PseudoTerminalHelpers.setWinSize(masterPtyDescriptor:windowSize:)` (invoked from `sizeChanged`), i.e. `ioctl(fd, TIOCSWINSZ, &winsize)`.
- Default env: `Terminal.getEnvironmentVariables(termName: "xterm-256color")`.
- Source: <https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/LocalProcess.swift>

Open issue #628 (author, 2026-08-10): *"Would be nice to add a flag to control whether to call execve or execvpe"* — i.e. `PseudoTerminalHelpers.fork()` currently has a fixed exec strategy. <https://github.com/migueldeicaza/SwiftTerm/issues/628>

---

## 2. libghostty / Ghostty

### 2.1 License and governance

- MIT. `Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors`. <https://github.com/ghostty-org/ghostty/blob/main/LICENSE>
- Repo metadata: ~59k stars, MIT, Zig. <https://github.com/ghostty-org/ghostty>

### 2.2 There are TWO different C APIs. Do not conflate them

**(a) `include/ghostty.h` — the full embedding API (app + surface + renderer + PTY).**

Its own header comment:

> "Ghostty embedding API. The documentation for the embedding API is only within the Zig source files that define the implementations. This isn't meant to be a general purpose embedding API (yet) so there hasn't been documentation or example work beyond that. The only consumer of this API is the macOS app, but the API is built to be more general purpose."

- <https://github.com/ghostty-org/ghostty/blob/main/include/ghostty.h>
- Surface API is substantial and *does* include process spawning: `ghostty_surface_config_s` has `working_directory`, `command`, `env_vars`, `initial_input`, `wait_after_command`; and `ghostty_surface_foreground_pid()`, `ghostty_surface_tty_name()`, `ghostty_surface_process_exited()`.
- Rendering is driven by `ghostty_surface_draw()`, `ghostty_surface_set_size()`, `ghostty_surface_set_content_scale()`, `ghostty_surface_set_display_id()` (Apple-only), and there are `ghostty_inspector_metal_init/render/shutdown` under `#ifdef __APPLE__`.
- Official docs: *"The libghostty API is currently used primarily by the macOS app and is not yet stabilized for general-purpose embedding. The API may change significantly."* and *"The current libghostty API is **not stable**."*
  - <https://ghostty-org-ghostty.mintlify.app/api/overview>
- How the macOS app consumes it: Zig's build produces a **GhosttyKit XCFramework** (`src/build/GhosttyXCFramework.zig`), which `macos/Ghostty.xcodeproj` links; the app is built with plain `xcodebuild -project Ghostty.xcodeproj -scheme Ghostty` (see `macos/build.nu`).
  - <https://github.com/ghostty-org/ghostty/blob/main/src/build/GhosttyXCFramework.zig>
  - <https://github.com/ghostty-org/ghostty/blob/main/macos/build.nu>
- `build.zig` contains a blunt comment on this library: *"This is NOT libghostty (even though its named that for historical reasons). It is just the glue between Ghostty GUI on macOS and the full Ghostty GUI core."* — <https://github.com/ghostty-org/ghostty/blob/main/build.zig>

**Verdict: `ghostty.h` is not adoptable by Janela.** It would drag in Ghostty's entire app model (its own tabs/splits/config/keybinds), which is the opposite of a swappable terminal component in a workspace-centric IDE.

**(b) `include/ghostty/vt.h` — libghostty-vt, the embeddable VT core.** This is the interesting one.

Header warning, verbatim:

> "WARNING: This is an incomplete, work-in-progress API. It is not yet stable and is definitely going to change."
> "@warning This library is currently in development and the API is not yet stable. Breaking changes are expected in future versions. Use with caution in production code."

- <https://github.com/ghostty-org/ghostty/blob/main/include/ghostty/vt.h>

Surface area (from the header's group list and sub-headers): `terminal`, `render` (render state for custom renderers), `formatter` (plain/VT/HTML), `snapshot`, `osc`, `sgr`, `paste` safety, `unicode`, `build_info`, `allocator`, `io`, `wasm`, `focus`/`key`/`mouse` encoders, `kitty_graphics`, `modes`, `screen`, `selection`, `size_report`, `grid_ref`, `grid_ref_tracked`.

The **render-state API** is the load-bearing piece for a custom Metal renderer, and it is well designed for exactly Janela's constraints — see `include/ghostty/vt/render.h`:

- Two-phase update `ghostty_render_state_begin_update` / `ghostty_render_state_end_update`, documented so a renderer thread holds the terminal lock only for the begin phase while the IO thread continues.
- Dirty tracking at two layers: `GHOSTTY_RENDER_STATE_DIRTY_FALSE / _PARTIAL / _FULL`, plus per-row `GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY`. Renderers can skip frames entirely when not dirty.
- Row iterator + per-row cell arrays, row-local selection ranges, cursor state, 256-colour palette, fg/bg.
- <https://github.com/ghostty-org/ghostty/blob/main/include/ghostty/vt/render.h>

**What libghostty-vt gives you** (per the official Ghostling demo README, ghostty-org): resize with text reflow, 24-bit + 256 colour, styles, Unicode/grapheme handling, Kitty keyboard protocol, Kitty graphics protocol, mouse tracking (X10/normal/button/any-event) and SGR/URxvt/UTF8/X10 reporting, focus reporting, scrollback, search internals, SIMD-optimized parsing.
**What it explicitly does NOT give you**: tabs, windows, splits, session management, config, search UI, **and no windowing/renderer/PTY code at all** — the consumer provides those.

- <https://github.com/ghostty-org/ghostty-org> — canonical: <https://github.com/ghostty-org/ghostling> (README)

### 2.3 What third-party linking actually requires

- **Zig on PATH, version 0.16.x.** Ghostling's CMake fetches ghostty and links `ghostty-vt`; ghostty's own `CMakeLists.txt` is a thin wrapper: *"This file delegates to `zig build -Demit-lib-vt` to produce the shared library, headers, and pkg-config file… downstream users do still require `zig` on the PATH."*
  - <https://github.com/ghostty-org/ghostty/blob/main/CMakeLists.txt>
  - <https://github.com/ghostty-org/ghostling/blob/main/CMakeLists.txt> (`GIT_TAG f64f4aca…`, `target_link_libraries(... ghostty-vt)`, Zig 0.16.x requirement in README)
- Both `libghostty-vt.a` (static) and `libghostty-vt.0.1.0.dylib` (shared) are produced; CMake exposes `ghostty-vt` and `ghostty-vt-static`. Cross-compile via `ghostty_vt_add_target(NAME … ZIG_TARGET …)`.
- **Swift-native path exists and is first-party**: `example/swift-vt-xcframework` — `zig build -Demit-lib-vt` emits `zig-out/lib/ghostty-vt.xcframework`, consumed as:

  ```swift
  .binaryTarget(name: "GhosttyVt", path: "../../zig-out/lib/ghostty-vt.xcframework")
  ```

  and the Swift code calls `ghostty_terminal_new`, `ghostty_terminal_vt_write`, `ghostty_formatter_terminal_new`, `ghostty_formatter_format_alloc`, `ghostty_free` directly with no shim.
  - <https://github.com/ghostty-org/ghostty/blob/main/example/swift-vt-xcframework/Package.swift>
  - <https://github.com/ghostty-org/ghostty/blob/main/example/swift-vt-xcframework/Sources/main.swift>
- Consequence for Janela: adopting libghostty-vt means **checking a prebuilt `.xcframework` into the repo (or a release artifact), or adding Zig 0.16.x to the build toolchain.** With XcodeGen + SPM, a pinned prebuilt XCFramework as a `binaryTarget` is the only sane option; do not put Zig in the developer critical path.
- Community wrappers exist (`caelyreth/libghostty-vt-spm`, `SteveShi/libghostty-swift`) but are third-party and unvetted; ignore them for now.

### 2.4 Ghostty as evidence for platform decisions

- **Not sandboxed.** `macos/Ghostty.entitlements` contains only: `com.apple.security.automation.apple-events`, `device.audio-input`, `device.camera`, `personal-information.{addressbook,calendars,location,photos-library}`. There is **no** `com.apple.security.app-sandbox` key. A shipping, notarized, 59k-star macOS terminal runs unsandboxed. <https://github.com/ghostty-org/ghostty/blob/main/macos/Ghostty.entitlements>
- Ghostty sets `TERM=xterm-ghostty` and ships its own terminfo, and has had to build an entire `ghostty +ssh` wrapper and shell-integration injection to work around remote hosts lacking that entry. <https://ghostty.org/docs/help/terminfo> and <https://ghostty.org/docs/features/ssh>
  - **Lesson for Janela: do not invent `TERM=xterm-janela`.** Ship `TERM=xterm-256color` (or `xterm-ghostty` only if you actually implement its capabilities and install the terminfo). Every custom TERM is a support burden the moment the user runs `ssh` or `tmux` from inside your terminal.

---

## 3. Rolling your own VT parser + Metal/CoreText renderer

Real scope, sourced:

- **The spec.** *XTerm Control Sequences*, Thomas Dickey, "updated for XTerm Patch #410 (2026/04/19)". <https://invisible-island.net/xterm/ctlseqs/ctlseqs.txt>
  Counted from that document: roughly **78 distinct DEC private mode values** (`CSI ? Pm h/l`) and roughly **41 OSC commands**, on top of the C0/C1 controls, the full CSI final-byte table, DCS, SGR (including underline styles, 256/24-bit colour), DECRQM/XTSAVE/XTRESTORE, mouse tracking modes (1000–1007, 1015/1016), bracketed paste (2004), and the Sixel/ReGIS mode overloads (44/45/46/47 mean different things under VT340 graphics vs xterm). Several modes (13, 14, 1020–1023) are read-only and only reportable via DECRQM.
- **Correct parsing is a state machine, not regexes** — the canonical reference is Paul Williams' DEC ANSI parser state diagram, which SwiftTerm's own README cites: <https://vt100.net/emu/dec_ansi_parser>
- **Conformance testing is non-optional.** `esctest` (George Nachman → freedesktop terminal-wg → Thomas Dickey) and `vttest` are the accepted bars. <https://gitlab.freedesktop.org/terminal-wg/esctest> , <https://invisible-island.net/vttest/>
- **Reflow is the hardest single piece.** Evidence: SwiftTerm, a mature 7-year-old emulator, still has open issue #494 "Buffer reflow produces duplicate/orphan lines when narrowing terminal" and needed PR #555 "defer buffer reflow during live-resize" and PR #556 "Bound Buffer.resize to populated lines (don't materialize the full scrollback ring)". <https://api.github.com/repos/migueldeicaza/SwiftTerm/issues?state=open>
- **Renderer**: per-cell colouring vs shaped/composited glyphs is a genuine conflict, stated by SwiftTerm's author in #202. The industry answer is a CoreText-rasterized glyph atlas + instanced GPU draw — which is what Windows Terminal did (MIT atlas, microsoft/terminal#11623, referenced in #202), what Ghostty does, and what SwiftTerm now does in `Apple/Metal/`.
- **Ligatures** require real shaping (CTLine/CTRun over a run of cells) and then a mapping back onto the cell grid; the naive atlas design forecloses them.
- **Graphics protocols**: Sixel (VT330/VT340 Graphics Programming manual), iTerm2 OSC 1337, Kitty graphics protocol — three separate image pipelines with their own placement/scroll semantics.

**Estimated scope, honestly:** parser + grid + scrollback + reflow + selection + Metal atlas renderer + mouse/key encoding + esctest-passing conformance is **12–24 months of one experienced engineer** before it is as good as SwiftTerm is today, and it will never be as good as libghostty-vt because that one has millions of daily users fuzzing it. **Do not write your own VT engine.** Writing your own *renderer* on top of someone else's VT core (libghostty-vt render-state API) is a defensible, bounded project — that is a different and much smaller bet.

---

## 4. xterm.js in WKWebView — why this is wrong for Janela

Quantified objections, each traceable:

1. **You cannot spawn a PTY from WKWebView.** WKWebView content runs in separate WebKit content processes with no process-spawning API; the PTY must live in the native app anyway, so xterm.js buys you only the renderer while adding a full IPC hop. Every byte from the PTY crosses `evaluateJavaScript`/`WKScriptMessageHandler`, and every keystroke crosses back. <https://developer.apple.com/documentation/webkit/wkwebview>
2. **Per-view process cost.** Each WKWebView instantiates WebKit content + networking + GPU process participation. Janela's stated goal is *many concurrent sessions* and *low memory*; N terminal panes = N web content processes plus JS heaps, versus N `NSView`s sharing one Metal device.
3. **The fast xterm.js renderer is WebGL2, not native Metal**, and it is explicitly loss-prone: the addon exposes `onContextLoss` because "the browser may drop WebGL contexts for various reasons like OOM or after the system has been suspended". You would need recovery logic for a failure mode that does not exist in a native renderer. <https://github.com/xtermjs/xterm.js/tree/master/addons/addon-webgl>
4. **Startup time.** A WKWebView must boot a web content process, parse/JIT the xterm.js bundle, and lay out DOM before the first cell renders. `SwiftTerm.TerminalView` is an `NSView` init. For a "terminal-first, startup-time-optimized" IDE this is the single worst architectural choice available.
5. **Hardened runtime + JIT.** JS JIT in a hardened-runtime app is handled by WebKit's own entitlements inside its processes, but it means you are shipping a JIT surface inside an unsandboxed app that also spawns arbitrary user processes. Strictly worse security posture than a native renderer.
6. **Text quality/IME.** Native `NSTextInputClient` marked-text handling, Emoji picker, Services, Accessibility, and font smoothing are all yours for free in AppKit and all need re-plumbing through JS.

**Verdict: excluded. Not close.**

---

## 5. macOS PTY, spawning, and I/O — primary-source rules

### 5.1 The PTY API you should use

From `openpty(3)` in the macOS SDK man pages (`#include <util.h>`):

- `int openpty(int *aprimary, int *areplica, char *name, struct termios *termp, struct winsize *winp)` — allocates a pty pair; `termp`/`winp` set the replica's termios and window size at creation.
- `int login_tty(int fd)` — *"creating a new session, making fd the controlling terminal for the current process, setting fd to be the standard input, output, and error streams of the current process, and closing fd."*
- `pid_t forkpty(...)` — *"combines openpty(), fork(), and login_tty()"*.
- Failure modes: `EAGAIN` (no available pseudo-ttys), `ENXIO` (the `kern.tty.ptmx_max` sysctl limit reached). Cloning device is `/dev/ptmx`.
- **CAVEAT in the man page**: prefer `ptsname_r(3)` over the `name` out-param because of the 128-byte buffer footgun.
- <https://keith.github.io/xcode-man-pages/openpty.3.html>

`kern.tty.ptmx_max` is the hard ceiling on concurrent sessions. **Action for Janela: read `sysctl kern.tty.ptmx_max` at startup and surface a clear error at the limit rather than a generic spawn failure.** (Default on macOS is 511 unless raised.)

Window size is a `struct winsize { ws_row, ws_col, ws_xpixel, ws_ypixel }` set with `ioctl(primaryFd, TIOCSWINSZ, &ws)`; the kernel then delivers `SIGWINCH` to the foreground process group. See `tty(4)`: <https://keith.github.io/xcode-man-pages/tty.4.html>

### 5.2 Foundation `Process` / `posix_spawn` — do not use for PTYs

Primary evidence, from SwiftTerm's `Package.swift`:

> "We can not use Swift Subprocess, because there is no way of configuring the child process to be a controlling terminal, as it is posix-spawn based."

- <https://github.com/migueldeicaza/SwiftTerm/blob/main/Package.swift>

`posix_spawn(2)` has `POSIX_SPAWN_SETSID` (new session) but no controlling-terminal attribute — SwiftTerm's dead Subprocess path shows exactly this: it sets `POSIX_SPAWN_SETSID` via `preSpawnProcessConfigurator` and still had to be abandoned. <https://keith.github.io/xcode-man-pages/posix_spawn.2.html>

**Rule: `fork()` + `login_tty(replicaFd)` + `execve` in the child (or `forkpty`).** Between `fork` and `exec` in a multithreaded Swift process, only async-signal-safe calls are legal — no Swift allocation, no ARC-heavy code. Build the `argv`/`envp` C arrays **before** forking. SwiftTerm does this in `PseudoTerminalHelpers.fork(andExec:args:env:currentDirectory:desiredWindowSize:)` and passes pre-built `[String]` arrays down. `Foundation.Process` is still fine for `git` (§7).

### 5.3 Reading: DispatchIO, not DispatchSource

SwiftTerm uses `DispatchIO(type: .stream, ...)` with `setLimit(lowWater: 1)` / `setLimit(highWater: 128*1024)`. The in-source comments give the two rules you must obey:

1. **Re-arm exactly once per completed op.** `DispatchIO.read` invokes its handler multiple times per op (partial deliveries with `done == false`, then a final `done == true`). Re-arming on every invocation multiplies concurrent read chains and piles up hundreds of MB in flight under a fast producer.
2. **Close the FD only from the DispatchIO `cleanupHandler`**, otherwise you get `"BUG IN CLIENT OF LIBDISPATCH: Unexpected EV_VANISHED"` crashes.

- <https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/LocalProcess.swift>

Plus the backpressure design worth copying verbatim for Janela: batch reads into `pendingChunks`, flush at `pendingChunkFlushThreshold = 32` chunks, and **yield to the queue every `pendingTimeSliceNs = 4_000_000` ns (4 ms)** so a runaway `cat` in one pane cannot starve the main thread or the other 11 panes.

Child exit: `DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit)`. Two documented hazards, both in-source: install the event handler **before** `activate()` (NOTE_EXIT fires at most once and can be delivered synchronously by `activate()` if the child already exited), and publish `shellPid` **before** arming (a zero pid makes `waitpid(0, …)` target the caller's process group, which never matches a `setsid` child).

### 5.4 Login shell argv[0], TERM, TERMINFO, COLORTERM

- **argv[0] `-zsh`**: SwiftTerm exposes this correctly via the `execName:` parameter — *"this is used as the Unix argv[0] parameter, otherwise the executable is used as the args[0], this is used when the intent is to set a different process name than the file that backs it."* (`MacLocalTerminalView.swift`, `startProcess` doc comment). Pass `executable: "/bin/zsh"`, `execName: "-zsh"`.
  - Why it matters: zsh's login-shell startup sequence (`/etc/zprofile` → `$ZDOTDIR/.zprofile` → `/etc/zshrc` → `.zshrc` → `/etc/zlogin` → `.zlogin`) only runs for login shells. `zsh(1)`: *"If the shell is a login shell, commands are read from /etc/zprofile and then $ZDOTDIR/.zprofile … Finally, if the shell is a login shell, /etc/zlogin and $ZDOTDIR/.zlogin are read."* <https://keith.github.io/xcode-man-pages/zsh.1.html>
  - On macOS, `/etc/zprofile` runs `path_helper`, which is what populates `PATH` with `/usr/local/bin`, Homebrew paths, etc. **If you don't launch a login shell, agent CLIs installed via Homebrew/npm may not be on `PATH`.** This is the #1 practical reason to use `-zsh`.
- **TERM**: SwiftTerm defaults to `xterm-256color` (`Terminal.getEnvironmentVariables(termName: "xterm-256color")`). Keep it. See §2.4 for why a custom TERM is a liability.
- **TERMINFO**: only needed if you ship a custom entry. If you later do, follow Ghostty's model (ship the entry + a `+ssh` style wrapper) — <https://ghostty.org/docs/help/terminfo>
- **COLORTERM**: set `COLORTERM=truecolor` if and only if your renderer actually does 24-bit SGR. It is a de-facto convention, not in ctlseqs; the authoritative alternative is the terminfo `RGB`/`Tc` capability, which tmux documents under TERMINFO EXTENSIONS. <https://man.openbsd.org/tmux#TERMINFO_EXTENSIONS>
- Also set `TERM_PROGRAM` / `TERM_PROGRAM_VERSION` (Apple Terminal's convention) so agent CLIs can identify the host.

### 5.5 Keeping sessions alive across app restarts

Two viable mechanisms, both primary-documented:

**(a) tmux control mode** (`tmux -CC`). From `tmux(1)`:
> "tmux offers a textual interface called control mode. This allows applications to communicate with tmux using a simple text-only protocol. In control mode, a client sends tmux commands or command sequences terminated by newlines on standard input. Each command will produce one block of output on standard output. An output block consists of a %begin line followed by the output… ends with a %end or %error."

Relevant machinery you get for free:

- `refresh-client -C widthxheight` or `-C '@0:80x24'` to set per-window sizes for a control-mode client.
- `refresh-client -A %pane:on|off|continue|pause` — *"If 'off', tmux will not send output from the pane to the client and if all clients have turned the pane off, will stop reading from the pane."* **This is exactly the backpressure primitive you want for 20 background agent panes.**
- `refresh-client -B name:what:format` — format subscriptions, reported via `%subscription-changed` at most once a second.
- Client flags `no-output`, `pause-after=seconds`, `wait-exit`.
- Exit reason strings you must handle: `too far behind` (*"The client is in control mode and became unable to keep up with the data from tmux"*), `lost tty`, `server exited unexpectedly`.
- `%client-detached`, `%client-session-changed`, `%config-error` notifications.
- <https://man.openbsd.org/tmux#CONTROL_MODE>
- Costs: hard dependency on the user's tmux, an extra emulation layer, and `client_control_mode`-shaped bugs. SwiftTerm has an open issue (#87, "Mouse selection under tmux is broken") showing this integration is not free.

**(b) Your own detached session daemon.** Spawn the PTY from a small `janelad` helper that `setsid`s away from the app, keep the primary FD in the helper, and reconnect over a Unix domain socket with `SCM_RIGHTS` FD passing. This preserves your own VT engine and scrollback semantics and avoids tmux entirely. More code, but no third-party dependency and full control of backpressure and scrollback persistence.

**Recommendation: (b), but not in v1.** Ship v1 with in-process PTYs; design `LocalProcess` behind a protocol so the FD source can later become "an FD received over a socket from janelad" without touching the terminal view. Offer tmux control mode as an *optional* power-user backend later, never as the default.

### 5.6 App Sandbox

- Apple's own entitlement reference: `com.apple.security.inherit` — *"If your app employs a child process created with either the posix_spawn function or the NSTask class, you can configure the child process to inherit the sandbox of its parent."* The child must be signed with **exactly** the inherit entitlement and nothing else. <https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html>
- Apple DTS, on the general case: *"As far as public API is concerned, you can only sandbox apps (and app-like things, like app extensions, system extensions, and XPC Services)."* <https://developer.apple.com/forums/thread/123873>
- Signing a child with non-inheritable entitlements produces a crash in `_libsecinit_appsandbox`. <https://developer.apple.com/forums/thread/706390>
- Practical consequence: a sandboxed Janela would confine `/bin/zsh` — and therefore `git`, `node`, `claude`, `codex` — to the app container. Users' repos would be unreadable without per-path security-scoped bookmarks that a shell cannot use anyway. SwiftTerm's own docs say to turn the sandbox off; Ghostty ships unsandboxed.
- **This also permanently excludes the Mac App Store.** Distribute via Developer ID + notarization.

---

## 6. Recommendation, ranked

### Ranked by **time-to-first-usable**

1. **SwiftTerm with the Metal renderer enabled** — days. `LocalProcessTerminalView` + `startProcess(executable:"/bin/zsh", execName:"-zsh", currentDirectory: worktreePath)` is a working agent pane in an afternoon. Everything else is 10–100× slower.
2. libghostty-vt XCFramework + your own Metal renderer — 2–4 months to parity-ish (you write the entire renderer, input encoding wiring, selection UI, and scrollback UI).
3. Full libghostty (`ghostty.h`) — not viable; you would fork Ghostty's app model.
4. Own VT engine — 12–24 months.
5. xterm.js/WKWebView — fast to prototype, permanently wrong. Excluded.

### Ranked by **performance ceiling**

1. **libghostty-vt + custom Metal renderer** — SIMD parsing, dirty-tracked two-phase render state designed for a renderer thread that never blocks the IO thread, proven at Ghostty's scale. Highest ceiling by a wide margin. <https://github.com/ghostty-org/ghostty/blob/main/include/ghostty/vt/render.h>
2. **SwiftTerm Metal renderer** — CoreText-rasterized glyph atlas, same architecture class; parser is Swift, not SIMD C/Zig, and the buffer/reflow code has known scaling issues (#556 materializing the full scrollback ring on resize). Good enough for terminal-sized workloads; will show up first under `cat`-a-huge-file and under narrow-resize.
3. Own engine — theoretical ceiling equal to (1), realized ceiling far below.
4. WKWebView — bounded by IPC and JS, and by per-view process memory.

### Ranked by **maintenance risk** (lowest risk first)

1. **SwiftTerm** — MIT, pure Swift, no build-toolchain additions, one SPM dependency, source you can read and patch in-repo. If upstream stalls, you fork it and keep shipping. Risk is *correctness bugs you must fix yourself* (reflow #494, accessibility #12).
2. **libghostty-vt** — MIT, but: API self-declared unstable with "breaking changes are expected", requires either a vendored prebuilt XCFramework (which you must re-cut on every upgrade, from a Zig 0.16.x toolchain) or Zig in CI, and debugging crosses a Swift→C→Zig boundary with no Swift-level symbolication.
3. Own engine — you own 100% of the bugs forever.
4. `ghostty.h` full embedding API — highest risk: undocumented, single-consumer, explicitly "not meant to be a general purpose embedding API (yet)".

### The call

**Ship v1 on SwiftTerm, Metal renderer, behind your `TerminalEngine` protocol. Prototype libghostty-vt in parallel behind the same protocol, and treat it as the v2 performance path.**

Concretely:

- The swappable-protocol decision in the chosen stack is **correct and is the single highest-value architectural decision here**, precisely because libghostty-vt's render-state API is a natural second implementation. Design the protocol around: `write(bytes:)` in, a **dirty-row-based** pull model out (`dirtyState -> rows -> cells`), plus cursor/colors/selection queries. Do **not** design it around SwiftTerm's `NSView`. If your protocol is "give me an NSView", you cannot swap to libghostty-vt without rewriting everything. Model the protocol on `ghostty/vt/render.h` (`DIRTY_FALSE/PARTIAL/FULL`, per-row dirty, row iterator, row-local selection) — SwiftTerm can be adapted to that shape, but not vice versa.

---

## 7. Implications for Janela — concrete, opinionated

**Terminal engine**

1. Use SwiftTerm at a pinned commit (not a version range) — it is under active renderer churn; `pushed_at` 2026-08-12 and a Metal backend landed 2026-03-15. Pin, vendor the diff review, upgrade deliberately.
2. **Enable the Metal renderer explicitly.** The CoreText path hits the exact per-glyph-attribute cost the author describes in #202, and agent output is maximally SGR-attributed. Benchmark both with real Claude Code output before committing.
3. Define `TerminalEngine`/`TerminalSurface` protocols modeled on libghostty-vt's render-state shape (see above), not on `NSView`.
4. Budget for SwiftTerm bug-fixing as a line item: reflow on narrowing (#494), pending-wrap cursor (#565), alt-screen scroll (#583), accessibility (#12). Plan to upstream fixes — the maintainer merges outside PRs readily.
5. Do **not** write your own VT parser. ~78 DEC private modes + ~41 OSC commands at xterm patch #410 is the floor, and reflow/graphics are above that. <https://invisible-island.net/xterm/ctlseqs/ctlseqs.txt>
6. Do **not** use `ghostty.h`. Do evaluate `ghostty-vt.xcframework` — build it once with Zig 0.16.x, commit the artifact, prototype a Metal renderer against `render.h` on a spike branch.

**PTY / process**
7. `fork()` + `login_tty()` + `execve`, never `posix_spawn`/`Foundation.Process` for the shell — posix_spawn cannot establish a controlling terminal (SwiftTerm `Package.swift`).
8. `Foundation.Process` remains correct for `/usr/bin/git` (no PTY needed, `Pipe` is fine) — **the chosen stack's "shell out to /usr/bin/git" is fine and is not contradicted.** Use `Process` + `Pipe` there and reserve the fork/login_tty machinery for terminals only.
9. `argv[0] = "-zsh"` for the login shell, so `/etc/zprofile`/`path_helper` runs and Homebrew/npm-installed agent CLIs are on `PATH`.
10. `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=Janela`, `TERM_PROGRAM_VERSION=...`. No custom terminfo entry in v1.
11. Set `winsize` at `openpty` time via `winp` (avoids a spurious SIGWINCH before the shell starts), then `TIOCSWINSZ` on every resize. Fill `ws_xpixel`/`ws_ypixel` in **backing pixels** (SwiftTerm's convention) so sixel/Kitty images size correctly on Retina.
12. Read with `DispatchIO` (`lowWater: 1`, `highWater: 128 KiB`), re-arm exactly once per `done == true`, close the FD only from the `cleanupHandler`. Implement the 4 ms time-slice + 32-chunk batching backpressure pattern per session — this is what makes "many concurrent sessions" not stutter.
13. `DispatchSource.makeProcessSource(.exit)` for child reaping; set the handler before `activate()`; publish the pid before arming.
14. Read `sysctl kern.tty.ptmx_max` at startup; it is the real ceiling on concurrent sessions and `openpty` returns `ENXIO` when hit. Surface a specific error.

**Persistence / lifecycle**
15. v1: in-process PTYs, persist scrollback + cwd + session metadata to SQLite so a restart restores *content* even though the process dies.
16. v2: a `janelad` detached helper holding PTY primaries, reconnecting via Unix socket + `SCM_RIGHTS`. Design the FD-source abstraction now.
17. tmux control mode: optional backend only, never default. If you build it, use `refresh-client -A %pane:off/pause` for backgrounded panes and handle the `too far behind` detach reason. <https://man.openbsd.org/tmux#CONTROL_MODE>

**Packaging / signing**
18. Unsandboxed + hardened runtime + Developer ID + notarization. Validated by Ghostty's own entitlements file (no `com.apple.security.app-sandbox`) and by SwiftTerm's own documentation telling embedders to disable the sandbox. Accept that the Mac App Store is off the table.
19. Do not attempt `com.apple.security.inherit`: a sandboxed shell cannot read the user's repos, and the entitlement rules are brittle (`_libsecinit_appsandbox` crashes).

---

## 8. Contradictions with the already-chosen stack

| Chosen | Verdict | Evidence |
| --- | --- | --- |
| SwiftTerm for VT emulation | **Confirmed**, with a correction: it is no longer CoreText-only — enable the Metal renderer, or you inherit the exact perf problem (#202) you'd be trying to avoid | <https://github.com/migueldeicaza/SwiftTerm/commit/3c45fdcfcf4395c72d2a4ee23c0bce79017b5391> |
| Swappable protocol behind SwiftTerm | **Confirmed and elevated** — but the protocol must be dirty-row/render-state shaped, not `NSView` shaped, or the swap to libghostty-vt is impossible | <https://github.com/ghostty-org/ghostty/blob/main/include/ghostty/vt/render.h> |
| Unsandboxed + hardened runtime | **Confirmed** by Ghostty's shipping entitlements and SwiftTerm's own docs | <https://github.com/ghostty-org/ghostty/blob/main/macos/Ghostty.entitlements> |
| Shelling out to `/usr/bin/git` | **Confirmed** — `Foundation.Process` + `Pipe` is correct there; no PTY needed | n/a |
| SwiftUI + AppKit where needed | **Confirmed** — SwiftTerm's terminal surface is an `NSView`; wrap in `NSViewRepresentable`. Note SwiftTerm is Swift 5 language mode, so its types are not `Sendable`; confine to `@MainActor` | <https://github.com/migueldeicaza/SwiftTerm/blob/main/Package.swift> |
| **Implicit assumption: `Foundation.Process` / `posix_spawn` can host the shell** | **CONTRADICTED** — posix_spawn cannot set a controlling terminal; you must fork + `login_tty`. If any design doc says "use Process/Subprocess for terminal sessions", fix it now | <https://github.com/migueldeicaza/SwiftTerm/blob/main/Package.swift> |
| **Implicit assumption: libghostty is not yet usable from Swift** | **CONTRADICTED** — libghostty-vt ships an official Swift XCFramework example today; it is a real v2 option, gated only on API instability and a Zig 0.16.x build step | <https://github.com/ghostty-org/ghostty/tree/main/example/swift-vt-xcframework> |
| GRDB/SQLite for metadata | Not evaluated in this brief (out of scope) | — |
| XcodeGen + SPM package | Compatible with both paths. **Caveat:** if you adopt libghostty-vt, an SPM `binaryTarget` XCFramework must be a committed/pinned artifact — do not put `zig build` in the developer or CI critical path | <https://github.com/ghostty-org/ghostty/blob/main/CMakeLists.txt> |

---

## 9. Gaps / not established from primary sources

- **No first-party benchmark numbers** comparing SwiftTerm's Metal renderer to Ghostty's. Neither repo publishes head-to-head throughput figures. SwiftTerm has a `Benchmarks/SwiftTermBenchmarks` target (ordo-one/package-benchmark) but it is `disableBenchmark = true` in `Package.swift`, so no published results. **Next step: enable it locally and measure `feed(byteArray:)` throughput plus frame time under agent-shaped output.**
- **libghostty-vt has no PTY layer**, so the Ghostty comparison is engine-only; you write PTY + spawn regardless of which engine you pick. Confirmed by the Ghostling README's "What You Won't Ever Get" list, but not stated in a `vt.h` header directly.
- **`kern.tty.ptmx_max` default value on macOS 15/26** is not documented in the man page (only that the limit exists). Verify empirically on target hardware.
- **Swift 6.3 strict-concurrency interop with SwiftTerm** is inferred from `swiftLanguageModes: [.v5]`, not tested. Build a spike before committing.
- **Ghostty's exact Zig version pin** — docs point to <https://ghostty.org/docs/install/build> rather than stating a version in the repo files fetched; Ghostling's README says Zig 0.16.x. Confirm at adoption time.
- **`PseudoTerminalHelpers.swift`** could not be fetched at its guessed path (404); its exact `fork(andExec:...)` implementation was read only through call sites and issue #628. Read it in the vendored checkout before copying the pattern.

---

## Sources

**Kept — primary**

- SwiftTerm repo (README, Package.swift, LICENSE, LocalProcess.swift, Mac/MacLocalTerminalView.swift, Apple/Metal/*) — <https://github.com/migueldeicaza/SwiftTerm>
- SwiftTerm GitHub API metadata + open issues — <https://api.github.com/repos/migueldeicaza/SwiftTerm>
- SwiftTerm issue #202 (Metal renderer rationale), #628, commit 3c45fdc
- Ghostty `include/ghostty.h`, `include/ghostty/vt.h`, `include/ghostty/vt/render.h`, `CMakeLists.txt`, `build.zig`, `macos/Ghostty.entitlements`, `macos/build.nu`, `example/swift-vt-xcframework/*` — <https://github.com/ghostty-org/ghostty>
- Ghostling (official libghostty demo) README + CMakeLists — <https://github.com/ghostty-org/ghostling>
- libghostty C API docs (official) — <https://ghostty-org-ghostty.mintlify.app/api/overview>
- Ghostty docs: terminfo, ssh, shell-integration — <https://ghostty.org/docs/help/terminfo>
- XTerm Control Sequences, patch #410 — <https://invisible-island.net/xterm/ctlseqs/ctlseqs.txt>
- macOS SDK man pages: `openpty(3)`, `tty(4)`, `posix_spawn(2)`, `zsh(1)` — <https://keith.github.io/xcode-man-pages/>
- `tmux(1)` CONTROL MODE + TERMINFO EXTENSIONS — <https://man.openbsd.org/tmux>
- Apple: Enabling App Sandbox / `com.apple.security.inherit` — <https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html>
- Apple DTS forum threads 123873 / 706390 (sandbox inheritance)
- xterm.js `addon-webgl` README + typings — <https://github.com/xtermjs/xterm.js/tree/master/addons/addon-webgl>

**Dropped**

- mitchellh.com "libghostty is coming" — maintainer blog, roadmap only; superseded by the official API docs and the shipped headers.
- Community Swift wrappers `caelyreth/libghostty-vt-spm`, `SteveShi/libghostty-swift` — third-party, unvetted, not needed given the first-party XCFramework example.
- npm/`@xterm/addon-webgl` package page — mirror of the repo README.
- xfree86.org / x.org ctlseqs mirrors — stale copies of the invisible-island original.
