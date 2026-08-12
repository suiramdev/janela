# Terminal Emulation and PTY on macOS for a Native Swift App (Janela)

Scope: primary-source evaluation of the realistic terminal stacks for a native macOS/Swift agentic IDE that hosts many concurrent CLI-agent sessions. Every non-obvious claim below cites the repository file, man page, or spec that owns it. Source trees were read at HEAD of `main` for both `migueldeicaza/SwiftTerm` and `ghostty-org/ghostty` (cloned during this research); line numbers refer to those checkouts.

---

## 0. Bottom line

| Option | Time-to-first-usable | Performance ceiling | Maintenance risk |
| --- | --- | --- | --- |
| **SwiftTerm (SPM, AppKit `TerminalView` + `LocalProcessTerminalView`)** | Days | Medium-high (CoreGraphics default; opt-in Metal renderer shipping in-tree) | Medium — single-maintainer project, Swift 5 language mode, known parser/exclusivity hot spots tracked in-tree |
| **libghostty-vt (C API / xcframework) + own Metal renderer + own PTY layer** | Weeks–months | Highest | Medium-high — API is explicitly unstable, but the engine underneath is battle-tested and MIT |
| **libghostty-internal (`include/ghostty.h`, full surface + renderer)** | Not viable for third parties today | Highest | Highest — header says explicitly it is not for external use |
| **Own VT parser + Metal renderer from scratch** | Months–years to reach parity | Highest | Highest — you own xterm/DEC compatibility forever |
| **xterm.js in `WKWebView`** | Days | Low for a native app | High — WebKit-version-dependent renderer bugs, no native PTY path |

Recommendation for Janela: **ship on SwiftTerm now, architect so the emulator core is replaceable, and prototype libghostty-vt + a Janela-owned Metal renderer in parallel.** Details in §9–§10.

---

## 1. SwiftTerm

Repo: <https://github.com/migueldeicaza/SwiftTerm>

### 1.1 License

MIT, with the xterm.js lineage retained in the header:

> Copyright (c) 2019-2026 Miguel de Icaza … Copyright (c) 2017-2019, The xterm.js authors … Copyright (c) 2014-2016, SourceLair … Copyright (c) 2012-2013, Christopher Jeffrey
> — [`LICENSE:1-4`](https://github.com/migueldeicaza/SwiftTerm/blob/main/LICENSE)

No copyleft obligations; attribution only.

### 1.2 Architecture

Three layers, split by directory:

- **UI-agnostic engine** — `Sources/SwiftTerm/*.swift`: `Terminal.swift` (8,069 lines: mode handling, DECRQSS, CSI/OSC/DCS command implementations), `EscapeSequenceParser.swift`, `Buffer.swift`/`BufferLine.swift`/`CircularList.swift` (scrollback), `SixelDcsHandler.swift`, `KittyGraphics.swift`, `KittyKeyboardEncoder.swift`, `SearchEngine.swift`, `SemanticPrompt.swift`.
- **Apple-shared front-end** — `Sources/SwiftTerm/Apple/`: `AppleTerminalView.swift` (CoreText/CoreGraphics draw path), `TerminalBidi.swift`, `BoxDrawingRenderer.swift`, `PowerlineRenderer.swift`, plus `Apple/Metal/` (see §1.3).
- **Platform front-ends** — `Sources/SwiftTerm/Mac/` (AppKit `TerminalView`, `MacLocalTerminalView`, `MacFindBarView`, `MacAccessibilityService`) and `Sources/SwiftTerm/iOS/`.

The engine is explicitly designed to be reused headlessly (`HeadlessTerminal.swift`, `Sources/Termcast/`), which matters if you later want to run an emulator with no view attached (background/agent sessions).

Feature list, verbatim from the README: BiDi per the terminal-wg recommendation with Arabic shaping; ANSI/256/TrueColor; mouse; hyperlinks (OSC 8); Sixel, iTerm2 and Kitty graphics; "Thread-safe Terminal instances"; "Optional GPU-accelerated rendering via Metal (macOS, iOS, visionOS)" — [`README.md:54-79`](https://github.com/migueldeicaza/SwiftTerm/blob/main/README.md).

Conformance testing is against `esctest` (the freedesktop/terminal-wg suite) and test cases lifted from xterm.js and Ghostty — [`README.md:48-49`, `README.md:222-233`](https://github.com/migueldeicaza/SwiftTerm/blob/main/README.md).

### 1.3 Renderer: CoreText by default, Metal opt-in

This is the single biggest change versus SwiftTerm's historical reputation as "CoreText only".

- Default path: CoreGraphics/CoreText attributed-string drawing in `Sources/SwiftTerm/Apple/AppleTerminalView.swift`.
- Metal path: `Sources/SwiftTerm/Apple/Metal/{MetalTerminalRenderer,GlyphAtlas,CoreTextGlyphRasterizer,MetalBufferingMode,MetalError}.swift` + `Shaders.metal`, shipped as an SPM resource (`.process("Apple/Metal/Shaders.metal")` — [`Package.swift:109-111`](https://github.com/migueldeicaza/SwiftTerm/blob/main/Package.swift)).

Documented behavior — [`Sources/SwiftTerm/Documentation.docc/GPURendering.md`](https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/Documentation.docc/GPURendering.md):

- "It is **disabled by default**; you opt in by calling `TerminalView/setUseMetal(_:)`" (line 14-15), which `throws` a `MetalError` and falls back to CoreGraphics.
- Architecture: "a **cell-buffer model** inspired by Ghostty: backgrounds, text glyphs, and decorations are emitted as per-cell structs on the CPU and expanded to quads in the GPU. A **glyph atlas** backed by CoreText rasterization caches rendered glyphs across frames… Two atlas textures are maintained — one grayscale for regular text and one BGRA for color glyphs (emoji)." (lines 99-105).
- Two buffering modes: `perRowPersistent` (default; only dirty rows rebuilt) and `perFrameAggregated` (for full-screen TUIs) — lines 52-55.
- Metal supports the full feature matrix including Sixel/iTerm2/Kitty inline images and curly/dotted/dashed underlines — lines 85-95.
- Metal redraws are throttled during live resize; tunable via `SWIFTTERM_METAL_LIVE_RESIZE_THROTTLE` — line 69.

Caveat: the sample app still defaults to CoreGraphics and you must flip `setUseMetal(false)` → `true` to measure Metal, per [`PERFORMANCE.md:119-124`](https://github.com/migueldeicaza/SwiftTerm/blob/main/PERFORMANCE.md). Treat the Metal path as "shipping but younger than the CG path" and validate it against Janela's own workloads.

### 1.4 Performance characteristics and known issues

SwiftTerm has an in-repo performance methodology document with three tiers — headless feed benchmarks, `Tools/RenderBench` (real `TerminalView`, synthetic frames, fixed seed, `--metal` flag), and in-app vtebench — plus `os_signpost` instrumentation under subsystem `org.tirania.SwiftTerm` — [`PERFORMANCE.md:1-99`](https://github.com/migueldeicaza/SwiftTerm/blob/main/PERFORMANCE.md). The existence of this file is itself a signal: perf is actively measured, not assumed.

Open/known perf items in the tracker (all first-party, authored by the maintainer):

- **Swift exclusivity checking and ARC dominate the hot path.** "Currently about 12% of our performance when outputting characters is being consumed by `swift_beginAccess` when the `insertCharacter` accesses the `buffer` properties… Purely for the `insertCharacter` call, this accounts for 43.2% and retain/release for another 12%" — [issue #373](https://github.com/migueldeicaza/SwiftTerm/issues/373). (Note the commented-out `-enforce-exclusivity=none` unsafe flag left in [`Package.swift:55-57`](https://github.com/migueldeicaza/SwiftTerm/blob/main/Package.swift) — it can't be used because SPM forbids `unsafeFlags` in consumed packages.)
- **Buffer layout is an array-of-lines, not a flat blob.** Proposed fix: "having the data itself in the Buffer, not as an array of lines, but as a blob of data of `L x C`" — [issue #379](https://github.com/migueldeicaza/SwiftTerm/issues/379), still open.
- **Parsing and rendering are not decoupled across threads.** "The UI views could run async from the actual engine… there are situations where we can still be processing too much data in `parse` without triggering an update to the UI" — [issue #137](https://github.com/migueldeicaza/SwiftTerm/issues/137).
- **Line layout caching is a recent addition** (`LineLayoutCache` caching `CTLine` objects per buffer row, with a `RenderingStrategy` toggle) — [PR #449](https://github.com/migueldeicaza/SwiftTerm/pull/449).
- **Live-resize reflow is a known stutter source**: "AppKit calls `setFrameSize` ~60 times/second during the live-resize gesture… each such step chains a full buffer reflow" — [PR #555](https://github.com/migueldeicaza/SwiftTerm/pull/555).

Implication for a many-session IDE: SwiftTerm's cost model is per-`Terminal`-instance CPU during heavy output, and its default delivery queue is the **main queue** (§1.6). With 10–30 concurrent agent sessions streaming output, the main thread is the contention point, not the GPU.

### 1.5 Swift concurrency posture

`swiftLanguageModes: [.v5]` — [`Package.swift:159`](https://github.com/migueldeicaza/SwiftTerm/blob/main/Package.swift). Platforms: iOS 14 / macOS 11 / tvOS 13 / visionOS 1 (lines 146-151). Under Swift 6.3 with strict concurrency in Janela's own modules, SwiftTerm types will arrive as non-`Sendable` and you will need `@MainActor` isolation or explicit `nonisolated(unsafe)` bridging at the boundary. Budget for it.

### 1.6 Embedding API surface (AppKit)

- `TerminalView: NSView` + `TerminalViewDelegate` — the generic embeddable view; you supply the data source (README lines 111-119).
- `LocalProcessTerminalView: TerminalView, TerminalViewDelegate, LocalProcessDelegate` — the batteries-included PTY-backed view. Key entry point:
  `public func startProcess(executable: String = "/bin/bash", args: [String] = [], environment: [String]? = nil, execName: String? = nil, currentDirectory: String? = nil)` — [`Sources/SwiftTerm/Mac/MacLocalTerminalView.swift:182`](https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/Mac/MacLocalTerminalView.swift). `execName` is exactly the `argv[0]` override you need for login shells (§6).
- `LocalProcess` — usable standalone, decoupled from any view: `init(delegate:dispatchQueue:)`, `startProcess(...)`, `send(data:)`, `terminate()`, `childfd`, `shellPid` — [`Sources/SwiftTerm/LocalProcess.swift:63-130, 215, 383, 561`](https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/LocalProcess.swift). Note the docstring: "Received data is dispatched via the queue that you provide… if none is provided, this will default to `DispatchQueue.main`" (lines 49-52).
- **SwiftUI**: there is a `Sources/SwiftTerm/iOS/SwiftUITerminalView.swift` but **no macOS SwiftUI wrapper** in the tree. On macOS you write your own `NSViewRepresentable`. Ghostty does the same thing for its own app (`SurfaceView_AppKit.swift` + a SwiftUI `SurfaceWrapper`), so this is the normal shape.
- `linkReporting` (`.none` / `.explicit` / `.implicit`) and `TerminalViewDelegate.requestOpenLink(source:link:params:)` give you OSC 8 + implicit URL detection with app-controlled activation — README lines 136-151. Directly useful for click-to-open file paths from agent output.
- OSC 7 (`hostCurrentDirectoryUpdated`) and OSC 133 semantic prompts (`SemanticPrompt.swift`, `semanticPromptClickBehavior`) are already modeled in `Terminal` — [`Terminal.swift:146-154, 378-386`](https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/Terminal.swift). This is how you get "which repo/dir is this session in" without polling.

### 1.7 Maintenance status

Actively developed: the tree contains recent-generation work (Metal renderer, BiDi per terminal-wg, Kitty keyboard protocol, `Tools/RenderBench`, `Tools/BidiHarness`, an SPM build-info plugin, a fuzz target, `AGENTS`-era tooling). Risk is concentration: it is effectively one maintainer plus contributors. Mitigation is that it's MIT and vendorable.

---

## 2. Ghostty / libghostty

Repo: <https://github.com/ghostty-org/ghostty>. License: **MIT**, "Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors" — [`LICENSE:1-3`](https://github.com/ghostty-org/ghostty/blob/main/LICENSE).

There are **two different C APIs** in this repo and conflating them is the main source of bad advice.

### 2.1 `include/ghostty.h` — "libghostty-internal". Do not build on it

Verbatim header comment:

> Ghostty's internal embedder API, a.k.a. "libghostty-internal".
> The only consumer of this API is the macOS app, and while it is fairly comprehensive, it is tailored to the needs of the macOS app and not designed for external use, hence why most functions are undocumented and some are macOS-specific (e.g. ones dealing with the Metal graphics API).
> External embedders should instead use `libghostty-vt` or other related packages…
> — [`include/ghostty.h:1-13`](https://github.com/ghostty-org/ghostty/blob/main/include/ghostty.h)

What it contains, and why it is attractive but off-limits: it is the *whole terminal*, PTY included. `ghostty_surface_config_s` carries `working_directory`, `command`, `env_vars`/`env_var_count`, `initial_input`, `wait_after_command`, plus `ghostty_platform_macos_s { void* nsview; }` — you hand it an `NSView` and Ghostty owns rendering and the child process. The surface lifecycle is `ghostty_app_new` / `ghostty_surface_config_new` / `ghostty_surface_new` / `ghostty_surface_draw` / `ghostty_surface_set_size` / `ghostty_surface_set_content_scale` / `ghostty_surface_set_focus` / `ghostty_surface_process_exited` / `ghostty_surface_free` (all in `include/ghostty.h`). The macOS app drives it from Swift via `ghostty_runtime_config_s` with C function-pointer callbacks (`wakeup_cb`, `action_cb`, …) and `Unmanaged.passUnretained(self).toOpaque()` userdata — [`macos/Sources/Ghostty/Ghostty.App.swift`](https://github.com/ghostty-org/ghostty/blob/main/macos/Sources/Ghostty/Ghostty.App.swift).

Consuming it means building `GhosttyKit.xcframework` from the Zig build (`src/build/GhosttyXCFramework.zig`, `src/build/GhosttyXcodebuild.zig`) and accepting an undocumented, deliberately app-shaped ABI. Also note the practical cost: Ghostty main-branch builds require **Xcode 26 + macOS 26 SDK + iOS SDK + Metal Toolchain**, and a matching Zig — [`HACKING.md:50-68`](https://github.com/ghostty-org/ghostty/blob/main/HACKING.md). (Janela's toolchain matches, so that part is not a blocker; the API stability is.)

Verdict: **not a supported path for a third-party app.** Any Janela design that assumes "just embed Ghostty's surface" is building on an interface whose owner says it is not for you.

### 2.2 `include/ghostty/vt.h` — libghostty-vt. The real embeddable API

README framing:

> **`libghostty`** is a cross-platform, zero-dependency C and Zig library for building terminal emulators or utilizing terminal functionality… Anyone can use `libghostty` to build a terminal emulator or embed a terminal into their own applications.
> — [`README.md`](https://github.com/ghostty-org/ghostty/blob/main/README.md)

Stability, verbatim:

> WARNING: This is an incomplete, work-in-progress API. It is not yet stable and is definitely going to change.
> @warning This library is currently in development and the API is not yet stable. Breaking changes are expected in future versions. Use with caution in production code.
> — [`include/ghostty/vt.h:10-11, 25-26`](https://github.com/ghostty-org/ghostty/blob/main/include/ghostty/vt.h)

And from the Zig module header: "The *functionality* is extremely stable, since it is extracted directly from Ghostty… However, the API itself (functions, types, etc.) may change without warning." — [`src/lib_vt.zig`](https://github.com/ghostty-org/ghostty/blob/main/src/lib_vt.zig).

Documented API groups — [`include/ghostty/vt.h:30-47`](https://github.com/ghostty-org/ghostty/blob/main/include/ghostty/vt.h):

- **Terminal** — full terminal state, scrollback, line wrapping, **reflow on resize** (lines 20-23).
- **Render State** — "Incremental render state updates for custom renderers".
- **Formatter** — plain text / VT / HTML output.
- **Snapshot** — "Encode and incrementally restore terminal state". *(Directly relevant to Janela's session-persistence problem — §7.)*
- OSC parser, SGR parser, paste-safety validation, Unicode codepoint properties for layout, build info, allocator hooks, byte-stream I/O callbacks, WASM helpers.
- Encoders: **key encoding** (Kitty keyboard protocol), **mouse encoding** (SGR), focus in/out encoding.

Concretely, the render-state contract you would code against (from [`example/c-vt-render/src/main.c`](https://github.com/ghostty-org/ghostty/blob/main/example/c-vt-render/src/main.c)):

```c
ghostty_terminal_new(NULL, &terminal, 40, 5);
ghostty_render_state_new(NULL, &render_state);
ghostty_terminal_vt_write(terminal, bytes, len);
ghostty_render_state_update(render_state, terminal);
ghostty_render_state_get(render_state, GHOSTTY_RENDER_STATE_DATA_DIRTY, &dirty);
// GHOSTTY_RENDER_STATE_DIRTY_{FALSE,PARTIAL,FULL}
ghostty_render_state_colors_get(render_state, &colors);   // bg, fg, 256-entry palette
ghostty_render_state_get(render_state, GHOSTTY_RENDER_STATE_DATA_CURSOR_VISIBLE, &v);
```

Plus `GhosttyGridRef` for stable cell references that survive scrolling (`c-vt-grid-ref-tracked`), selection via `ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_SELECTION, &sel)`, and idle scrollback compression (`c-vt-compression`).

**What libghostty-vt does NOT give you:** no PTY, no process spawn, no font/shaping, no renderer, no view. Those are yours. The build-info flags it exposes are `SIMD`, `KITTY_GRAPHICS`, `TMUX_CONTROL_MODE` — [`example/c-vt-build-info/src/main.c:6-12`](https://github.com/ghostty-org/ghostty/blob/main/example/c-vt-build-info/src/main.c). (Note: a tmux control-mode parser is compiled into libghostty-vt. Relevant to §7.)

### 2.3 Consuming libghostty-vt from Swift — what it actually requires

Officially supported today, in-tree, CI-verified:

1. **Prebuilt XCFramework.** `zig build -Demit-lib-vt` produces `zig-out/lib/ghostty-vt.xcframework`; the in-repo Swift example consumes it as a plain SPM `binaryTarget`:

   ```swift
   .executableTarget(name: "swift-vt-xcframework", dependencies: ["GhosttyVt"], path: "Sources"),
   .binaryTarget(name: "GhosttyVt", path: "../../zig-out/lib/ghostty-vt.xcframework"),
   ```

   — [`example/swift-vt-xcframework/Package.swift`](https://github.com/ghostty-org/ghostty/blob/main/example/swift-vt-xcframework/Package.swift), [`README.md`](https://github.com/ghostty-org/ghostty/tree/main/example/swift-vt-xcframework). Swift then calls `ghostty_terminal_new`, `ghostty_terminal_vt_write`, `ghostty_formatter_*`, `ghostty_free` directly with no shim — [`example/swift-vt-xcframework/Sources/main.swift`](https://github.com/ghostty-org/ghostty/blob/main/example/swift-vt-xcframework/Sources/main.swift).
2. The xcframework is **universal macOS (x86_64+arm64) + iOS + iOS Simulator**, released on Ghostty's tip channel (GitHub releases and blob storage) — [commit c12a0e3, "libghostty: build universal xcframework and release it on tip (#12149)"](https://github.com/ghostty-org/ghostty/commit/c12a0e395d75c19b0a2c841f021885f535e68cbc).
3. CI enforces the Apple packaging contract: install name is exactly `@rpath/libghostty-vt.dylib`, exactly one `LC_BUILD_VERSION`, and **only `_ghostty_`-prefixed exported symbols** — [`.github/scripts/check-apple-libghostty-vt.nu:33, 46, 126`](https://github.com/ghostty-org/ghostty/blob/main/.github/scripts/check-apple-libghostty-vt.nu). No symbol pollution into Janela's binary.
4. Static linking is available (`libghostty-vt.a`, define `GHOSTTY_STATIC`); on macOS the static archive is "a fat archive that bundles the vendored SIMD dependencies (highway, simdutf). Consumers only need to link libc." `-Dsimd=false` removes all runtime deps — [`CMakeLists.txt:178-193`](https://github.com/ghostty-org/ghostty/blob/main/CMakeLists.txt).
5. Building from source requires **Zig on PATH** — "downstream users do still require `zig` on the PATH" — [`CMakeLists.txt:6`](https://github.com/ghostty-org/ghostty/blob/main/CMakeLists.txt). For Janela this means either vendoring a pinned prebuilt xcframework (recommended; keeps `xcodebuild`/`swift build` clean) or adding Zig to the dev/CI toolchain.

Third-party Swift wrappers exist (e.g. `caelyreth/libghostty-vt-spm`) but are not first-party; treat as reference only.

---

## 3. Writing our own VT parser + renderer: actual scope

The normative surface is not small.

- **xterm control sequences**: `ctlseqs` is a single ~187 KB reference covering C1 controls, DEC private modes, DCS/OSC/PM/APC, DECRQSS/DECRQM, rectangular-area ops (DECERA/DECCRA/DECFRA/DECRQCRA), title stack (XTTITLEPOS), XTSMGRAPHICS, six mouse-tracking protocols (X10 / normal / highlight / button-event / any-event / SGR / SGR-Pixels / urxvt), alternate screen buffer semantics (modes 47 / 1047 / 1048 / 1049 with `titeInhibit` interactions), bracketed paste, five function-key emulations (PC, VT220, VT52, Sun, HP), Sixel, ReGIS, and Tektronix 4014 mode — [Xterm Control Sequences](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html).
- The same document documents contradictions between DEC's own manuals (e.g. DECSDM/`CSI ? 80 h` meaning inverted between the VT330/VT340 manual and the VT382 Kanji/Thai manuals; DEC STD 070 is "more than twice the length of the VT520 programmer's reference manual") — see the *Further reading* section. You inherit those judgement calls.
- **Parser state machine**: the canonical reference is Paul Williams' DEC ANSI parser (<https://vt100.net/emu/dec_ansi_parser>), which SwiftTerm cites as its basis (`README.md:324`). That part is a week, not the hard part.
- **Conformance suite**: `esctest` (George Nachman → Thomas Dickey → freedesktop/terminal-wg, <https://gitlab.freedesktop.org/terminal-wg/esctest>) plus `vttest` (<https://invisible-island.net/vttest/>). SwiftTerm wires esctest into `swift test` via `make clone-esctest` (`README.md:222-233`). Assume thousands of assertions before "compatible".
- **BiDi**: the terminal-wg recommendation (<https://terminal-wg.pages.freedesktop.org/bidi/>) defines six presentation modes, BDSM (`CSI 8 h/l`), SCP (`CSI Ps SP k`), and DEC private modes 2500/2501/1243 — SwiftTerm implements all of them (`README.md:238-259`). If Janela ever ships to RTL users, this is a multi-week subproject on its own.
- **Reflow on resize** is the genuinely hard buffer problem (wrapped-line tracking across a circular scrollback, cursor and selection anchor fixups). Both SwiftTerm and libghostty-vt already solve it; a from-scratch implementation will be wrong for a long time.
- **Ligatures / complex shaping**: CoreText handles it, but a cell-grid renderer must decide run boundaries per cell; SwiftTerm's `arabic` RenderBench scenario exists precisely because BiDi+shaping+font-fallback is a distinct perf axis (`PERFORMANCE.md:74-75`).
- **Graphics**: Sixel (DCS `Pa;Pb;Ph q`), iTerm2 OSC 1337, Kitty graphics protocol — three independent image pipelines, each with placement/scroll/eviction semantics.

Verdict: writing the *parser* is tractable; writing the *terminal* (buffer + reflow + modes + graphics + BiDi + conformance) is a multi-person-year effort that produces no product differentiation for an IDE. **Do not do this.** Write the *renderer* if you need to (that is the part that is genuinely Janela-specific and where the performance ceiling lives).

---

## 4. xterm.js in a WKWebView — why it is wrong here

Concrete, primary evidence against it for a native macOS app:

1. **Renderer fragility on WebKit.** xterm.js's WebGL addon is the fast path; the canvas addon was kept alive specifically because "the case of Safari not supporting webgl2 was the biggest of these" — [xtermjs/xterm.js#4779](https://github.com/xtermjs/xterm.js/issues/4779). Recent, still-open WKWebView-specific rendering corruption: "[webgl] Partial row ghosting with transparent theme background on WKWebView / Tauri (stable macOS)" — [xtermjs/xterm.js#5847](https://github.com/xtermjs/xterm.js/issues/5847). You would be shipping a renderer whose correctness is a function of the user's OS/WebKit build, which you do not control.
2. **Platform detection breaks inside WKWebView** (WKWebView's UA differs from Safari's) — [xtermjs/xterm.js#3575](https://github.com/xtermjs/xterm.js/issues/3575).
3. **PTY bytes must cross a JS bridge.** Every chunk goes native → `WKScriptMessage`/`evaluateJavaScript` → JS string → xterm.js parser. UTF-8 → UTF-16 → back, plus main-thread serialization, per session. For N concurrent high-throughput agent sessions this is strictly worse than feeding `ArraySlice<UInt8>` into an in-process parser.
4. **Memory.** Each `WKWebView` is a separate WebContent process. "Many concurrent sessions" becomes many content processes plus GPU process pressure — the opposite of Janela's stated goals (startup time, memory, responsiveness).
5. Startup: WebKit process spin-up and JS bundle parse land directly on the critical path of "open a new terminal".

The only reason to pick this is code reuse from an existing web IDE. Janela has none. Reject.

---

## 5. macOS PTY and process spawning

### 5.1 The PTY primitives (Apple/Darwin `util.h`)

`openpty(3)` on macOS documents all three functions you care about — [OPENPTY(3), Apple xcode man pages](https://keith.github.io/xcode-man-pages/openpty.3.html):

- `int openpty(int *aprimary, int *areplica, char *name, struct termios *termp, struct winsize *winp)` — allocates a pty pair; `termp`/`winp` set the replica's termios and window size **at creation** (avoids a startup resize race).
- `int login_tty(int fd)` — "prepares for a login on the tty fd … by **creating a new session**, making fd the **controlling terminal** for the current process, setting fd to be the standard input, output, and error streams, and closing fd." This is the operation `posix_spawn` cannot do.
- `pid_t forkpty(int *aprimary, char *name, struct termios *termp, struct winsize *winp)` — `openpty` + `fork` + `login_tty`.
- Failure modes: `EAGAIN` (no available pseudo-ttys), `ENXIO` (the `kern.tty.ptmx_max` sysctl limit reached). **This is a hard ceiling on concurrent sessions and Janela must handle it gracefully** — a "many concurrent sessions" IDE will hit it before a normal terminal app does.
- Devices: `/dev/ptmx` (cloning device), `/dev/ttys[0-9][0-9][0-9]` (replicas).
- CAVEAT from the man page: prefer `ptsname_r(3)` over the `name` out-parameter (128-byte buffer footgun). Pass `NULL`.

`posix_openpt(2)`/`grantpt`/`unlockpt`/`ptsname_r` is the POSIX-portable alternative to `openpty`; on Darwin `openpty` is the ergonomic wrapper and is what both SwiftTerm and Ghostty effectively use.

### 5.2 Window size: `TIOCSWINSZ`

`tty(4)` on macOS: `TIOCGWINSZ` "Put the window size information associated with the terminal in the `winsize` structure… contains the number of rows and columns (and pixels if appropriate)… It is set by user software and is the means by which most full-screen oriented programs determine the screen size"; `TIOCSWINSZ struct winsize *ws` sets it — [TTY(4)](https://keith.github.io/xcode-man-pages/tty.4.html). Setting it delivers `SIGWINCH` to the foreground process group.

SwiftTerm's implementation, worth copying verbatim including the pixel fields:

```swift
public static func setWinSize(masterPtyDescriptor: Int32, windowSize: inout winsize) -> Int32 {
    return ioctl(masterPtyDescriptor, TIOCSWINSZ, &windowSize)   // macOS
}
```

— [`Sources/SwiftTerm/Pty.swift:117-124`](https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/Pty.swift)

```swift
let scale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 1
let pxW = Int((cellDimension?.width ?? 0) * CGFloat(terminal.cols) * scale)
let pxH = Int((cellDimension?.height ?? 0) * CGFloat(terminal.rows) * scale)
return winsize(ws_row: ..., ws_col: ..., ws_xpixel: UInt16(pxW), ws_ypixel: UInt16(pxH))
```

— [`Sources/SwiftTerm/Mac/MacLocalTerminalView.swift:214-220`](https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/Mac/MacLocalTerminalView.swift). Populating `ws_xpixel`/`ws_ypixel` with backing-scale-aware values is what makes Sixel/Kitty image sizing and SGR-Pixels mouse mode correct on Retina.

`FIONREAD` for "bytes available" is also wrapped (`Pty.swift:129-134`), useful for coalescing.

### 5.3 Foundation `Process` vs `posix_spawn` vs `fork`+`exec`

**Neither `Foundation.Process` nor `posix_spawn` can make the child's stdio a controlling terminal.** The most direct primary statement is SwiftTerm's own build manifest, explaining why the swift-subprocess dependency was abandoned:

> We can not use Swift Subprocess, because there is no way of configuring the child process to be a controlling terminal, as it is posix-spawn based.
> — [`Package.swift:101-103`](https://github.com/migueldeicaza/SwiftTerm/blob/main/Package.swift)

Corroborating: SwiftTerm's dead-code Subprocess path had to reach into `preSpawnProcessConfigurator` to set `POSIX_SPAWN_SETSID` — which gives a new session but **not** a controlling terminal — and is disabled behind `#if false` — [`LocalProcess.swift:389-396, 448-454`](https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/LocalProcess.swift). Darwin's `posix_spawn` has no `TIOCSCTTY` file action; `tty(4)` documents `TIOCSCTTY` as the ioctl that makes a terminal controlling, and it must be issued *by the child after `setsid()`*, i.e. between fork and exec.

Therefore the only correct shapes are:

- `forkpty()` + `execve()` in the child (SwiftTerm's shipping path — [`Pty.swift:97-108`](https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/Pty.swift)), or
- `openpty()` + `fork()` + `login_tty(replica)` + `execve()` — same thing, more control (lets you `chdir`, adjust signal masks, set `rlimits`, close FDs before exec).

Caution with `fork()` in a Cocoa app: between `fork` and `exec` you are in an async-signal-safe-only world. SwiftTerm's child branch does exactly and only `chdir` + `execve` + `_exit(127)` (`Pty.swift:101-108`). **Do not allocate, do not touch Swift runtime metadata, do not call Foundation, do not log** in that window. Pre-marshal all `char**` arrays before forking (SwiftTerm's `allocateCStringArray`, `Pty.swift:24-49`).

### 5.4 Reading the PTY: DispatchIO vs DispatchSource

SwiftTerm's shipping answer, and the reasoning is written into the source. Use it as the reference design.

- **`DispatchIO(type: .stream, fileDescriptor:)`** with `setLimit(lowWater: 1)`, `setLimit(highWater: 128*1024)` and a 128 KB read size — [`LocalProcess.swift:64, 545-557`](https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/LocalProcess.swift).
- **FD ownership**: close the fd in the `DispatchIO` cleanup handler, never before. "This prevents `BUG IN CLIENT OF LIBDISPATCH: Unexpected EV_VANISHED` crash by ensuring proper cleanup order" (lines 546-549, 574-577). This is a real crash class in multi-session apps.
- **One read op must spawn exactly one successor.** "`DispatchIO` invokes this handler several times per read op (partial deliveries with `done=false`, then a final `done=true`). Re-arming on every invocation spawns an extra concurrent read chain per partial delivery — under a fast producer the chains multiply and hundreds of MB of in-flight reads pile up." (lines 321-329).
- **Backpressure is mandatory.** SwiftTerm reads on a private queue and posts to the delivery queue; without a high-water mark "the read loop re-arms unconditionally, so when the child produces output faster than the consumer queue drains it, `pendingChunks` grows without bound (observed ~280 MB/s with a `yes` flood against a busy main thread — multi-GB footprints in long sessions). Past the high-water mark we stop re-arming the PTY read; the kernel PTY buffer fills and the child blocks in `write()`, exactly like any other terminal." High water 4 MB, low water 1 MB (lines 96-107).
- **Time-sliced drain**: the main-queue drain yields after 4 ms (`pendingTimeSliceNs = 4_000_000`) and reschedules, so a flooding session cannot starve the UI (lines 91, 202-207).
- **Child exit** is observed with `DispatchSource.makeProcessSource(identifier:eventMask: .exit)`, with two documented ordering hazards: publish `shellPid` *before* `activate()` (else `waitpid(0, …)` targets the wrong process group), and install the event handler *before* activating, because "NOTE_EXIT is delivered at most once; if the source is activated first and a fast-exiting child's exit fires before the handler is set, the event is dropped and never redelivered" (lines 514-541).
- PTY EOF and process exit race: on EOF the process monitor is deliberately kept alive so `processTerminated` can still fire (lines 296-305).

For Janela specifically: **do not default the delivery queue to `DispatchQueue.main`.** `LocalProcess(delegate:dispatchQueue:)` takes a queue; give each session its own serial queue, parse off-main, and hop to main only to mark dirty regions. Note SwiftTerm's non-main path uses `dispatchQueue.sync { delegate.dataReceived(...) }` (lines 333-337), so the emulator instance must be safe on that queue — the README claims "Thread-safe Terminal instances".

`DispatchSource.makeReadSource` is the lower-level alternative; it gives you the `read(2)` yourself (useful for reading directly into a reusable buffer with zero `[UInt8]` allocation per chunk, which `DispatchIO`'s `DispatchData` → `[UInt8]` copy at `LocalProcess.swift:306-320` does not). If Janela profiles allocation pressure at high throughput, this is the first thing to change.

---

## 6. Shell integration, login shells, environment

### 6.1 `argv[0] == "-zsh"` is the only reliable login-shell flag for sh-family shells

zsh source, `parseargs()`:

```c
int flags = PARSEARGS_TOPLEVEL;
if (**argv == '-') flags |= PARSEARGS_LOGIN;
argv0 = argzero = posixzero = *argv++;
```

— [`Src/init.c`, zsh-users/zsh](https://github.com/zsh-users/zsh/blob/master/Src/init.c)

So: `execve("/bin/zsh", ["-zsh"], env)`. In SwiftTerm this is the `execName:` parameter, threaded through to `shellArgs.insert(firstArgName, at: 0)` — [`LocalProcess.swift:499-504`](https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/LocalProcess.swift).

Consequence (zsh(1) STARTUP/SHUTDOWN FILES, macOS): a login shell reads `/etc/zshenv`, `$ZDOTDIR/.zshenv`, then `/etc/zprofile`, `$ZDOTDIR/.zprofile`, then (if interactive) `/etc/zshrc`, `$ZDOTDIR/.zshrc`, then `/etc/zlogin`, `$ZDOTDIR/.zlogin` — [zsh(1), Apple man pages](https://keith.github.io/xcode-man-pages/zsh.1.html). On macOS `/etc/zprofile` runs `path_helper`, which is why a **non**-login shell in an IDE frequently has a broken `PATH` and cannot find `claude`, `codex`, `node`, or Homebrew binaries. **Janela must launch login shells by default**, or agent CLIs will "not be installed" for a large fraction of users.

The user's shell should come from the directory service / `getpwuid()`-provided shell (`SHELL` in the app's own environment is inherited from `launchd` and is usually right for GUI apps, but is not authoritative).

### 6.2 `TERM`, terminfo, `COLORTERM`

- SwiftTerm defaults the child environment to `TERM=xterm-256color`: "A nil environment keeps the `LocalProcess` default (`TERM=xterm-256color`); hosts that want `options.termName` in the child's environment pass `Terminal.getEnvironmentVariables(termName:)` explicitly" — [`MacLocalTerminalView.swift:184-187`](https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/Mac/MacLocalTerminalView.swift); the default is set at [`LocalProcess.swift:508`](https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/LocalProcess.swift).
- Advertising a **custom** `TERM` (e.g. `xterm-ghostty`) only works if the terminfo entry exists on every machine the shell runs on, including over SSH. SwiftTerm ships `xterm-ghostty.infocmp` and `swifterm-terminfo.infocmp` as test fixtures ([`Package.swift:136-139`](https://github.com/migueldeicaza/SwiftTerm/blob/main/Package.swift)), i.e. it treats terminfo parity as a testable contract. For Janela: **default to `xterm-256color`.** A custom TERM is a support burden with near-zero payoff for agent CLIs.
- `COLORTERM=truecolor` is a de-facto convention, not a spec: VTE, Konsole and iTerm2 set it; "Having an extra environment variable (separate from `TERM`) is not ideal: by default it is not forwarded via sudo, ssh, etc… Despite these problems, it's currently the best option, so checking `$COLORTERM` is recommended" — [termstandard/colors README](https://github.com/termstandard/colors). Set `COLORTERM=truecolor`.
- Also strip/normalize: remove `TERM_PROGRAM`-style leftovers from the host app's own environment, set `TERM_PROGRAM=Janela` + `TERM_PROGRAM_VERSION`, set `LANG`/`LC_CTYPE` to a UTF-8 locale if unset, and unset variables that leak the parent GUI process (`XPC_SERVICE_NAME`, `__CF*`).

### 6.3 Shell integration hooks worth wiring on day one

Both engines already parse these; you just need to emit/consume them:

- **OSC 7** (working directory) → `Terminal.hostCurrentDirectory` / `hostCurrentDirectoryUpdated` — [`Terminal.swift:146-154, 528-533`](https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/Terminal.swift). This is how Janela knows which worktree/repo a session is in without heuristics.
- **OSC 133** semantic prompts (`SemanticPrompt.swift`, `Docs/semantic-prompt-design.md`) → command boundaries, exit codes, "jump to previous prompt", and the ability to know when an agent's command actually finished.
- **OSC 8** hyperlinks → clickable file:line from agent output.
- **OSC 9;4** progress reports → `Terminal.ProgressReport` with `remove/set/error/indeterminate/pause` states ([`Terminal.swift:304-320`](https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/Terminal.swift)) — free progress UI for long agent runs.
- **OSC 52** clipboard: SwiftTerm's default `clipboardRead` returns `nil` "denying the request for security" ([`Terminal.swift:212`](https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/Terminal.swift)). Keep that default; agents run untrusted code.
- Note `Terminal.isProcessTrusted` gating screen-readback (DECRQCRA checksum) — keep it restrictive.

---

## 7. Keeping sessions alive across app restarts

Three viable mechanisms, in increasing order of control:

**(a) tmux control mode.** `tmux -CC attach` turns tmux into a text protocol driver: "a control mode client is just like a normal tmux client except that instead of drawing the terminal, tmux communicates using text… Control mode clients accept standard tmux commands and return their output, and additionally send control mode only information (mostly asynchronous notifications) prefixed by `%`" — [tmux Control Mode wiki](https://github.com/tmux/tmux/wiki/Control-Mode). Protocol essentials:

- `-C` leaves the terminal in canonical mode (testing); `-CC` disables canonical mode and echo and emits `\033P1000p` (DSC) on entry plus `%exit` + `ST` on exit, so the host can detect control mode.
- Commands are framed by `%begin <time> <cmdnum> <flags>` … `%end`/`%error` with matching time+number.
- Pane output arrives as `%output %<pane-id> <data>` with all bytes < ASCII 32 and `\` octal-escaped; "it may not be valid UTF-8 and may contain escape sequences which will be as expected by tmux (so for `TERM=screen` or `TERM=tmux`)".
- Async notifications: `%window-add`, `%window-close`, `%window-renamed`, `%session-changed`, `%sessions-changed`, `%pane-mode-changed`, `%window-pane-changed`, `%layout-change`, etc.
- Sizing/flow control is via `refresh-client`: `-C XxY` "sets the width and height of a control mode client or of a window", `-A pane:state` "allows a control mode client to trigger actions on a pane" (`on`/`off`/`continue`/`pause`), and `-f` client flags include `no-output` and `pause-after=seconds` — [`tmux.1`](https://github.com/tmux/tmux/blob/master/tmux.1), [`cmd-refresh-client.c`](https://github.com/tmux/tmux/blob/master/cmd-refresh-client.c). Those flags are exactly the backpressure knobs you need for many concurrent panes.
- Cost: you now emulate a terminal *inside* an emulated terminal, `TERM` becomes `screen`/`tmux` inside panes, and you inherit tmux's copy-mode/keys model. Also: tmux must be installed. Note that **libghostty-vt compiles a tmux control-mode parser** (`GHOSTTY_BUILD_INFO_TMUX_CONTROL_MODE`, [`example/c-vt-build-info/src/main.c:12`](https://github.com/ghostty-org/ghostty/blob/main/example/c-vt-build-info/src/main.c)) — if Janela goes the libghostty-vt route, control-mode parsing is partly free.

**(b) A Janela helper daemon.** A small `janelad` launched with `setsid()`, owning the PTYs, holding scrollback, and speaking a private protocol over a Unix domain socket in the app's container. The GUI reattaches on launch. This is strictly more capable than tmux control mode (you control framing, backpressure, and scrollback format) and avoids the double-emulation tax. It is also what makes "restore 20 agent sessions in <1s" achievable, because the daemon can hand over a compact snapshot rather than a replay stream.

**(c) State snapshot without process survival.** libghostty-vt exposes a **Snapshot** API group: "Encode and incrementally restore terminal state" — [`include/ghostty/vt.h:34`](https://github.com/ghostty-org/ghostty/blob/main/include/ghostty/vt.h). For agent sessions where the CLI process itself does not need to survive (most Claude Code / Codex invocations are request-scoped), snapshotting the *screen* and re-spawning is far cheaper than keeping hundreds of processes alive. SwiftTerm has no equivalent snapshot API; you would serialize `Buffer`/`BufferLine` yourself or record an asciicast (`Sources/Termcast/`).

Simply "detaching" the child (double-fork + `setsid`) without a daemon does not work well: nobody drains the PTY, the kernel buffer fills, and the child blocks in `write()` — which is exactly the mechanism SwiftTerm documents at [`LocalProcess.swift:96-107`](https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/LocalProcess.swift). Whoever holds the primary fd must keep reading. That is the daemon's job.

---

## 8. App Sandbox

Hard constraints, from Apple:

- Enabling the sandbox is the `com.apple.security.app-sandbox` entitlement; it is "enforced at the kernel level" — [App Sandbox Entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.app-sandbox), [Configuring the macOS App Sandbox](https://developer.apple.com/documentation/xcode/configuring-the-macos-app-sandbox).
- Child processes: "If your app employs a child process created with either the `posix_spawn` function or the `NSTask` class, you can configure the child process to inherit the sandbox of its parent… To enable sandbox inheritance, a child target must use **exactly two** App Sandbox entitlement keys: `com.apple.security.app-sandbox` and `com.apple.security.inherit`. If you specify any other App Sandbox entitlement, the system will terminate the child" — [Enabling App Sandbox, Entitlement Key Reference](https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html).
- The practical consequence: a sandboxed app may only launch **executables embedded in its own bundle**, correctly signed and inheriting. Launching `/bin/zsh`, or `~/.local/bin/claude`, or an arbitrary `node` from a Homebrew prefix, is not a supported configuration. Apple's own DTS guidance on this is blunt: asked whether an external `Process()` can be launched with sandbox enabled — "Not really." — [Developer Forums thread 727658](https://developer.apple.com/forums/thread/727658); see also [thread 87849](https://developer.apple.com/forums/thread/87849) and [QA1773](https://developer.apple.com/library/archive/qa/qa1773/_index.html).
- Even if you got the spawn to work, sandboxed file access is limited to the container plus user-selected paths (security-scoped bookmarks). An IDE that indexes arbitrary git worktrees, follows symlinks into `node_modules`, and lets an agent write anywhere in the repo is fundamentally at odds with that. Security-scoped bookmarks also do not transfer to child processes.
- SwiftTerm states the same conclusion in its own API docs: "Generally, for the `LocalProcessTerminalView` to be useful, you will want to disable the sandbox for your application, otherwise the underlying shell will not have access to much… you need to disable for your target in 'Signing and Capabilities' the sandbox entirely." — [`MacLocalTerminalView.swift:52-55`](https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/Mac/MacLocalTerminalView.swift). Its sample app ships an **empty** entitlements dict — [`TerminalApp/MacTerminal/MacTerminal.entitlements`](https://github.com/migueldeicaza/SwiftTerm/blob/main/TerminalApp/MacTerminal/MacTerminal.entitlements).

**Decision for Janela: ship unsandboxed, Developer ID–signed and notarized, distributed outside the Mac App Store.** Enable Hardened Runtime, and only the entitlements you actually need (`com.apple.security.cs.allow-jit` / `allow-unsigned-executable-memory` only if a dependency demands it — they weaken the runtime). Accept that Mac App Store distribution is off the table; every terminal emulator on macOS that runs a real shell (Terminal.app, iTerm2, Ghostty, Warp) makes the same trade.

---

## 9. Ranked recommendation

Ranking axes: (1) time-to-first-usable, (2) performance ceiling, (3) maintenance risk.

**Rank 1 — SwiftTerm as the v0/v1 engine, behind a Janela-owned protocol.**

- Time-to-first-usable: days. `LocalProcessTerminalView` + an `NSViewRepresentable` gets a working PTY-backed pane immediately; `LocalProcess` alone gets you the PTY layer if you want your own view.
- Performance ceiling: adequate today (CG), better with `setUseMetal(true)`, but the parser hot path has documented ARC/exclusivity overhead (#373) and the buffer is array-of-lines (#379).
- Maintenance risk: medium. MIT, vendorable, actively developed, but single-maintainer and Swift 5 language mode.
- Non-negotiable adaptations: (a) never use `DispatchQueue.main` as the delivery queue — one serial queue per session; (b) enable Metal per-view and A/B it with `Tools/RenderBench`; (c) suspend/throttle rendering for occluded or background panes (`NSView.isHiddenOrHasHiddenAncestor`, window occlusion notifications) — parsing must continue, drawing must not; (d) cap scrollback per session (`TerminalOptions.scrollback`) and measure resident memory at 20 sessions before committing.

**Rank 2 — libghostty-vt + a Janela Metal renderer + a Janela PTY/session layer.**

- Time-to-first-usable: weeks–months (you write font/shaping, atlas, damage-driven Metal draw, selection UI, input encoding glue, accessibility).
- Performance ceiling: the highest realistically reachable. You get Ghostty's parser/buffer/reflow (millions of users, MIT), an explicit incremental render-state with `DIRTY_{FALSE,PARTIAL,FULL}`, grid refs that survive scroll, idle scrollback compression, key/mouse/focus encoders, and a state Snapshot API.
- Maintenance risk: medium-high, and it is *API churn*, not correctness. Pin a specific xcframework build, wrap 100% of the C surface behind one Swift module, and budget recurring upgrade work.
- Adoption mechanics are already solved: SPM `binaryTarget` on `ghostty-vt.xcframework`, universal macOS/iOS, `@rpath/libghostty-vt.dylib`, only `_ghostty_` symbols exported, static option with vendored SIMD.

**Rank 3 — Roll your own parser+buffer.** Only if both of the above fail on a specific, measured requirement. The `ctlseqs` + esctest surface is the reason.

**Rank 4 — libghostty-internal (`include/ghostty.h`).** Excluded: the header says it is not for external use, most functions are undocumented, and the ABI tracks the needs of Ghostty.app.

**Rank 5 — xterm.js/WKWebView.** Excluded for a native app: renderer correctness varies with the user's WebKit build, per-session WebContent processes, and a JS bridge on the PTY hot path.

---

## 10. Implications for Janela

1. **Define `TerminalEngine` and `TerminalSession` protocols on day one.** Janela owns: PTY lifecycle, session identity, workspace/worktree association, scrollback policy, search, and the Metal/AppKit surface contract. SwiftTerm sits behind `TerminalEngine` as `SwiftTermEngine`. When (not if) you evaluate `GhosttyVTEngine`, it is a module swap, not a rewrite. Concretely: engine input is `feed(_ bytes: ArraySlice<UInt8>)`, engine output is a damage description (`dirtyRows: IndexSet`, cursor, selection, palette) — which is exactly libghostty-vt's render-state shape, so designing to it now buys the migration cheaply.

2. **Own the PTY layer; do not inherit `LocalProcess` semantics wholesale.** Write `JanelaPTY` using `openpty` + `fork` + `login_tty` + `execve` (more control than `forkpty`: `chdir`, FD hygiene, signal-mask reset, `rlimit`), with SwiftTerm's hard-won invariants carried over: FD closed only in the `DispatchIO` cleanup handler; exactly one successor read per completed op; explicit high/low water backpressure; `DispatchSource` process monitor with handler installed before `activate()` and `shellPid` published first. All four of those are crash/leak classes documented in [`LocalProcess.swift`](https://github.com/migueldeicaza/SwiftTerm/blob/main/Sources/SwiftTerm/LocalProcess.swift), and none are optional at 20+ sessions.

3. **Handle pty exhaustion explicitly.** `openpty` fails with `ENXIO` at `kern.tty.ptmx_max`. A "many concurrent sessions" IDE must surface a real error and offer to reclaim idle sessions rather than silently failing to open a pane.

4. **Never deliver PTY bytes on the main queue.** One serial queue per session for read+parse; main thread only receives coalesced damage at display refresh. This is the single decision that determines whether 20 streaming agent sessions feel native or feel like Electron.

5. **Render only what is visible.** Occluded panes and background windows must stop drawing but keep parsing (agents produce output when unwatched). Coalesce to `CVDisplayLink`/`CAMetalDisplayLink` cadence with a per-frame budget; if a session exceeds it, drop intermediate frames — a terminal is allowed to skip frames, never bytes.

6. **Launch login shells with `argv[0] = "-zsh"`.** Use SwiftTerm's `execName:` parameter, or your own `execve`. Without it, `/etc/zprofile`/`path_helper` never runs and agent CLIs installed via Homebrew/npm/mise will appear missing. Set `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=Janela`, a UTF-8 `LANG`, and `cwd` = the session's worktree path.

7. **Ship unsandboxed, Developer ID + notarized, Hardened Runtime on.** Sandbox inheritance requires the child to carry exactly `app-sandbox` + `inherit` and to live inside the bundle — incompatible with running the user's shell and the user's agent binaries against arbitrary repo paths. Plan distribution accordingly (no MAS).

8. **Adopt OSC 7 / OSC 133 / OSC 8 / OSC 9;4 as first-class IDE signals**, not cosmetics. OSC 7 → automatic worktree binding for a session. OSC 133 → "agent command started/finished + exit code" without parsing prose. OSC 8 → clickable diagnostics. OSC 9;4 → progress in the session chrome. All four are already parsed by SwiftTerm and by libghostty-vt's OSC parser, so the cost is UI, not emulation. Keep OSC 52 clipboard *reads* denied by default.

9. **Session persistence: prefer a Janela helper daemon over tmux.** tmux control mode is well documented and gives free persistence, but costs double emulation, `TERM=screen`/`tmux` inside panes, and a hard dependency on the user's tmux. A `setsid()` helper owning PTYs + scrollback, reachable over a container Unix socket, is more work but matches Janela's "workspace-centric, many sessions" model and lets you use libghostty-vt's Snapshot API later. If you must ship persistence in v1, tmux `-CC` with `refresh-client -f pause-after=N` per pane is the fastest credible path.

10. **Instrument from the first commit.** Copy SwiftTerm's methodology (`PERFORMANCE.md`): a headless feed benchmark, an on-screen synthetic render bench with a fixed seed and a `--metal` toggle, and `os_signpost` around feed/parse vs draw. Track: cold app launch to first prompt; new-pane latency; MB/s sustained per session; resident memory at 1/5/20 sessions; frame time under `dense_cells` and `scroll` vtebench workloads. Without these, the SwiftTerm→libghostty-vt decision in six months will be an argument instead of a measurement.

---

## Sources

Primary, kept:

- `migueldeicaza/SwiftTerm` — `README.md`, `LICENSE`, `Package.swift`, `PERFORMANCE.md`, `Sources/SwiftTerm/Pty.swift`, `Sources/SwiftTerm/LocalProcess.swift`, `Sources/SwiftTerm/Terminal.swift`, `Sources/SwiftTerm/Mac/MacLocalTerminalView.swift`, `Sources/SwiftTerm/Documentation.docc/GPURendering.md`, `TerminalApp/MacTerminal/MacTerminal.entitlements`; issues #137, #373, #379; PRs #449, #555.
- `ghostty-org/ghostty` — `LICENSE`, `README.md`, `HACKING.md`, `CMakeLists.txt`, `include/ghostty.h`, `include/ghostty/vt.h`, `src/lib_vt.zig`, `example/README.md`, `example/c-vt-render/src/main.c`, `example/c-vt-build-info/src/main.c`, `example/swift-vt-xcframework/{Package.swift,README.md,Sources/main.swift}`, `.github/scripts/check-apple-libghostty-vt.nu`, `macos/Sources/Ghostty/Ghostty.App.swift`, commit `c12a0e3`.
- Apple man pages (Xcode/Darwin): `openpty(3)`, `tty(4)`, `zsh(1)`.
- Apple developer docs: App Sandbox entitlement, Configuring the macOS App Sandbox, Enabling App Sandbox (Entitlement Key Reference), QA1773, DTS forum threads 727658 / 87849 / 706390.
- `tmux/tmux` — Control Mode wiki, `tmux.1`, `cmd-refresh-client.c`.
- `zsh-users/zsh` — `Src/init.c`.
- Thomas Dickey, *Xterm Control Sequences* (`ctlseqs`); vt100.net DEC ANSI parser; terminal-wg `esctest`; terminal-wg BiDi recommendation.
- `termstandard/colors` — `COLORTERM` conventions.
- `xtermjs/xterm.js` — issues #3575, #4779, #5847.

Dropped:

- Third-party Ghostty/SwiftTerm blog posts and comparison articles — superseded by the source trees.
- `caelyreth/libghostty-vt-spm` — useful as a reference wrapper, but not first-party; not a basis for any claim here.
- `zsh.sourceforge.io` manual (HTTP 403) and `terminal-wg` GitLab specifications index (bot wall) — replaced with the zsh source and the xterm ctlseqs reference respectively.
- Aigne/docsmith "Ghostty macOS Development" mirror — secondary; used only to locate `src/build/GhosttyXCFramework.zig`, whose contents were then read directly.

## Gaps

- **Metal-vs-CoreGraphics numbers for SwiftTerm**: no published benchmark results exist in-repo (only the harness). Janela must run `Tools/RenderBench --metal` on target hardware before assuming Metal is a win for its workloads.
- **libghostty-vt render-state maturity**: the header is explicit that the API will change; there is no versioned stability guarantee and no macOS reference renderer built on it in-tree (the examples are CLI/formatter-oriented). Effort to build a production Metal renderer on it is estimated, not measured.
- **`kern.tty.ptmx_max` default on macOS 26** was not verified empirically; check `sysctl kern.tty.ptmx_max` on target machines before promising a session count.
- **Ghostty's `-Demit-lib-vt` tip artifacts**: release cadence and long-term hosting of the prebuilt xcframework are policy, not spec; verify before depending on a URL in CI.
