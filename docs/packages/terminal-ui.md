# `@janela/terminal-ui`

Layer 8, client side: the surface that draws. The second and last package allowed
to name a terminal library — `@janela/terminal` names the daemon-side emulator,
this one names the renderer, and `scripts/layers.ts` enforces both.

## `terminal-rendering.ts`

The two halves of the terminal seam are no longer the same library — the daemon runs
a headless emulator, the client a renderer — which is possible only because the
protocol ships escape sequences rather than grids. The renderer is fed them exactly
as a real terminal is fed them from a pty, so this type needs no grid diff, no custom
wire format, and no knowledge that a daemon exists.

- `viewport` is a **vote**, not a command: the daemon sizes the PTY to the
  smallest attached viewport.
- `onInput` carries bytes, not a string. A surface that hands up decoded text has
  already lost the difference between a paste of invalid UTF-8 and a paste of
  replacement characters. Janela implements no key bindings the terminal should
  own (AGENTS.md § Non-negotiables 4); splits and tabs use `⌘` chords so this
  stays true.
- Selection is client-side: two clients attached to one terminal select
  independently, because a selection is something a person is doing, not a
  property of the process.
- `paste` goes through the emulator rather than onto the wire, because that is
  what knows whether the program turned bracketed paste on. A multi-line paste
  sent raw to a shell runs every line; sent bracketed, the shell gets one block
  to edit.
- `clearViewport` is local: the daemon's scrollback is untouched, which is why it
  is safe to offer to one client while another is attached.

## `coalesce.ts`

A resize vote crosses two process boundaries and ends in a `TIOCSWINSZ` with a
`SIGWINCH` behind it, so one per pointer move is a storm and one per frame is the
budget (`docs/performance.md` § Interaction budgets).

- Only the newest value is held: the no-unbounded-buffer rule (AGENTS.md
  § Non-negotiables 9) as a queue of size one, where the bound is a consequence
  of the shape rather than a check someone has to remember.
- The pending value is held in a one-element box so that `undefined` is a value
  that can be coalesced rather than a sentinel for "nothing pending".
- It deliberately does **not** deduplicate equal consecutive values. Whether two
  values are equal is a question about the value; the one caller that cares
  (`createSurfaceController`) compares grid sizes itself.
- `FrameScheduler` is injected so coalescing is testable without a browser, and
  returns a handle rather than a token object because that is what
  `requestAnimationFrame` returns. `animationFrameScheduler` is the only place in
  the package that names a browser global.
- `cancel` drops the pending value and cancels the frame; nothing is delivered
  afterwards, which is what makes it safe to call from a React cleanup.

## `grid-fit.ts`

A terminal grid is whole cells or it is a lie: half a column is a column the
program will write into and the user cannot read. The box is divided, floored,
and the remainder left visible as a letterbox — never scaled, because scaling a
monospace grid is how text stops being crisp.

- `MINIMUM_GRID` is 2×1 because xterm clamps a `resize` to that and then holds
  it; proposing less would make the vote and the held grid disagree. The
  daemon-side emulator follows the same rule
  (`packages/terminal/src/headless-emulator.ts`).
- A degenerate cell size — zero, negative or non-finite, which is what a
  measurement taken before the font loads looks like — yields `MINIMUM_GRID`
  rather than an infinity, because the caller's next move is to send it to the
  daemon.
- `letterboxMargins` is non-zero in two normal situations: rounding, because a
  box is rarely a whole number of cells; and a grid smaller than this surface
  could show, because another attached client is smaller. It is never negative —
  a grid larger than the box overflows and is clipped, which is the honest
  rendering of "somebody else is smaller than you".
- The 1016×720 fixture in `grid-fit.test.ts` is measured from the app rather than
  chosen, and its 40×12 grid is what a second, smaller client held. Before
  protocol 5 the second argument was a number no call site could produce, which
  is how a tested helper passed for a shipped feature — `docs/survival-proof.md`
  § D2.

## `surface-controller.ts`

It holds no React and no DOM, which is what makes it testable — the component needs
a DOM and this needs nothing.

- **The one copy.** `DaemonConnection.onOutput` hands up a view into the frame
  being decoded, valid only for the duration of the call; xterm's `write()`
  queues its argument to be parsed later. Those two facts are incompatible
  without a copy, and it happens here — once, rather than defensively in both
  places or in neither.
- `onViewportChange` is coalesced to at most one call per frame and never called
  twice with the same size: the parent forwards it as a `resize` request, so a
  repeat would be a round trip and a `SIGWINCH` that changed nothing.
- `dispose` cancels the pending frame and clears the renderer's callbacks but
  does **not** dispose the renderer: the component owns its lifetime, and a
  controller that disposed it would make the two orderings mean different things.

## `xterm-rendering.ts`

The only module in the client half that names a renderer library. It spawns nothing
— the library will happily start a process, and that is the daemon's job —
interprets no input, and binds no keys.

- `CLIENT_SCROLLBACK_LINES` is the documented bound required by AGENTS.md
  § Non-negotiables 9. It is a local echo of what this client has seen; the
  authoritative scrollback is the daemon's, and an attach replies with a full
  repaint, so losing the oldest lines here loses nothing that cannot be asked for
  again.
- **Background.** xterm fills the cells it owns and defaults to black, while the
  letterbox deliberately shows the container through; unless the two agree, every
  pane is drawn with a frame around it. The colour is read from the computed style
  rather than from a token name, because the value has four appearance variants
  (`packages/design/src/tokens.ts` § COLOR) and which one applies is a fact about
  the document. The theme is set in the constructor because it decides the glyph
  atlas built on `open()`; `syncBackground` is wired to the two media queries that
  can change it rather than polled, because a theme swap rebuilds that atlas.
  `xterm.css` paints `.xterm-viewport` `#000` for an opaque macOS scrollbar
  backing — the one colour that does not come from the theme — so the scroller
  follows the same value and stays opaque.
- **Letterbox.** The grid is drawn into its own element sized to whole cells,
  inside a padded container that paints the background; whatever the grid does not
  cover shows the container through. The cell metric comes from `.xterm-screen`,
  which the renderer sizes to `cols × rows` — no private `_core` access and no
  font measurement of our own to disagree with xterm's. It is undefined until the
  first paint, which is also "before the font has loaded"; the next observer tick
  retries and `viewport` stays whatever xterm holds until then.
- `lastCell` exists so the daemon-driven path letterboxes from the same metric the
  grid was derived from. Measuring again would also work today —`measureCell()`
  inside the parse path returned 8.803 px against 8.800, because the render service
  sizes `.xterm-screen` synchronously inside `resize()` — but that is an ordering
  inside the library, and nothing re-measures until the container moves, so a wrong
  margin would simply stay.
- `viewport` reports what xterm holds, not what was asked for: xterm clamps, and a
  vote that disagreed with the grid would put the negotiated PTY size out of step.
- `feed` does not copy. `write()` queues its argument, so a caller holding a
  transient view must copy first — `createSurfaceController` is where that happens.
- **`CSI 8 ; rows ; cols t`**, the daemon's negotiated grid (protocol 5), arrives
  in the output stream because it belongs to the same ordered bytes it describes.
  Acting on it is this module's job and not the library's: `@xterm/xterm` 6.0.0
  gates parameter 8 on `windowOptions.setWinSizeChars` and then implements no case
  for it, so without the handler the sequence is parsed and dropped — the whole of
  defect D2. Every other parameter is handed back to the library (18 answers a
  size query, 22 and 23 push and pop a title). The handler deliberately does not
  call `onViewportChange`, and `terminal.onResize` stays unwired for the same
  reason: this client's vote is what it measured, and a minimum echoed back as a
  proposal can never grow again.
- A CSI parameter can be a sub-parameter list rather than a number, so the handler
  rejects array parameters before treating them as a grid.
- WebGL is attempted and its failure is expected, not exceptional: the canvas
  renderer is the fallback and it is correct, only slower, and a machine without a
  WebGL context must not lose its terminal over it. Context loss drops back to the
  same fallback.
- `onBinary` is the non-UTF-8 paste path and carries one byte per character;
  decoding it to text and re-encoding would turn an invalid-UTF-8 paste into
  replacement characters.
- **Screen readers.** With `screenReaderMode` off — the default, because it costs
  on the hot path — xterm paints to a canvas and exposes only a focusable textarea:
  a screen reader gets the surface's accessible name and the echo of typing, but
  not the output content. With it on, xterm maintains off-screen live regions that
  announce new lines. Neither mode offers cell-level navigation or a
  braille-friendly buffer. It is a prop rather than a constant so settings can turn
  it on; nothing here decides for the user.

## `terminal-surface.tsx`

- **No output in state.** Bytes arrive through the imperative handle and go
  straight into the renderer. A component that put terminal output in state would
  re-render React sixty times a second and turn the cheapest path in the client
  into the most expensive one (`docs/performance.md` § Throughput). The component
  renders one empty `<div>` and never re-renders because of anything the terminal
  did.
- Handlers are read through refs so a parent re-rendering with fresh closures does
  not tear down a terminal and lose its scrollback.
- The renderer is created and disposed in pairs, which makes StrictMode's double
  mount a non-event rather than a leaked emulator.
- The container is a labelled `<section>` rather than a bare div: xterm builds its
  own focusable textarea inside it, and the label is what a screen reader reads
  before it.
- `prefers-reduced-motion` disables the cursor blink. `matchMedia` is read off
  `globalThis` and may be absent, which is what a non-browser test environment
  looks like.

## `xterm-css.d.ts`

xterm ships its own stylesheet and its renderer does not work without it. The
import lives in `xterm-rendering.ts` — the module that already owns the library —
rather than in the app's global stylesheet, so the dependency and the thing that
needs it stay in the same package. TypeScript has no notion of a stylesheet
module, hence the declaration.

## `test-fakes.ts`

Not exported from `index.ts`. The frame clock is faked because coalescing is a
claim about *when* something is delivered, and a real `requestAnimationFrame`
turns that claim into a race. The renderer is faked because what this package does
to a renderer — copy before feeding, dedupe before voting, clear the callbacks on
dispose — is exactly what a real xterm would hide. `FakeRendering.fed` holds every
chunk by reference, because identity is what the copy test asserts;
`surface-controller.test.ts` fills the source buffer after the handler returns,
which is what the connection does with the frame buffer and what xterm's
asynchronous write queue would otherwise read.
