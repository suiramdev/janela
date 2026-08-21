# 0024. Tauri is the client shell

- **Status:** Accepted
- **Date:** 2026-08-21
- **Supersedes:** [0001](0001-project-generation.md) — there is no Xcode project to
  generate.

## Context

[0023](0023-macos-first-portable.md) decides that the client renders in a WebView.
This decides what hosts it.

The requirements are set by documents that predate the migration, and they are
narrow enough to be decisive:

1. **It must open a Unix domain socket.** A WebView cannot. The daemon is reached
   over `~/.janela/run/janelad.sock` ([0016](0016-daemon-protocol.md)), so the shell
   has to open it and relay frames — **as bytes**, because terminal output is the hot
   path and base64-in-JSON is the mistake 0016 refused to make on the socket.
2. **It must provide a real native menu bar**, because principle 4 survives
   ([0023](0023-macos-first-portable.md)) and menus are one of the parts that stays
   genuinely native. Likewise native notifications and native file dialogs — the last
   of which is a *rule*, not a nicety: the app performs file selection and the daemon
   is handed paths, which is what keeps macOS permission prompts attributed to the app
   the user clicked rather than to a background binary
   ([0017](0017-daemon-lifecycle.md) § TCC attribution).
3. **It must ship a second executable inside the bundle** — `janelad` — signed,
   notarized, and registered as a LaunchAgent
   ([0008](0008-sandboxing-and-distribution.md), [0017](0017-daemon-lifecycle.md)).
4. **It must not carry a browser.** Janela's reason to exist is being quicker and
   lighter than the Electron-based competition, and shipping Chromium to render a
   sidebar and a terminal would concede that outright.

## Decision

**Tauri 2. `src-tauri/` is a thin Rust shell; `src/` is the React frontend.**

Tauri uses the system WebView — WKWebView on macOS — so requirement 4 is met by
construction, and it satisfies 1 through 3 directly.

### What belongs in the shell, and what does not

The list is closed, and keeping it closed is the point:

- the window and its native chrome
- the native menu bar and its accelerators, built from `@janela/ui`'s `COMMANDS`
  table so the menu and the in-app command palette cannot drift apart
- native notifications
- native file dialogs
- the daemon sidecar's lifecycle and launch-agent registration
- **the Unix-socket bridge**

What does not belong: anything about projects, sessions, terminals, or what a
protocol message *means*. The shell relays frames; it does not read them. If Rust
code here ever needs to know what a `StateUpdate` is, the boundary has moved and that
should be an ADR rather than a commit.

This mirrors the discipline the old app shell had — one file, do not grow it — and it
exists for the same reason: logic in a shell is logic that cannot be tested without
the shell.

### The bridge is the interesting part

Client → daemon and daemon → client both cross Tauri's IPC. Three rules:

- **Raw bytes in both directions.** Asserted by a test that pushes invalid UTF-8
  through and compares bytes, because the failure is silent otherwise.
- **Back-pressure lives on the daemon → WebView direction**, and the two policies are
  different: coalesced repaints may drop their oldest entry, because a newer frame
  supersedes it; control frames and terminal input may not, ever.
- **Reconnection is the shell's business, not the frontend's.** The Rust side owns
  the socket; `MessageTransport.incoming()` finishes when the shell says the
  connection ended, and `@janela/client` asks for a new one. Two retry loops in two
  languages is one too many.

### What replaces XcodeGen

[0001](0001-project-generation.md) existed because `project.pbxproj` does not merge
and coding agents corrupt it. Both problems are simply gone: `tauri.conf.json` and
`Cargo.toml` are small, readable, hand-edited files that merge like any other. The
bundling, entitlements, signing and notarization that ADR listed as the reasons an
Xcode project was unavoidable are all things Tauri's bundler does from
configuration.

## Consequences

**Good.** The Unix socket problem — the one genuinely hard constraint a WebView
imposes — is solved by the shell rather than by compromising the protocol.

**Good.** Menus, notifications and file dialogs are actually native, which is the
majority of what principle 4 asks for and the part users notice most.

**Good.** No bundled browser. A Tauri bundle is a few megabytes plus our sidecar,
against Electron's ~100 MB floor.

**Good.** The sidecar mechanism is exactly the shape [0017](0017-daemon-lifecycle.md)
needs: a second executable inside the bundle, alongside a LaunchAgent plist.

**Bad.** WKWebView is the rendering target, and its quirks are ours. Where Chromium
would be one known browser, we now inherit whatever Safari's engine does on the
user's OS version — including its bugs, and including changes that arrive with an OS
update we did not ask for. This is the standard Tauri trade and it is real.

**Bad.** Two more boundaries on the keystroke path. Budgeted in
[0023](0023-macos-first-portable.md); if it regresses, the IPC path is what to fix.

**Bad.** Rust in the build for a second reason. Already required by
[0021](0021-pty-native-layer.md), so it adds no new toolchain, but `cargo build` for
the shell is the slowest thing in the repository and it is on the path to seeing the
app run at all.

**Bad.** Tauri's own churn. It is younger than the Apple frameworks it replaces, and
a breaking change in its API is a thing that can happen to us. Confined to
`apps/desktop`, which is the smallest package that could hold it.

**Bad.** Notarizing a bundle whose contents Tauri assembles means understanding
Tauri's bundler as well as Apple's requirements. Getting it wrong fails at install
time on a user's machine rather than in CI — unchanged in kind from
[0008](0008-sandboxing-and-distribution.md), but now with an extra tool in the middle.

## Alternatives considered

**Electron.** Better documented, more predictable rendering, and node-pty is a solved
problem there. Rejected on requirement 4: shipping Chromium contradicts the reason
Janela exists, and `../performance.md`'s launch budgets are not reachable with it.
It would also mean a second JavaScript runtime beside Bun's.

**A native macOS shell hosting a WKWebView directly.** No Tauri, full control, and
AppKit for chrome. Genuinely viable and the most "native" of the WebView options.
Rejected because it keeps a Swift codebase and an Xcode project — reintroducing
[0001](0001-project-generation.md)'s entire problem — to save a dependency, and
because it forecloses [0023](0023-macos-first-portable.md)'s portability for no gain
the user perceives.

**Wails, Neutralino, or another system-WebView shell.** Same category as Tauri, less
mature, smaller ecosystems, and none with a better sidecar or bundling story.
Rejected on maturity; nothing here is a criticism of the approach.

**A pure browser client, served by the daemon over HTTP.** No shell at all, and it
would make [0023](0023-macos-first-portable.md)'s portability immediate. Rejected as
the *primary* client: no native menus, no native notifications, no file dialogs that
produce a TCC grant, and a developer tool that lives in a browser tab is not the
product. It remains the expected *second* client, which is the whole point of the
transport seam.

## Revisit when

- WKWebView's behaviour costs more than Chromium's size would. That is the argument
  for Electron and it should be made with specifics, not vibes.
- Tauri ships a breaking change `apps/desktop` cannot absorb.
- The native-feel gap in [0023](0023-macos-first-portable.md) proves worse than
  expected against real feedback, at which point a native shell hosting the same
  WebView is the intermediate step — it keeps the frontend and replaces only the
  chrome.
