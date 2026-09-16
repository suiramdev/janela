# `apps/gateway`

Layer 7, daemon side: `janela-gateway`, the browser's shell. A browser cannot open a
Unix socket, so this Bun process opens it on the browser's behalf and relays bytes
between one WebSocket and one `janelad` connection — the exact job `bridge.rs` does
for the WebView, with a network on the outside instead of Tauri IPC. It also serves
the built browser client. It never reads a frame, never holds a daemon connection
of its own, and never binds anything but `127.0.0.1`
([`architecture.md`](../architecture.md) § The gateway).

Run it with `bun run gateway` after `bun run web:build`, or let `bun run web` start
it beside a Vite dev server. Publish it to your other devices with
`tailscale serve --bg 7411`: Tailscale terminates TLS on the tailnet and vouches
for who is on the other end, and the page's clipboard works because the origin is
then a secure context.

## `src/relay.ts` — one WebSocket, one socket

`openRelay(peer, options)` connects to the daemon's socket and pipes in both
directions. It is independent of `Bun.serve` so its tests run against a real
`net.createServer` on a temporary path, which is the only way to prove pause and
resume rather than assume them.

- **Daemon → browser** is bounded by the WebSocket's own buffer. `peer.send` answers
  Bun's convention — `-1` means "queued, back-pressured", `0` means "dropped, the
  peer is gone" — and the relay **pauses the Unix socket** on `-1` and resumes it in
  `drained()`. From the daemon's side that is a client that stopped reading: its
  per-client output queue drops oldest and re-arms a full repaint, exactly as for a
  slow app. `backpressureLimit` is `TERMINAL_WATER_MARKS.highWater` (4 MiB), the
  same number the PTY reader uses, and `closeOnBackpressureLimit` is off because the
  pause is the bound.
- **Browser → daemon** is bounded by `INPUT_BACKLOG_LIMIT_BYTES` (1 MiB) on the
  socket's `writableLength`: a browser typing faster than the daemon reads is a
  daemon that has stalled, and the relay closes the WebSocket with `1013` rather
  than buffer without bound. `node:net` queues writes issued before `connect`
  completes, so the first frames need no separate holding area.
- Every close has one code and one reason, sent once: `1000 daemon closed` when the
  daemon ends the connection, `1011 daemon unreachable` when the socket could not
  be opened, `1011 daemon failed` when it died afterwards, `1013 daemon not
  draining` for the input bound, `1003 binary only` for a text frame (the protocol
  is bytes, and a text frame is a client that is not one of ours). The relay's own
  `close()` — the browser went away — destroys the socket and reports nothing.
- Never logged: bytes. The debug records carry a close code or a byte *count*.

## `src/main.ts` — `Bun.serve`

- `/ws` upgrades only when `isAllowedOrigin` agrees; anything else on that path is
  `403`. Other paths are `staticResponse`; methods other than `GET`/`HEAD` are
  `405`.
- `maxPayloadLength` is `FRAME_HEADER_LENGTH + MAXIMUM_PAYLOAD_LENGTH` — the one
  place the gateway knows the protocol's shape, and only as a size.
  `perMessageDeflate` is off: terminal repaints are small and already coalesced,
  and a compressor on the keystroke path is latency for nothing.
- `SIGINT`/`SIGTERM` stop the server; every open relay's socket is destroyed with
  it, which the daemon sees as clients leaving. Terminals are unaffected — that is
  the point of the split.

## `src/http.ts` — origin and static files

- `isAllowedOrigin(origin, host)`: a request with **no** `Origin` is a non-browser
  client (a probe, a phone app) and is allowed; a request with one must name the
  same host the page was served from — which is what a page at
  `http://localhost:1421`, `http://127.0.0.1:7411` or `https://mac.tail.ts.net`
  sends, and what a page on any other site cannot. Tailscale Serve forwards the
  original `Host`, and Vite's dev proxy does not rewrite it, so no allow-list is
  needed. This is the cross-site defence; it is not authentication.
- `safePathname` decodes once, refuses `..` segments and NUL, and maps `/` to
  `index.html`; anything not found under the web root is answered with
  `index.html` (the client has no routes, but a reload on any path must still land
  in the app). A `..` that URL parsing has already normalised away lands inside the
  root by construction. No web root, or no `index.html` in it, is a `503` that
  says which command to run.

## `src/kickstart.ts` — starting a daemon nobody is running

An installed `janelad` has no `RunAtLoad`: nothing runs until a client cannot
connect. On the Mac that client is the app, whose Rust shell runs
`launchctl kickstart`. Remotely, the gateway is the only client on the machine,
so it does the same — `launchctl kickstart gui/<uid>/sh.janela.janelad`, at most
once per `KICKSTART_THROTTLE_MS` (1 s), because the browser retries with backoff
and asking launchd to start a service it is already starting achieves a process
spawn per attempt. A development checkout has no service and the call fails
quietly at `debug`; the failure the user sees is the connection not coming up,
and `bun run web` starts a daemon before that can happen.

## `src/arguments.ts`

`--port <n>` (default `7411`) and `--web-root <dir>`; nothing else, and an unknown
argument exits 2 with the usage. There is no `--listen`: the gateway is loopback
by design, and the address that reaches other devices is Tailscale's.

## What this does not do, on purpose

- **No authentication of its own.** The loopback interface is shared by every
  account on the Mac, so while the gateway runs another local user can reach it —
  the Unix socket alone refuses them. Accepted for now and written down in
  `architecture.md`; `Hello.credential` is the slot a gateway-minted bearer token
  would use if that changes.
- **No launchd plist.** The user starts it, and it stops when they do.
- **No frame parsing, no reconnection.** Both belong to the two ends.
