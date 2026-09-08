# 0017. launchd owns the daemon's lifecycle, via `SMAppService`

- **Status:** Accepted
- **Date:** 2026-08-26
- **Amended:** 2026-08-21 by [0020](0020-bun-daemon-runtime.md) — `janelad` is a
  compiled Bun binary shipped as a Tauri sidecar, and registration happens from the
  Tauri shell rather than from SwiftUI. **The lifecycle decision is unchanged**:
  launchd owns it, socket activation starts it, it outlives clients and exits when
  idle. One implementation detail got harder and is called out below.
- **Amended:** 2026-09-08 by #39 (the sidecar bundle) — **the plist is static, sealed
  into the bundle at build time, and declares no socket**. Two things forced it, and
  the lifecycle decision itself is unchanged: launchd owns the daemon, `KeepAlive`
  restarts it after a crash, it outlives clients and exits when idle.

  1. *A plist generated at registration time cannot work.* `smd` runs a static code
     signature check on the whole bundle before it will load the agent, so a file
     written into `Contents/Library/LaunchAgents/` after signing breaks the seal and
     registration fails with `errSecCSBadResource` (-67054) — on every signed
     install, and never in CI. The plist therefore ships as a build input
     (`apps/desktop/src-tauri/launchd/sh.janela.janelad.plist`, placed by
     `bundle.macOS.files`) and `scripts/verify-bundle.ts` asserts it is in the
     signature's sealed resources.
  2. *Socket activation is given up deliberately, and this is the ADR saying so.*
     The `Sockets` block below is void. An absolute `SockPathName` cannot be static;
     the alternative that would have been — launchd's `SecureSocketWithKey`, which
     publishes the path as an environment variable — publishes it only into the GUI
     login session's launchd domain, where a CLI over ssh cannot read it, and it ties
     the address to launchd, which [0023](0023-macos-first-portable.md) forbids.
     **The daemon binds `~/.janela/run/janelad.sock` itself**, in a 0700 directory it
     owns and checks (`packages/daemon/src/endpoint.ts`), which is what the protocol
     and the future CLI already assume. `launch_activate_socket` and the second FFI
     surface it would have needed are not required after all.

  What replaces first-connection start-up: the plist has no `RunAtLoad`, so
  registering does not start anything, and a client that cannot connect runs
  `launchctl kickstart gui/<uid>/sh.janela.janelad` and retries. A user who never
  opens Janela still never has a process — the property socket activation was chosen
  for survives; only the trigger moved from launchd into the client. Registration
  itself is #30.

## Context

[0015](0015-daemon-owned-sessions.md) introduced `janelad`. Something has to start
it, restart it when it crashes, stop it when the user says so, and make it visible
enough that a background process holding the user's shells is not a surprise.

The options are not equally serious.

**The app forks it and disowns it.** Works in an afternoon, needs no registration,
and nothing appears in System Settings. That last part is the problem: an invisible
background process that spawns other processes is precisely what a user should be
suspicious of, and there is nothing to restart it after a crash. It also dies at
logout, so "my agent was still running yesterday" fails.

**A launchd plist the user installs.** Explicit, scriptable, and normal for a CLI
tool. As the only path for a GUI app it is a setup step and a support burden, and
uninstalling Janela leaves a plist behind pointing at a binary that is gone.

**`SMAppService`.** Since macOS 13, an app can register a LaunchAgent that ships
*inside its own bundle*. launchd then owns the lifecycle, and the user sees the
item in System Settings › General › Login Items & Extensions, where they can turn
it off. Registration is one call, unregistration is one call, and deleting the app
takes the plist with it.

There is a second question layered on top: **when should it run?** Always-on is
simple and wrong — a user who has not opened Janela in a week should not have a
process running. Purely on-demand is wrong too, because the entire point is that it
outlives its clients.

## Decision

**A LaunchAgent inside the app bundle, registered with `SMAppService`, started by
launchd on demand through socket activation.**

```text
Janela.app/Contents/
  MacOS/Janela                              the app
  Library/LaunchAgents/sh.janela.janelad.plist
  Resources/janelad                         the daemon binary
```

> Two corrections from the 2026-09-08 amendment, kept here rather than rewritten so
> the original reasoning stays readable: the daemon is at **`MacOS/janelad`** (Tauri's
> bundler signs `Contents/MacOS`; a Mach-O under `Resources` is data), and the
> `Sockets` block below is **void** — there is no socket activation.

`janelad` is one file. Its runtime, the database client, the emulator and the PTY
library are all embedded ([0020](0020-bun-daemon-runtime.md),
[0021](0021-pty-native-layer.md)), so the bundle layout above is exactly as this ADR
first described it rather than a binary plus a scatter of supporting files.

The plist declares the socket rather than a run-at-load flag:

```xml
<key>Sockets</key>
<dict>
  <key>Listener</key>
  <dict>
    <key>SockPathName</key>
    <string>/Users/…/.janela/run/janelad.sock</string>
    <key>SockPathMode</key>
    <integer>384</integer>            <!-- 0600 -->
  </dict>
</dict>
<key>KeepAlive</key>
<dict><key>SuccessfulExit</key><false/></dict>
```

- **launchd creates and owns the socket**, and hands the daemon its file descriptor
  via `launch_activate_socket`. The daemon never binds a path itself.

  **This is the one place the runtime change makes things harder.**
  `launch_activate_socket` is a C function, and `bun:ffi` is deliberately gated to
  `@janela/pty` so Janela has exactly one FFI surface. The expected resolution is to
  add one export to that existing library — it is already built, signed and located —
  rather than opening a second surface. The alternative, binding the path ourselves,
  would trade away socket activation and with it the property that a user who never
  opens Janela never has a process running. That is a decision this ADR made
  deliberately, so it must not be given up silently. Recorded as a `TODO` in
  `apps/daemon/src/main.ts` with both options stated.
- **First connection starts the daemon.** A user who never opens Janela never has a
  process.
- **`KeepAlive`/`SuccessfulExit=false` restarts it after a crash**, but not after
  it exits deliberately.

### When the daemon exits

It is not immortal, and it is not tied to any client:

| Condition | Behaviour |
| --- | --- |
| Last client disconnects, live terminals exist | **Stay.** This is the whole feature. |
| Last client disconnects, no live terminals | Exit after an idle grace period (5 minutes). |
| User quits the app | Nothing. The daemon does not care which clients exist. |
| User chooses "Stop Background Service" | Terminate terminals, then exit deliberately, so `KeepAlive` does not resurrect it. |
| Crash | launchd restarts it. Terminals are gone; sessions are restored from the database as `.idle`. |
| Logout / shutdown | launchd sends `SIGTERM`; the daemon hangs up its PTYs and exits. |

The idle-exit rule is what keeps this from being an always-on service. The grace
period exists so that quitting and reopening the app does not tear down and rebuild
the world.

### Registration

The app registers on first launch and reports failure honestly:

Registration is `SMAppService.agent(plistName:)` plus `register()`, returning
enabled, requires-approval, or not-found. It is called from the Tauri shell, which is
the only part of the client that talks to system frameworks
([0024](0024-tauri-client-shell.md)).

- `requiresApproval` means the user has to enable it in System Settings. The app
  says so plainly and links there, and **runs in a degraded in-app mode** until
  then, with terminals that die when the app quits and a visible explanation.
  Refusing to work at all would be worse.
- Unregistration on uninstall is the user deleting the app; macOS removes the
  registration. A "Stop and unregister" action exists in Settings for the
  fastidious.

### Version skew and upgrades

A new app with an old daemon still running is the normal case after an update, and
the daemon must **not** be killed automatically — it holds live work.

1. The app connects and the handshake ([0016](0016-daemon-protocol.md)) reports
   incompatibility.
2. The app shows what is running: *"3 sessions, 2 with live terminals."*
3. The user chooses when to restart. Only then does the daemon terminate.

The daemon never self-updates and never re-execs while it owns a PTY. There is a
tempting trick — pass the PTY descriptors through an exec — and it is out of scope
because it makes upgrade a code path that can corrupt a running agent's terminal.

### TCC attribution

The daemon is its own responsible process, so a permission prompt it triggers is
attributed to `janelad`, not to Janela. A dialog naming an unfamiliar background
binary is bad.

The mitigation is a rule, not a technology: **the app performs file selection; the
daemon is handed paths.** Adding a project goes through an `NSOpenPanel` in the app,
which is what creates the user's intent and the TCC grant. The daemon never
discovers directories on its own, never scans the home directory, and never touches
a path no client gave it.

## Consequences

**Good.** The user can see it and stop it, in the place macOS has taught them to
look. That is worth more than any amount of documentation about what the daemon
does.

**Good.** launchd does the hard parts: crash restart, socket activation, teardown at
logout, and not running when nothing needs it.

**Good.** Uninstall is dragging the app to the Trash. Nothing is left in
`~/Library/LaunchAgents`.

**Bad.** `SMAppService` is macOS 13+. Our floor is macOS 15
([0002](0002-macos-deployment-target.md)), so this costs nothing today — but it is
one more reason the floor cannot go down.

**Bad.** The approval flow is a real onboarding step we do not control, and some
users will land in "requiresApproval" without understanding why. The degraded mode
is what stops that being fatal, and it is extra code that must actually work rather
than be a stub.

**Bad.** Development is more awkward. Running the app means "build both, and make
sure the daemon launchd starts is the one you just built", which is a genuine footgun
when an old daemon is still resident. `bun run daemon:restart` and
`bun run daemon:status` are the mitigations, along with a version banner in the app's
about panel.

**Bad.** Two binaries in one bundle, both signed and notarized, and the plist has to
point at the right path inside the bundle. Getting this wrong fails at install time
rather than at build time. See [0008](0008-sandboxing-and-distribution.md). CI
compiles the sidecar and runs it from an empty directory on every push, which catches
the class of failure where the daemon silently depends on something beside it — and
since the 2026-09-08 amendment it also bundles, ad-hoc signs and runs
`apps/desktop/scripts/verify-bundle.ts`, which is what turns "fails at install time"
into "fails in CI".

**Bad, and now void.** *An absolute path in the plist's `SockPathName` means the
plist is user-specific and cannot be a static resource. It is generated at
registration time, which is a small amount of code doing something slightly unusual.*
That code cannot exist: a plist written into a signed bundle fails `smd`'s static
signature check (`errSecCSBadResource`). The plist is static and carries no socket at
all; the daemon binds `~/.janela/run/janelad.sock` itself and clients start it with
`launchctl kickstart`. See the 2026-09-08 amendment.

## Alternatives considered

**App-spawned detached child.** Fastest to build. Rejected on visibility, crash
recovery, and logout survival — three properties that are the point of the daemon.

**Hand-installed launchd plist.** Fine for a CLI-first tool. Rejected as a GUI app's
only path; it remains available for people who want to run `janelad` themselves,
and the daemon does not care how it was started.

**`RunAtLoad` with `KeepAlive: true`.** Always running, simplest lifecycle. Rejected
because a developer tool that runs a process forever on a machine where it has not
been opened in a month has not earned that.

**A login item that launches the app itself, headless.** One binary, no plist, and
the app could run without a window. Rejected: it conflates "the UI" with "the
service" exactly when the point is to separate them, and a GUI app running
invisibly is a worse citizen than a daemon that says what it is.

**No daemon at logout: persist and restore.** Rather than surviving, write enough
state to recreate sessions at next login. Rejected as a different (and weaker)
promise — a re-created shell is not the shell your agent was running in — though it
is precisely what happens after a crash or a reboot, where nothing better exists.

## Revisit when

- Apple changes `SMAppService` or the Login Items UI in a way that alters the
  approval flow.
- The idle grace period turns out to be wrong in either direction; it is a number
  chosen by argument, not by measurement, and it should become the latter.
- Someone genuinely needs sessions to survive a reboot, which is a larger promise
  than this ADR makes.
