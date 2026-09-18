# `apps/web`

Layer 10, client side: the browser client. The same `MainWindow`, `SettingsScreen`
and stores as the desktop app, composed over a WebSocket to the gateway
([`gateway.md`](gateway.md)) instead of the Tauri bridge, with no macOS port
behind any of it. Its `ClientEnvironment.local` is `undefined`, which is the whole
difference the views see.

`bun run web` serves it from Vite at `http://localhost:1421` (the dev server proxies
`/ws` to the gateway); `bun run web:build` writes `dist/`, which the gateway serves.

## `src/adapters/transport.ts` — the WebSocket transport

The third `MessageTransport`, and the file `docs/packages/desktop.md` promised a
browser client would replace `adapters/transport.ts` with. The wire is the same
length-prefixed frames the socket carries; the gateway moves them unread, so this
file drives the same `frameDecoder` over whatever chunks arrive and sends
`encodeFrame(frame)` as one binary message.

- `openWebSocketTransport` resolves on `open` and rejects with an error **named**
  `daemon-unavailable` if the socket closes first — the same name the Tauri bridge
  reports, so `@janela/client`'s log line reads the same on both.
- **Incoming is bounded** at `INCOMING_MESSAGE_CAPACITY` (64 messages) in a
  `boundedQueue`, checked *before* the push so the `block` policy never parks a
  browser event handler. A full queue is a consumer that stopped pulling frames,
  and the transport closes with `1013` and fails `incoming()` with
  `transport-stalled` — the browser's `bridge-stalled`. Sixty-four is a second of
  repaints at frame rate.
- **Outgoing is bounded** by `SEND_BACKLOG_LIMIT_BYTES` (1 MiB) on
  `bufferedAmount`; past it, `send` closes the socket and rejects the same way.
  Keystrokes and control frames are small, so this only fires when the gateway is
  gone and the browser has not noticed yet.
- A text message is a peer that is not a gateway: `1003 not-binary`. A clean close
  ends `incoming()`; an unclean one throws `socket-failed`; a clean close halfway
  through a frame surfaces as the decoder's own `TruncatedFrame`, exactly as on the
  desktop.
- `webSocketURL(location)` follows the page's scheme (`wss:` under `https:`) and
  host, so the same bundle works at `localhost`, at `127.0.0.1:7411`, and behind
  `tailscale serve`.
- The socket is created by an injected factory (`WebSocketLike`, structurally the
  DOM `WebSocket`), so the tests drive it with a fake and no server.

## `src/environment.ts` and `src/main.tsx`

`webEnvironment()` is `liveEnvironment()` without the parts a browser cannot
have: the stores, one `createConnection` named `janela-web`, and `start()`. No
attention routing — a browser page delivers no OS notification in this step, and
the sidebar's attention state still arrives with the mirror. `main.tsx` fills the
`ClientEnvironment` from `@janela/ui`'s web-platform ports (`browserClipboard`,
`localStorageSettings`, `keyboardCommandSource` over
`commandsWithShortcuts(view.settings, false)` so a saved override is what the keys
answer to, held while a folder picker is on screen and standing aside while the
Shortcuts pane records), `NO_WINDOW_CONTROLS` because no title bar
overlays a browser page, `local: undefined`, and `createDirectoryPickerQueue()` for
`directories` — with `DirectoryPickerHost` mounted beside `MainWindow`, so Open
Folder…, Add Project… and the session sheet's Choose… open the Finder-style column
view over the daemon's `listDirectory` ([`ui.md`](ui.md) § directory-browser). The
log sink is the console, level for level — the only `console.*` in the client, and
the one place it is the right tool.

## What a browser user does not get

- **Reveal in Finder, Open in Terminal, Stop the Daemon…** are `localOnly`
  commands: absent from the palette, unclaimed by the keyboard, no-ops in
  dispatch. Add Project… and Open Folder… are not: the folder is chosen in the
  app's own column view, fed by the daemon one folder at a time.
- **The background-service controls, the status item and the restart-on-version-skew
  button** need `launchctl` on the Mac; the section and the button are not rendered,
  and a tab has no menu bar to put an item in.
- **Browser-reserved chords.** ⌘W, ⌘N, ⌘T, ⌘Q and ⌘, never reach a page in Chrome
  or Safari. The palette (⌘⇧P) lists every available command, so nothing is
  unreachable, only slower; an installed (standalone) web app hands most of them
  back.
- **OS notifications** — deliberately not in this step.
