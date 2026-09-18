# `@janela/client`

Layer 6, client side: the connection, the mirror the view layer reads, and the
attention policy. It takes a `MessageTransport` and never learns whether the bytes
travel over a Unix socket via Tauri's IPC or over a WebSocket from a browser —
that seam is the only reason a web client is reachable without a rewrite, and why
this package imports no Tauri, no DOM and no React.

**The one rule: the daemon is the truth, this is a mirror.** Nothing computes state
it could ask for; nothing writes state it did not receive.

## `connection.ts`

- **Disconnection is normal** — the daemon may be restarting or briefly gone. The
  mirror keeps rendering with `isStale` set; terminals are unaffected because they
  are in the daemon.
- `connect()` resolves when the *first* attempt settles (connected, reconnecting or
  refused) and never rejects: a caller that awaited "connected" would block while
  the daemon is down. Idempotent while a loop is running, which is also what
  re-arms it after a deliberate `disconnect()`.
- Every mutation is a request with a reply, because fire-and-forget mutation is how
  a mirror silently diverges. Nothing is queued while disconnected: an action taken
  during a reconnect fails fast rather than landing minutes later.
- `sendInput` is the one message with no reply — the echo is the reply — and it
  carries bytes, because decoding input to UTF-8 and re-encoding corrupts every
  paste that was not valid UTF-8.
- `onOutput`'s `bytes` is a **view into the frame being decoded**, valid only for
  the duration of the call. Same rule as `TerminalBytes` in `@janela/pty`: a copy
  per repaint per client is a copy nobody asked for.
- The correlation id is assigned here, not by the caller: it is only meaningful to
  the peer that will answer it.
- Backoff is 250 ms doubling to a 10 s ceiling, with **no jitter** — one client per
  user per daemon means no thundering herd, and jitter would only make a test
  non-deterministic.
- `HANDSHAKE_DEADLINE_MS` is 5 s. Without it a listener that accepts and says
  nothing — a daemon mid-start, or anything squatting on the socket path — is a
  permanent "Connecting…" (#43). A local socket answers in about a millisecond, and
  a miss is one more failed attempt: **a silence is never a refusal**.
- A refusal is terminal and never triggers an automatic daemon restart, because
  that kills live terminals. The loop returns but the controller is still held, so
  recovery is the user calling `disconnect()` then `connect()`.
- The live transport carries a **generation tag**. Half a state update from a dead
  daemon merged into a fresh snapshot is exactly the corruption reconnect exists to
  avoid, and the old transport's late bytes must not reach the mirror.
- A failed write closes the transport rather than retrying: the pump is the one
  place that reconnects, and a second retry path would be a second policy to keep in
  agreement.
- Frames are handled one at a time, in order — the next read may not begin until the
  current frame is handled, because the payload is a view into the buffer.
- Output for a terminal the mirror *knows* but nobody watches is a detach race,
  logged at debug and dropped; re-attaching produces a full repaint. Output naming a
  terminal the mirror has never heard of is a protocol violation that closes the
  connection (`unknownTerminal` in `frame.ts`).
- The attention path is deliberately unlogged — not even a count. The signal carries
  a notification body, and a count would tempt someone to add the title (AGENTS.md
  § Non-negotiables 11).
- `RefusedAfterHandshake` is module-private: a caller has `ConnectionStatus` to read
  instead.
- The injected `silentLogger` is a local copy of `attention-policy.ts`'s. Both are
  four lines, and exporting one from the other would make a private default part of
  the package's surface.

## `stores.ts`

- `sessions` is the daemon's; **`selection` is not**. Selection is per-client state,
  so two clients attached to one daemon look at different sessions — the entire point
  of opening Janela on a phone while a Mac window is open. It is never sent, never
  received and never persisted.
- `apply` is the only way either collection changes. "Collapse this project" is a
  *request*; the collapse renders when the daemon confirms it.
- `mergeByID` returns the **same reference** when a partial names nothing, which is
  what lets a `useSyncExternalStore` consumer skip a re-render without comparing
  contents. An updated item keeps its position; a new one goes last, and the next
  full snapshot restores the daemon's order.
- `terminalStates` is **replaced** by a full snapshot rather than merged: a key
  absent from a full snapshot no longer exists, and keeping it would render a dead
  terminal as running forever.
- `isRunning` is derived only from reported state. A session whose terminals we have
  not heard about is not running, and rendering it as running would be a lie this
  client invented.
- `isStale` lives here rather than on the connection because staleness is a fact
  about the *mirror*: a full snapshot is what clears it, and one arrives only here.
  It starts true — an empty mirror predates every connection.
- `hasTerminal` is answered here because the stores are the only place that knows
  which terminals exist; a second table in the connection could drift.
- `neighbourOf`: when a full snapshot proves the selected session is gone, the one
  *after* it in the old order, else the one before, else the first left. Dropping the
  user into an empty pane because a different session was deleted is a bug they
  notice; so is jumping to the top of the sidebar when the neighbour is right there.
- `mostRecentlyActive` is the survival moment (#46): you quit Janela, your agent kept
  running, you came back. Selection is local so a relaunch starts with none, and the
  first frame that shows the surviving session must show it **selected**, not an
  empty pane beside a green dot. It reads `lastActiveAt` from the mirror — the
  daemon's field, which survives a daemon restart in the database — so it needs no new
  field, no wire message and no persistence. `Instant` is canonicalised, so lexical
  order is chronological order, and the comparison is strict so equal ages resolve to
  the daemon's own order.
- Every `apply` notifies, even one that changed nothing: the references are stable
  when nothing changed, so a consumer comparing them re-renders nothing, and the
  alternative is a dirty-check on every field.
- One listener set for both stores: one `apply` is one notification, and a view that
  reads sessions *and* projects must not see a half-applied update.
- `isLiveState` mirrors `@janela/terminal`'s, which is daemon-side and unreachable
  from here. Both exist because `isLive` in `@janela/core` is still a seam; when it
  lands, both call it.

## `attention-policy.ts`

**Why the decision is in the client.** The daemon owns the emulator, so it is what
sees a BEL — but it has no idea which terminal the user is looking at, whether any
window is frontmost, or whether a human is present. So the daemon emits a *fact* and
this decides what it means; shipping focus state to the daemon would be a chatty
protocol serving no one.

The rules, stated once so the implementation cannot drift: already delivered → no;
the user is looking straight at it → no; a bare BEL → whatever `notifiesOnBell` says,
because programs ring it for reasons the user has not agreed are important; an
OSC 9 / OSC 777 → deliver, because the program asked by name and that is consent; a
finished prompt → deliver only when it failed *and* ran longer than
`LONG_RUNNING_THRESHOLD_SECONDS` (10 s), since short commands failing is normal work;
a reported agent activity → `waiting` asks `notifiesWhenAgentWaits`, `finished` asks
`notifiesWhenAgentFinishes` for either outcome, and `working` is never worth
interrupting for.

**`AttentionPreferences` is the user's answer, read per signal.** `routeAttention`
takes `preferences: () => AttentionPreferences` and calls it for every signal rather
than capturing a value, so a switch flipped in Settings is in force for the next
signal with no restart and no subscription. It is three booleans and no more: what
the user is asked in Settings is exactly what the policy branches on, so there is no
mapping layer to get wrong. Which of the three a signal consults is the policy's
call, not the caller's — the app supplies the answers, never the verdict.

- `notifiesOnBell` was, until agent activity landed, a *dead* setting: the switch
  saved and reloaded, and `isWorthInterrupting` returned `false` for a bell whatever
  it held. It is now what it always claimed to be. The bell still badges the sidebar
  when it is off — that channel needs no permission.
- `notifiesWhenAgentFinishes` and `notifiesWhenAgentWaits` default to **on**, unlike
  the bell: an agent reports activity only because the user installed its integration,
  which is the consent a bare BEL lacks. The sidebar shows both states whatever the
  preferences say; these decide only whether Janela also interrupts.
- `working` is a state, never a signal. The daemon does not raise it (see
  `@janela/daemon`'s relay), and the policy refuses it a second time here so a future
  caller that does raise one cannot notify a user every time an agent picks up a tool.
- The coalescing window is 5 s: a build that rings the bell four times is one
  notification, and the alternative trains users to dismiss without reading. The
  boundary is inclusive.
- Time is compared daemon-to-daemon (`occurredAt`), so two clients with two clocks
  agree about the window and the policy needs no clock of its own to be testable. An
  unparseable stamp expires immediately — a `NaN` comparison is false for every
  operator, so nothing else would ever remove that entry and it would coalesce
  everything for that terminal forever.
- The delivered table holds ids and a number, never the signal and never
  `kind.body`/`kind.title`: a policy that held notification text would leak it the
  first time someone logged its state.
- "The user is looking at it" is deliberately **not** recorded: if they switch away
  and it rings again, that is news.
- `routeAttention` never touches the stores. In-app attention is
  `TerminalState.needsAttention`, which the daemon computes and pushes — already on
  screen before this runs, and unaffected by what the policy returns. The sidebar is
  the primary channel and needs no permission; a notification is the secondary,
  best-effort one.
- A signal for a terminal this mirror cannot name is a notification that would land
  the user nowhere, so it is dropped rather than delivered.
- A session leaving the mirror **withdraws first, then forgets**: `forgetSession` is
  bookkeeping that cannot fail, while a notification left on screen for a session
  that no longer exists is a bug the user sees.
- An adapter's rejection is logged as the error's *name* only and dropped. It reaches
  us inside the connection's read pump, where an unhandled rejection would take the
  pump with it — a notification that failed to post must not cost the user their
  terminal output — and a notification API failure can quote the content it failed to
  post.
- `AttentionDelivering` is implemented in `apps/desktop`: an app-level capability, so
  this package stays testable and browser-reachable without one.

## `test-fakes.ts`

Not exported from `index.ts`; nothing ships them. The daemon has fakes of the same
shape and this file deliberately does not import them — a client package may not
import a daemon package, and copying two dozen lines is the cheaper half of that
rule.

**Byte-level on purpose.** The daemon's own fake transport hands over whole `Frame`s,
which is right for testing fan-out and wrong here: the requirement is that a daemon
killed *mid-frame* cannot corrupt the connection that replaces it. A frame-level fake
cannot express half a frame, so this one carries `Uint8Array` chunks and runs the same
`frameDecoder()` the real socket transport runs — including `end()` on EOF, which is
what turns a half-written frame into a `truncated` error rather than silence.

- The channel is buffered rather than a rendezvous: a test needs to push half a frame
  whether or not anyone is parked on `take()`.
- `keepsDeliveringAfterClose` models a real transport — the desktop bridge relays
  frames already in flight when the client closes its end. What must not happen is
  one of them reaching the mirror, which is what the generation tag prevents.
- The delay fake resolves on a microtask: the schedule is asserted from `calls`, and a
  test that waited 10 s to prove a 10 s cap would be a bad test.
- `until()` polls a condition rather than sleeping, so a failure points at the
  condition rather than a guessed duration.
