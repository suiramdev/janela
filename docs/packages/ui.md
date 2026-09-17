# `@janela/ui`

Layer 9, client side. It reaches no further than `@janela/client`, and git, PTY,
the database, the emulator and the brain are not linked — **the client cannot spawn
a process**: the capability is not present, not merely discouraged.

Every request a view makes is best-effort: nothing is queued by design, so one
issued while the daemon is away rejects and the stale mirror keeps rendering
(AGENTS.md § Non-negotiables 8). Callers swallow the rejection — this package has
no logger and wants none, because a view that logged every failed request during a
reconnect would write the user's session list into the system log.

## Structure

`src/index.ts` is the **package** public API, not an FSD layer index: `apps/desktop`
reaches this package only through that list, so a view the app suddenly needs is a
line added there on purpose.

The two pages never import each other — the settings screen arrives in the main
window through a `renderSettings` slot the composition root supplies.
`shared/model` sits below both because the app layer *builds* it; it holds
presentation state and ports, never product rules, and a rule about the user's data
lives in the page that enforces it.

### `steiger.config.ts`

Measured behaviour behind its shape
([`../research/steiger-notes.md`](../research/steiger-notes.md)):

- It lives in `packages/ui/` because Steiger loads its config through cosmiconfig
  with no options, defaulting `searchStrategy` to `"none"`: only the cwd is
  searched, a config one directory up is silently ignored, and Steiger falls back to
  the recommended ruleset without saying so. `lint:fsd` guarantees config and cwd
  are the same directory.
- `src` is passed explicitly, because a missing or mistyped root opens an
  interactive folder picker instead of failing.
- There is deliberately no `ignores` entry: a global ignore deletes files from
  Steiger's virtual file system before any rule runs, so ignoring tests would erase
  the imports they contribute and `fsd/insignificant-slice` would report a
  test-only slice as unreferenced. Relax per rule with `files` instead.
- The `app` layer is deliberately absent: it is `apps/desktop/src`, a separate FSD
  root, which FSD calls out explicitly and Steiger accepts.

---

## `pages/main-window`

### `ui/main-window.tsx`

The sidebar and the terminals are the entire application: no inspector, no bottom
panel, no activity bar, and adding one needs an argument that survives
`product.md` § Non-goals. Settings replaces the same two columns rather than
opening over them.

- The view renders a **mirror**. On disconnect it keeps rendering, marked stale,
  because the terminals are in the daemon and unaffected.
- Splitter fractions, pane focus, tab selection and project expansion are local:
  `ClientMessage` carries no message for any of them, so there is nothing to send
  and nothing to persist. Inventing one is a protocol change (#35).
- Settings load once at startup and the port answers with defaults rather than
  throwing: settings that refuse to load must not stop the window painting.
- A selection naming a session the mirror no longer has renders as no selection;
  the store repairs it on the next full snapshot.
- One `TooltipProvider` for the window, so every tooltip shares one hover delay
  rather than each control deciding how eager it is. One `SizeProvider` at
  `compact`, because this application is dense: 28px rows against the registry's
  36px default.
- The window's own context menu sits under every other one so a right-click always
  has *something* under it; a more specific region answers first because Base UI's
  trigger stops the event at the innermost one.
- `SessionDetail` is deliberately unkeyed, so a session's local layout survives
  being switched away from.
- `ConfirmationHost` is the only surface that may cover a sheet: a question about
  ending something is asked over whatever the user was doing.

### `ui/app-sidebar.tsx`

- **Two levels, never a third.** `sidebarRows` is flat because a recursive row type
  would quietly permit a third level, and two is a product decision
  (§ Non-negotiables 2). One group headed *Sessions* holds every row: a session is
  what the list is a list of, and a project is the indentation.
- The magnifier opens the Command Menu; this list carries no search field of its
  own, because one query answered two different ways is worse than one answer. The
  status filter stays, because it is a question about state.
- Only `SidebarContent` scrolls, so search, New Session, Inbox and Settings stay
  reachable with two hundred sessions between them.
- Expanding reads nothing. `Project.isExpanded` is the mirror's value and changing
  it needs a protocol message that does not exist (#35), so the local override lasts
  as long as the window.
- Right-click is the primary affordance and the hover button is the shortcut for the
  one action people take constantly; both go through `SidebarActions` so they cannot
  drift.
- `variant="inset"`: the sidebar is the window's surface and the content sits on a
  card inside it, which is what puts the terminals on their own sheet.
- The first row used to carry the mark and the word "Janela". The window controls
  say the same thing where macOS puts them, and the rest of the row is the drag
  band. Its spacer is `self-stretch` because an empty box in a centred row is 0px
  tall — and that box is most of the band the window is dragged by.
- The Inbox row is reserved and disabled with a badge: an item that is merely grey
  reads as broken.
- A session's state is the row's leading glyph, not part of the label: a dot passed
  as a child would sit inside the text box and stop the row's name being the
  weight-animated label. One component per state, built at module scope, because an
  inline one is a new component type per render and remounts. It is an `svg` (the
  size arrives as a number, so no per-render style object), and the tint is applied
  last because `SidebarMenuButton` hands its icon the row's lit/unlit colour and a
  session's state is not a hover state.
- The status is also in the accessible name: a colour alone is a state a screen
  reader cannot read and a colour-blind user cannot distinguish.
- Header controls and group actions are hoisted elements, because `render` takes an
  element, `react-perf` forbids building one in a prop, and a fresh element per
  render remounts the button the primitive composes.
- The filter menu closes on pick: Base UI keeps a menu open after a radio pick,
  which is right for a menu you set several things in and wrong for one holding a
  single choice.
- `FilterRow` is its own component so each row owns its handler; a closure in the
  list would be a fresh function per row per render.
- The project chevron is one mounted component rotated by the row, because swapping
  the component per state remounts it and loses the animation.
- The context-menu trigger wraps the row rather than being it, so the hover action
  stays a sibling — `SidebarMenuAction` positions against the item and reveals on
  `group/menu-item` hover.
- `EmptyState` says *which* nothing it is: "this filter found nothing" and "you have
  not added anything" call for different next actions, and neither repeats the
  buttons above.

### `ui/tab-strip.tsx`

- The three split/new controls sit at the strip's end because they act on *the
  current* tab; closing lives on the tab because it is the one action whose target
  is the tab you are pointing at.
- **Tab order is a request.** `SessionLayout.tabs` is the daemon's and every
  snapshot replaces it, so a local reorder would last until the next terminal
  exited. A drop sends `moveTab`.
- The strip's value is an index into `layout.tabs`, which is what every layout edit
  is written in terms of.
- No `TabsContent`: the pane tree below *is* every tab's content, and only the
  focused tab's panes are mounted — a panel per tab would undo the laziness rule.
- No height: `TabsList` is on the size ladder, so a tab lines up with the far-end
  buttons and with a sidebar row.
- `scroll-fade-x` is a third of a tab rather than the registry's 48px, which on a
  28px strip would swallow a whole tab. `scrollbar-hide` because the bars are
  *classic* here (`styles.css` restyles `::-webkit-scrollbar` under
  `@media (pointer: fine)`), so each would reserve 10px of 28.
- `overflow-y-hidden` because `overflow-x: auto` alone does not say one axis: CSS
  computes the other axis' `visible` to `auto`, so anything poking out vertically —
  the trigger's `line` underline used to, by 2px — becomes a vertical scroll range a
  trackpad can drag the tabs into. `clip` is unavailable: paired with a scrolling
  axis it computes back to `hidden`.
- `shrink-0`: the strip scrolls, it does not squeeze. Shrinking clipped every label
  under the close button and made the fade decorative — 12 tabs overflowed by 30px
  instead of by ten tabs' worth.
- The close button is a *sibling* laid over `pr-7` of reserved room, never a child:
  a tab is a `<button>`, and a button inside a button is not markup a browser keeps.
  It is always drawn at two-thirds opacity, because a control invisible until
  pointed at cannot be found by someone who does not know it is there.
- A drop slot that puts the tab back where it is draws nothing: there is no move to
  preview. `TAB_DRAG_TYPE` is private so a file dropped on the strip is not a tab.
- A tab is also a drop target for a *pane*: while a terminal bar is being dragged
  (`draggedTerminalID`, held by `SessionDetail` because the strip and the pane
  tree both need it) a tab accepts the drop as `{ kind: "tab" }` ahead of its own
  reorder logic, and a dashed "New tab" slot appears after the last tab — only
  when the dragged pane has a sibling, since detaching a lone pane is a no-op the
  slot would misrepresent.

### `ui/terminal-pane.tsx`

Mounted only for the focused tab: an unfocused tab attaches nothing and costs
nothing (§ Non-negotiables 5).

- **Why a terminal has a bar of its own.** A tab is an arrangement; the same
  terminal is meant to be draggable into a different one without stopping, which is
  only coherent if the thing being moved is visible and named where it lives. It
  costs a row of the grid, which is why it says as little as possible.
- The bar is the drag handle (`draggable`, `TERMINAL_DRAG_TYPE`), and the whole
  pane is the target: `dockEdge` in `model/pane-drag.ts` picks the nearest edge in
  the pane's own proportions, `data-drop-edge` names it, and a half-pane overlay
  previews the split. The source pane refuses its own drop and dims instead.
  `dragleave` is ignored while the pointer is still inside the pane — moving over
  the surface fires a leave for the bar — or the overlay would flicker.
- The surface registers through a ref callback, not an effect: the handle exists
  when React hands it over, and React's cleanup is the unregistration.
- Before the attach the measurement *is* the attach viewport; afterwards it is a
  vote and the attach is not redone.
- **Start first, then attach.** `attach` names a live terminal — the daemon never
  starts one for you and refuses an attach to a terminal that has not spawned, which
  would leave the pane rendering nothing and swallowing keystrokes. Nothing is
  missed by attaching a beat later, because the daemon answers an attach with a full
  repaint. `startsAutomatically` is read from the store, not props: what matters is
  the state at the moment of the attach, so a terminal that has since exited is not
  restarted by a re-render.
- Menu rows are built when the menu opens, because whether the terminal has a
  selection lives in the emulator, not in React — and reading it in the open handler
  keeps every handle read out of the render path.
- Paste goes through the surface rather than `sendInput`, because the emulator is
  what knows whether the program asked for bracketed paste.
- **No focus treatment, deliberately.** The caret blinks and the output answers; an
  outline is a fourth signal for something nobody was confused about, and with two
  panes open it draws a box around half the window. `onFocusCapture` still records
  focus, because ⌘D, ⌘W and the notification click act on it.
- `rounded-lg` is on the clipping box, not the surface: xterm's element is square
  and its scrollbar would otherwise sit in the corner.
- The pane is what is elevated (`shadow-surface-2` over a level-1 window). In light
  appearance the terminal background and the window's are both near-white, so two
  panes side by side would otherwise be one field with an invisible 6px gap.
- A pane appearing is the largest thing that moves here, so the enter takes the
  `slow` tier. `transition-none` because `duration-*` also sets a transition
  duration, and left alone an appearance switch would cross-fade the pane's edge.
- The divider under the bar is a hairline at 8% of pure black or white, never a
  tinted neutral, which would pick up the surface under it and read as dirt.
- `data-slot="terminal-pane"` is what a test scopes to and what a terminal drag will
  have to hit.

### `ui/pane-view.tsx`

- The sized half eases to its new value **except** while the divider is under the
  pointer: a drag must track the finger, and a split arriving from the daemon should
  be seen to happen. A CSS transition, so an interrupted drag is picked up mid-flight
  instead of fighting an animation that owns the value. `will-change` is absent: the
  panes hold canvases, and promoting that layer costs more than the 200ms it smooths.
- `horizontal` divides side by side, so the box is a row and the divider is vertical
  (see `Axis` in `@janela/core`).
- **The divider is a real `<input type="range">`**: a splitter *is* a value in a
  range, so the browser supplies keyboard adjustment, the value and the announcement
  for free. Arrow keys shadow nothing and no `Ctrl` chord is bound anywhere here.
- It paints nothing: the 6px it occupies is the spacing between two rounded panes,
  and a line down the middle of a gap is one more edge. The grip is
  `bg-clip-content` with 2px of padding; the thumb is hidden explicitly because
  `appearance-none` leaves it and Chromium draws a 16px lozenge across a 6px gap.
- `pointerdown` calls `preventDefault` because the native drag maps the pointer to
  the 6px box and jumps the value to an end — and then sets focus explicitly,
  because `preventDefault` would have stopped that too.
- Pointer moves are coalesced to one layout update per frame: each resizes panes,
  which resizes surfaces, which votes one `resize` per terminal per frame, and every
  vote ends in a `TIOCSWINSZ` and a `SIGWINCH` two processes away
  (`performance.md` § Interaction budgets).

### `ui/session-detail.tsx`

- Holds one local layout per session, which is why `MainWindow` must not key it by
  session. It does not survive the window closing (#35).
- The edits live in `ViewState` because a menu chord and a notification both move
  pane focus and neither is in this tree.
- Split acts on the tab's own focused pane, not the strip's: the control sits on a
  tab that may not be showing. A right-click acts on the pane the pointer is on,
  which is allowed to be one you have not typed in yet.
- One question per close gesture and one round of removals: a question per tab is
  how a user agrees to something they did not read.
- The unmount-only focus-clearing effect is separate on purpose; folded into the
  focus effect it would send `undefined` between every two focus changes.
- A session with no terminals is `EmptySessionScreen`, not a bare pane region: this
  is a state the user arrives at by closing the last tab, and a blank rectangle
  would read as a bug. The whole screen is replaced, tab strip included, because a
  strip with no tabs is chrome for nothing.

### `ui/sheets/sheet-host.tsx`

There is never more than one sheet — `ViewState.sheet` is a single value, not a
stack — because two overlapping modal surfaces in a terminal app is how you lose
track of which one owns the keyboard. Closing returns focus to the terminal, which
is the only reason a user tolerates a modal in a tool they type into all day.

- The primitive owns Escape, the scrim, the focus trap and first focus. Two things
  stay here: `finalFocus={false}`, because these sheets open from the menu bar, the
  palette and the sidebar and have no trigger to restore focus to; and
  `data-autofocus`, because the first tabbable element is right for a find field and
  wrong for the new-session sheet.
- `SHEET_LAYOUT` uses the dialog's own width ladder rather than a Tailwind `max-w`.
  Every remaining sheet sits at `lg`, and the step stays per-sheet because the next
  one is as likely to be `sm`. The find surfaces title themselves by their
  placeholder, so a heading would be a second line saying the same thing.
- The open sheet stays rendered while the dialog leaves, derived during render —
  the sanctioned shape for "remember the last defined value", where an effect would
  be a frame late.
- Keyed by kind, because a command that opens another sheet swaps the body under an
  open dialog and only a remount takes first focus.
- `position="top"` rather than centred: the list under a find field grows as you
  type, and a centred box would bounce around its midpoint. The primitive's own
  `position` also drops the vertical half-translate, so no transform is left to
  fight.
- A find surface is drawn flush (`p-0`, `overflow-hidden`): the command menu brings
  its own field, hairline and hint strip sized to the panel, and scrolls inside
  itself.
- Picking from the jump list calls `showWorkspace()` first: settings may be showing,
  and picking a session there means "take me to it".
- The `+` or context menu's project wins over the selection's, because a right-click
  on a project is a statement about which project.
- `ConnectedNewSessionSheet` is its own component so the overview request runs only
  while that sheet is open.

### `ui/sheets/command-palette.tsx`

Reads `COMMANDS`, the table the native menu is built from, so a row added there
appears in both and nowhere else that has to be kept in step.

- **One search surface.** The sidebar used to narrow its own list, so a user typing
  a session name got a different answer depending on which box they typed it into.
  Commands come first because an empty query lists the table — that is what ⌘⇧P
  promises.
- Two named groups, because a session row and a command row are told apart by where
  they are listed rather than by noticing that one has keycaps.
- Row ids are namespaced (`session:<id>`), because the menu speaks in values and a
  session named `nextTab` would otherwise run a command. The reverse lookup goes
  through the session list and `isCommandID` rather than stripping the prefix and
  asserting — which is what keeps `CommandID` meaning something.
- Keycaps are pre-formatted: the menu draws one cap per glyph when handed ⌘⇧ glyphs
  rather than a `"mod+d"` combo to translate.
- The haystack is `"<project> <session>"`, as the jump list's is, so `jan pt` finds
  `fix/pty` in `janela` here too. Ties keep the mirror's order; recency belongs to
  the surface that opens on it.

### `ui/sheets/jump-list.tsx`

The app's fastest path, and the reason the sidebar is not load-bearing: three
letters and Enter must land with the keyboard in the right pane, which is why
picking goes through `ViewState.focusTerminal` rather than only setting the
selection. An empty query — the case the user sees most — lists by recency with
**the current session last**, because Enter on an untouched jump list should go to
the most recent *other* session.

### `ui/sheets/new-session-sheet.tsx`

One sheet for every way a session begins (§ Non-negotiables 1). "No project" is a
choice on the first field rather than a different command, because a standalone
session is a first-class case.

- **Two comboboxes, not five commands.** A branch picked is an existing branch; a
  branch *typed* is created with the worktree that carries it — a new branch was
  never a different kind of thing. A worktree picked is `adoptWorktree` (Janela did
  not necessarily create it); a worktree *named* is `newWorktree`.
- The radio carries the one genuine fork: the project's own directory, or one of its
  own. `startChoices` says why a start is impossible in words rather than letting git
  refuse after the click, and `git checkout` is never `-b`, so a branch that does not
  exist yet refuses the checkout start.
- A **second worktree of a held branch** is git's `--force` exception, so the
  worktree field takes a name for one and states the cost; `shareBranch` carries the
  decision, and nothing else asks for `--force`. The worktree start is therefore
  never refused — the user is told what sharing costs rather than that they cannot.
- Both lists are the daemon's (`projectBranches`), read once per project: a client
  that listed either itself would be a second git.
- `worktreesFor` is plural because `shareBranch` means a branch can be in several
  places; the project's own checkout is not among them, because working there is the
  other start.
- `preselectedBranch` is the project's default when it is local, else what the
  project directory has checked out — and it is also where a new branch starts,
  because that is the branch the user would have named. `preselectedWorktree` prefers
  adopting, because the directory already exists and a second worktree is a thing to
  choose deliberately.
- `BranchChoice` keeps *choices*, not resolved values, so a project switch or a late
  overview re-derives the preselection instead of correcting stale state; `undefined`
  means "still following the branch". A branch is kept as chosen even when no branch
  has that name — that is how a new branch is asked for, and validating it here would
  be a second opinion on what git allows (§ Non-negotiables 3). An adopted worktree is
  remembered by *path*, which is only an answer while git still lists it against this
  branch and no session holds it, so a branch change drops it while a typed name
  survives.
- `newSessionIntent` is the only place a listed worktree is told apart from a name
  for one that does not exist. A path that is not an adoptable worktree is not a
  *name* either — sending it would create `.worktrees/Users-x-code-…`. A start point
  is sent only for a branch being created, because git checks an existing one out
  where it already points.
- `useBranchOverview` asks once per repository and nothing for `undefined` ("No
  project" and plain folders). A reply for a closed sheet is dropped, and the answer
  is kept with the project it answers for, so a re-pointed sheet reads as loading
  rather than showing the previous project's branches for a frame.
- `standaloneIntent` refuses only what is not a path at all; whether the directory
  exists is the daemon's call.
- The folder field's value survives a project change: switching to a repository and
  back should not lose what was typed.
- `FIELD_CLASS` exists because the registry's combobox is a hairline ring on nothing
  while every other field in this window is base-mira's, so beside the project select
  the two read as different kinds of control. The transition is narrowed with it,
  because the registry's `transition-all` would animate layout too.
- A controlled combobox value is only displayed while it is one of the items, so a
  typed name joins the list it was not in.
- The branch field keeps its description even with a branch chosen: typing a name is
  the only way to a new branch, and a capability nothing mentions is one nobody finds.

### `ui/confirmation-host.tsx`

Keyed by title so "Don't ask again" starts unticked every time, without an effect
that resets it a frame late. Escape, the scrim and the ✕ all mean "no" — a dismissed
question is declined, never a silent yes. Initial focus is Cancel rather than the
first tabbable element (the switch): a question is read and then answered, and the
answer it opens on is the reversible one, so a ⌘W from muscle memory cancels.

### `ui/directory-picker-host.tsx` and `ui/directory-browser.tsx`

The browser client's folder picker: a Finder column view over `listDirectory`,
shown by the host whenever `DirectoryPickerQueue.pending` is set. Mounted by the
web root beside `MainWindow`, not inside it, because the Mac client has no such
dialog to mount and `MainWindow` should not know which client it is.

- **Columns, not a tree.** A folder chosen in one column opens the next; the deeper
  columns are dropped when an earlier one changes, and the chosen folder is always
  the deepest column's. That is `NSBrowser`'s model, and it means the daemon is
  asked for exactly one folder per step (§ Non-negotiables 5). Listings are cached
  for the dialog's life and never refetched while it is open.
- **The keyboard is Finder's.** ↑/↓ move the selection and open its column, → moves
  into it (selecting the first folder when nothing is), ← moves back without
  closing anything, Enter chooses, Escape cancels. Focus is one listbox per column
  with `aria-activedescendant`, so a screen reader hears the folder and the row.
  The lit selection is the focused column's; the columns behind it keep theirs in
  `bg-selected` grey, as Finder does, so the eye can find the keyboard.
- **Files are shown, dimmed, and not choosable**, as in a folder-choosing
  `NSOpenPanel`: knowing a folder holds `package.json` is how a person recognises
  it. Dotfiles never arrive.
- **The path field is the Go-to-Folder.** It follows the selection, accepts a typed
  absolute path on Enter (trailing slashes stripped by `typedDirectory`, so the
  column is labelled and the daemon is sent the same string), and is the way above
  the home the picker opens on — besides the Enclosing Folder button, which
  prepends the parent and keeps every column, and Home.
- **A folder that will not open says why in its own column** — the daemon's
  `DirectoryUnreadable` reason — and Choose is disabled until the deepest column has
  loaded: a folder the daemon cannot read is not a folder a session can run in.
  `truncated` listings end with a notice rather than pretending the folder ends.
- The decisions are pure in `model/directory-columns.ts` and tested there; the
  component holds only the listing cache, the draft in the path field, and the
  scroll/focus effects. The column fade is 100 ms, opacity only, `motion-safe:`;
  rows transition `background-color` only, 100 ms; the selection is a colour, so
  nothing is visible only while animating.

### `ui/connection-banner.tsx`

An inset strip rather than a modal: the user's terminals are still running and their
state is still on screen, so blocking the window would be a lie about how bad the
situation is. Absolutely positioned inside `MainWindow`'s `relative` root — it
overlays, never inserts, because a terminal that jumped a few pixels on every daemon
restart would be worse than no banner.

- The retry attempt is deliberately not shown: reconnecting usually resolves within
  a frame or two, and a counter turns a non-event into something to watch.
- `VERSION_SKEW_COPY` names what happened, what is still true, and what restarting
  costs, in that order, because a user deciding whether to kill their own terminals
  needs the cost before the button.
- `runningSummary` counts what the daemon said is running, not what this client
  hopes.
- The restart button is the one button that ends every terminal the daemon holds,
  and it sits under a sentence people have learned to dismiss — so the count is
  repeated where the pointer already is and the acting button names what it does
  (§ Non-negotiables 7). No "Don't ask again": nothing repetitive, nothing to
  recover.
- `<output>` carries `role="status"` implicitly, and the spinner is hidden from the
  live region because the sentence is the announcement.
- The action is a sentence, so it sits below the copy instead of in the corner
  `AlertAction` reserves — hence `static` on the action and both `has-[action]` rules
  overridden here rather than fought with specificity.

### `ui/welcome.tsx`

The first screen of a fresh install and the screen after removing a last session,
so it carries the two creation actions rather than describing them. Both are
`CommandID`s, so there is one implementation of "start a session".

The backdrop is `shared/ui/window-backdrop.tsx`, described below.

### `ui/empty-session.tsx`

The screen a session shows once its last terminal is closed. It exists because
closing the last tab no longer conjures a replacement (§ Non-negotiables 5,
`docs/packages/session.md`): the session is a directory and is still there, so the
screen says so and offers ⌘T. The action is `onNewTerminal` from `SessionDetail`
rather than a `CommandID`, because it acts on the session being drawn and not on
the selection — the same reason `model/sidebar-actions.ts` exists. It carries the
same backdrop as the welcome screen: the two screens are the same situation seen
from two distances — a window with nothing running in it — and a user who reaches
one by closing tabs and the other by deselecting should not find two different
rooms.

### `shared/ui/window-backdrop.tsx`

`FaultyTerminal` from `@janela/design`, with the settings and the composition both
empty screens use — one component rather than one class string in two files, so
the two cannot drift apart by a tuning nobody repeated.

It is behind the empty screens and not behind every screen: these are the two
places the window has nothing to say, and once terminals are on screen they are
the thing to look at — an animated field behind them is noise. It is masked to a
ring and held at low opacity so the copy above it stays legible, and it is
`aria-hidden`: it carries no information, which is the point. The opacity is per
appearance (`0.07` light, `0.28` dark) because `mix-blend-exclusion` inverts —
the same value that reads as a faint glow on near-black reads as a wall of grey
glyphs on paper — and Increase Contrast drops it entirely (`contrast-more:hidden`),
because that appearance exists to make text maximally legible and a decorative
field works against it.

### `model/command-dispatch.ts`

An exhaustive `Record<CommandID, …>`, so a command added to the table without an
action fails `typecheck` rather than being a menu item that does nothing.

- **Nothing is enabled or disabled.** Enabled state would mean the shell asking the
  client about every row on every menu open, and a greyed-out "Split Vertically"
  teaches nothing the user did not know from having no session selected.
- `sessionOrder` walks the sidebar's order, not the mirror's, because "next" means
  the next one down the list the user is looking at.
- `selectSession` is the one field of the mirror a client owns; it is a function
  because it is the only place any view writes to a store.
- `focusedTerminalOf` resolves through the *local* layout: a tab switch is local, so
  the mirror would answer for a different window.
- `createSessionAndSelect` relies on the daemon publishing the snapshot before the
  reply on the same ordered queue, so the mirror already has the session when the
  request settles. Focus goes to its pane: creating a session means wanting to type
  in it.
- `createTerminal` and `splitTerminal` never inherit a profile — a new pane is a
  terminal, and a launch profile is something a terminal may be started with later.
  The split is the daemon's, persisted with the session, which is why it is a request.
- Restart is one request: closing a pty leaves the terminal `running` until the
  daemon reaps the child, so a start sent straight after finds a terminal that looks
  alive and does nothing.
- `closeTerminals` is one function behind ⌘W, the pane and tab buttons and the
  strip's bulk closes, because they differ only in how many terminals they name. A
  tab's button ends terminals its splits are not showing, and § Non-negotiables 7
  says the user is told. Idle, exited and failed terminals close without a word. The
  removals go out together on one queue and are awaited with `allSettled`, because a
  tab of six panes should not take six round trips and a rejection must not leave its
  siblings unobserved. A session that loses its last terminal keeps existing with
  none, and `SessionDetail` draws `EmptySessionScreen` rather than the pane region.
- `CLOSE_WORDS` is a table so the three spellings of one scope cannot disagree.
- `closingCost` is the one question offering "Don't ask again": anyone working in
  splits meets it several times an hour and what it guards is recoverable. Removing a
  session is the opposite on both counts.
- Clear Scrollback is this client's view only, which is what makes it safe by reflex.

### `model/sidebar-actions.ts`

**Why these are not `CommandID`s:** every row of `COMMANDS` acts on the selection,
while a context menu acts on the row it was opened over — frequently not the
selection, which is the whole point of right-clicking a project you have not
visited. So these take their subject as an argument.

- `openProjectSettings` navigates; the form lives in Settings under *Projects*.
- Removing a session asks the daemon for the plan first, because whether a directory
  would be deleted and whether that loses work depends on git state only the daemon
  can read — a client that guessed would eventually guess "safe" about uncommitted
  work. Plan, then human, then removal. The client sends its own answer back rather
  than offering to keep the directory, which would be a fork this product does not
  have.
- `sessionRemovalPrompt` makes every clause conditional on the plan, because a
  confirmation listing consequences that will not happen is one people learn to
  dismiss; the `safety` flags stay individual because "has uncommitted changes" is
  actionable and "unsafe" is not. The message is never empty, and there is no
  `remember`: a one-way door for a removal that takes uncommitted work is the mistake
  the confirmation exists to prevent.
- `listed` writes an English list, because a screen reader reads this aloud.

### `model/menu-rows.ts`

**Only actions about the thing under the pointer.** A context menu is not a second
menu bar: `COMMANDS` is already reachable from ⌘⇧P and the menu bar, and repeating
it everywhere would make the gesture worthless.

- The window menu is the only one carrying window-wide commands, because nothing
  else is under the pointer, and it carries the three that start something.
- Project Settings has no ellipsis: it goes somewhere rather than asking something.
- Copy is first and disabled with nothing selected. Paste does not depend on a
  selection and the clipboard is *not* read to find out — that is a permission prompt
  on some platforms. Close is never guarded here, because `closeTerminals` names the
  cost of closing the last one.
- A tab's five closes are one section because they do one thing in five sizes, and
  all five are destructive: a row that ends *more* programs must not look safer. They
  are dimmed rather than hidden, because a menu whose rows move depending on where in
  the strip you clicked cannot be learned.

### `model/session-rows.ts`

- A flat `SidebarRow` array, because a recursive row type would permit a third level.
- `sessionStatus` is derived only from reported state: rendering an unreported
  terminal as running would be a lie this client invented (§ Non-negotiables 6).
- Grouping happens here rather than through `SessionStore.inProject`, which builds a
  fresh array per call and would be a new reference every render.
- `statusText` travels beside the colour, never instead of it.

### `model/sidebar-filter.ts`

- **No text query.** Finding by name is the Command Menu's job; a status filter
  answers "what needs me?", which no amount of typing answers.
- **The order never changes.** This is a permanent list a user *points at*, and
  re-ordering as terminal state arrives would move the row under the cursor between
  the decision to click and the click.
- A project survives if one of its sessions did: unlike a name match, there is no
  sense in which the project itself qualifies. `all` returns the same arrays, because
  that is the state the sidebar spends its life in.
- A filter opens the projects holding its matches whatever the user last collapsed,
  because a filter that hides its own matches looks broken. The overrides are merged
  *over* the user's and forgotten when the filter clears — the filter is the more
  recent statement.

### `model/tab-rows.ts`

- `tabTerminals` returns a tab's whole pane tree: a tab is an *arrangement of*
  terminals, so anything acting on a tab acts on all of them.
- `closeQuestionScope` asks in the noun of the **gesture**, never the count: "Close
  this tab?" over a row that said "other" reads as the tab under the pointer, and
  that is a user agreeing to the opposite of what happens.
- An absent state reads as idle, which is what the daemon's `idle` means —
  configured, nothing spawned — not an inference about a running process.

### `model/terminal-attach.ts`

- `startsAutomatically` is the daemon saying "the client that opens this should
  ask": set on a new session's terminal, `false` on every terminal restored from the
  database, so relaunching spawns nothing. Anything running, exited or failed is left
  alone — a pane that finished is not restarted by being looked at.
- **Subscribe, then attach.** The daemon answers an attach with a full repaint, so a
  handler registered after the request would miss the screen it asked for — which is
  also why there is no loading state to design. The cleanup unsubscribes then
  detaches, and a detach that fails because the connection is gone has already
  happened as far as the daemon is concerned.

### `model/session-fixture.ts`

Built here rather than imported: `@janela/client`'s fakes are not exported, and a
client-side view has no business reaching into a daemon package for a fixture. The
positional shape is deliberate — a sidebar test reads better as
`session("fix/pty", { terminals: [terminal("t1")] })` than as a full value.

---

## `pages/settings`

### `ui/settings-screen.tsx`

- **Why a screen and not a sheet.** The terminals are the application, and a dialog
  over them meant reading settings through a scrim in a box that could not hold a tab
  strip and a form at once. The window's shape does not change; what fills it does.
- **Why the projects are here.** A project's settings used to open as a sheet from
  its sidebar row. That was wrong twice: it was the largest form in the application
  and the only one read through a scrim, and it was the only settings you could not
  find by looking — every other preference is behind one button, these were behind
  knowing to right-click a row. So a project is a **route**, not a fifth tab: tabs are
  fixed data, projects are the mirror's list, and the sidebar's *Project Settings* row
  became a link to somewhere rather than a second editor.
- **The panes are the questions a user arrives with, and no General.** Appearance,
  Accessibility, Notifications, Integrations, Experimental, Permissions. The first
  cut was one pane per *product noun* — Terminal, Launch profiles, Notifications,
  Daemon — which read well from inside the codebase and badly from outside it:
  nobody arrives thinking "daemon", they arrive thinking "why did it ask me that"
  (Permissions) or "connect it to GitHub" (Integrations). There was also a *General*
  before either cut, holding three unrelated things, which is what a pane named
  after nothing always becomes, and it put the most destructive surface in the
  product behind the blandest label. The map now: the terminal font under
  Appearance; the bell under Notifications; forge reading and launch profiles under
  Integrations — both are "the tools Janela reaches", and a profile is still a
  command, not a wrapper; the close-terminal confirmation, the notification
  permission's explanation and the daemon's stop controls under Permissions,
  because all three are "what may it do, and what does it ask first".
- **Two panes are honestly empty.** Accessibility and Experimental render an empty
  state saying why — Janela follows the system's accessibility settings rather than
  keeping its own, and nothing is currently behind a flag. They exist because their
  absence would be read as "Janela ignores accessibility", and because a category
  that will exist eventually is cheaper to ship empty than to renumber the panes
  around later. The empty copy is load-bearing: it states the policy.
- **The sections are data, not markup.** `model/settings-index.ts` holds every pane,
  its description, its sections and their field labels; the panes render from it and
  the sidebar's search reads it. A table nothing renders drifts, so a test renders
  each pane and asserts every advertised section title, field label and anchor is
  really on it. `keywords` is the half that is deliberately *not* rendered: the words
  a user types ("unregister", "hook", "janelad") are not always the words the product
  says, and a match on one shows the section's own title rather than the keyword —
  otherwise search would teach vocabulary the UI has retired.
- **Search, because reading the sidebar is not finding.** Four panes and a row per
  project is already more than the eye scans, and a project pane holds seven sections.
  The results are one row per *pane*, not one per match: that keeps the list short,
  keeps the `tablist` exactly as long as the number of panes it can reach, and leaves
  every row a real tab with a unique id. The row says which pane and which section
  matched, and picking it scrolls that section to the top and rings it for 1.4s —
  a settings search that only opens the right pane has answered half the question.
  Reveal is component state, not a route field: it is a one-shot gesture, and putting
  it in `SettingsRoute` would make `sameRoute` lie and skip the scroll when the pane
  was already showing.
- The tabs are data for the same reason `COMMANDS` is: the navigation and anything
  that opens a specific tab read one table. Icons are the one thing the view adds —
  copy is data, glyphs are presentation.
- A real `tablist` across both groups, so a screen reader hears "tab, 5 of 6" and the
  arrow keys are one sequence; the group headings are `presentation` labels inside
  the list rather than rows in it.
- **The sidebar primitive moves the keyboard.** It already rovers focus in DOM order
  and stops the event, so a second handler fights it — a hand-rolled one shipped in
  the first draft and the two disagreed the moment focus and selection were on
  different rows, moving the pane two places while focus moved one. Selection
  therefore follows focus (automatic activation), which is legitimate because a pane
  is cheap to show. `onClick` is the redundant one, kept because a click on the
  already-focused row must still show it.
- Settings used to be the one screen whose sidebar sat against the window frame and
  could not be collapsed — a second layout for no reason anyone could name.
- An empty Projects group uses the same `Empty` as the workspace sidebar, without
  repeating its Add Project button, which is not on this screen.
- A project row brings its generated icon, which is what makes this list recognisable
  as *those* projects. Row glyphs and `NavRow`s are built once, because a component
  type made per render remounts the icon on every keystroke elsewhere in the window.
- The pane is keyed by project, so switching rows opens the next form from the top. A
  project the mirror no longer has renders nothing and sends navigation back to the
  first pane — derived rather than written back, because a store write during render
  notifies subscribers mid-render.
- The project pane reads the *draft's* profiles, so a profile renamed on Launch
  profiles reads the same here before either is saved.
- **Every pane is headed the same way**, by `PaneHeader`: title, then the directory
  when it is a project, then one line saying what the pane is for. The project pane
  used to build its own heading and the tab panes another, which is how the two
  drifted into different type sizes; and the panel is now labelled by that heading
  rather than by the selected row, so filtering the sidebar cannot leave
  `aria-labelledby` pointing at a row that is no longer rendered.
- **Sections are cards, groups are headings.** A section is `Elevated offset={1}` with
  its legend inside, so grouping is carried by surface and shadow rather than by a
  border whose only job was depth. Automation needed a third level — three event
  sections that are siblings, not children — so `PaneGroup` is a heading with its own
  explanation above a run of cards, instead of the card-inside-a-card the old nesting
  produced. `FieldSection` is the flat fieldset that remains for a form *inside* a
  card: the profile editor's Icon, Command and Environment blocks.
- **The commit bar** is always visible: one that appears when something is dirty moves
  the content as the user types and hides that the screen has a commit model at all.
  At rest it is quiet; dirty, it says how many changes it would write, because with one
  Save for every tab that number is the only thing telling the user their reach extends
  past the pane they are looking at. The blocker is a button, because the thing blocking
  the save is frequently on another pane and reading its name without being able to get
  there is worse than not being told.
- Save reads the draft from the store rather than the render that built the callback,
  and reads both halves, because what a save writes is the difference between them.
- Revert bumps a revision used as the pane's key, because the panes hold field state
  the draft cannot: argv rows carry identities and the open profile editor a working
  copy.
- The Save bar is a sibling of the scroller, because it commits every tab's edits.

### `ui/daemon-settings.tsx`

- The daemon's controls live in Settings rather than in a menu because stopping it
  closes the user's terminals, and a destructive action behind a keyboard shortcut is
  one that will be hit by accident. Settings is where you go on purpose. The controls
  render inside the **Permissions** pane under a *Daemon* group heading — the pane's
  subject is "what Janela may do", and outliving the window is the biggest thing it
  does — but they stay this component, owned whole, because the confirmation dance
  below is one piece.
- **It is called the daemon.** The copy said *Background Service*, which is a macOS
  noun for the launchd registration, not our noun for `janelad` — and the vocabulary
  table in `AGENTS.md` retires "service" precisely so one thing has one name. Login
  Items & Extensions is still named where it is what the user must go and click.
- Two cards, because the pane answers two questions: *Running now* states what would
  be lost, *Stopping it* offers the two ways to lose it. One card mixing state with
  destructive buttons reads as if the sentence were a label for them.
- Neither service control acts on its first press: pressing one shows the cost from
  the mirror, and a second, differently-labelled button performs it.
- `ServiceCostConfirmation` is exported because the version-skew banner owes the user
  exactly this sentence, and two implementations of "what you are about to lose" would
  drift the first time the counting changed. It is an `Alert` in place rather than a
  dialog, because a modal asking "are you sure" trains people to dismiss it while a
  cost sentence where the button was gets read. `role="alert"` announces it.

### `ui/appearance-settings.tsx`

One section: the font. Colours come from the appearance the system declares, size
comes from the window, and behaviour belongs to the program — so the font is the one
thing a developer has an opinion about that we cannot infer. The close-terminal
question that used to sit beside it moved to Permissions with the other questions.

- Both fields reach every attached terminal through `TerminalPane`, which reads
  `view.settings` and hands the surface a `TerminalFont`. A save re-applies the font
  in place: the grid is re-measured and re-voted, and no scrollback is lost.
- The hint says where icons come from, because the field is the one place a user
  who wants their prompt's glyphs in the text font too will look. Leaving it empty
  is not a compromise: the default stack ends in the symbols font the application
  ships (`packages/design/src/tokens.ts` § `TERMINAL_SYMBOL_FONT`), so the icons
  are there either way.

### `ui/permissions-settings.tsx`

The pane that answers "what does Janela ask, and what did macOS ask for it". The
close-terminal confirmation is a switch; the notification permission is a paragraph,
because macOS owns that toggle and a control here would be a lie — the copy says
where the real one is. The daemon group renders `SettingsDaemon` below both, since
its stop controls are the largest permission of all.

### `ui/integrations-settings.tsx`

GitHub and GitLab first, then the launch profiles. The forge rows are **per
project** — `isForgeEnabled` stays a project setting, and this pane is a second door
to the same value the project pane no longer shows — because "connect GitHub" is
asked per repository, but *looked for* under Integrations. Each row edits the
project's draft through `withDraftProjectSettings`, so the commit bar counts it like
any project edit. A project without a forge is not listed: there is nothing to
switch.

### `ui/notification-settings.tsx`

One switch. "Not the terminal you are looking at" and "only when Janela is not
frontmost" are facts, not preferences, and a mis-tuned notification policy trains
users to distrust the badge. The bell is the one genuine choice, because a bell means
whatever the program ringing it decided; an explicit OSC 9 or OSC 777 is consent, not
a choice. In-app state is unaffected by this pane: the badge is the daemon's and needs
no permission.

### `ui/launch-profiles.tsx`

- **Unavailable profiles are visible here** although the picker hides them: hiding
  exists so the user is never offered something that cannot start, and this is the one
  surface where the problem can be *fixed*. A profile you cannot see is a profile you
  cannot repair — hence dimmed, not hidden.
- Built-ins are editable (the ones we ship are guesses about the user's setup), and
  neither deletable nor renamable — both consequences of seeding by name on every open.
- The pane takes the draft rather than a value and a callback, because adding,
  duplicating and deleting are changes to a *list*, and the difference between deleting
  a stored profile and discarding a draft-only one decides whether the daemon hears
  about it at all. The open editor still holds a working copy for the caret, because
  argv and environment rows need identities that survive a neighbour being removed.
- A new profile is staged immediately: the row has to appear in the list to be edited,
  and an unsaved row the bar does not count is one the user loses to Revert without
  being told.
- The editor has no Save of its own, because a second Save would be two promises about
  the same keystrokes. Delete and Duplicate stay, because neither is a field. It is
  exported so it can be tested without driving a click through the list, and Delete is
  pushed away from the other button because a destructive action beside a button people
  reach for is a mis-click waiting to happen.
- The row is a button, not a div with a handler: selecting a profile is an action.
- The icon grid is real radio inputs, so the browser owns arrow-key navigation and the
  roving tab stop — both of which buttons with `role="radio"` would reimplement and get
  subtly wrong. `htmlFor` reaches the hidden radio Base UI mirrors, so the whole card is
  a click target.
- A freshly added variable row is labelled "Remove variable", because an icon-only
  button labelled `Remove ` is one a screen reader cannot announce.

### `ui/project-settings.tsx`

- **The security property.** Automation commands exist only because a human typed them
  here. They are never read from the repository, because a committed file that runs
  commands makes cloning a repo from a stranger a code-execution vector — the one
  property that cannot be added later. This editor is not a convenience over a config
  file; it is the whole mechanism.
- It holds no state of its own. The pane is the most obvious reason the draft exists —
  applied per keystroke, `pnpm ins` would reach the daemon, which stores commands that
  *run* — but it does not own it.
- The worktree-root field is guarded rather than thrown: a user halfway through typing
  `/Users/…` has a relative path for a keystroke.
- The directory is shown under the name, because two clones of one repository are two
  projects with the same name.
- A command sheet's argv drafts are local and initialised once, so removing argument 1
  of three does not remount the others and drop the caret.
- The order controls read as one control with two directions; Remove stands apart.

### `ui/fields.tsx`

These live here rather than in the design package because a *labelled* field is a
decision about how this app's forms read, and the design package deliberately knows
nothing about that. Keyboard-reachable with the platform focus ring left alone, and
**no `Ctrl` handling anywhere** (§ Non-negotiables 4).

- `valueAsNumber` is NaN for an empty field, which the caller's clamp turns into the
  default rather than a broken `font-size`.
- The switch's `htmlFor` reaches the hidden checkbox Base UI mirrors, while
  `aria-labelledby` names the visible switch, which is what a screen reader lands on.
- `ProfileSelect` lists available profiles only — an uninstalled tool is an advert —
  plus the selected one even if it became unavailable, because a select that silently
  drops the stored value shows the user a setting they never made. The chosen id is
  matched against the rendered options, so the lookup is both validation and conversion.
- `Violations` renders a list even for one entry, so a second violation does not change
  the shape of the surface under the user's eyes.
- `Section` is a `fieldset`/`legend`, because a screen reader announces the group when
  focus enters it — the difference between "Enabled" and "Enabled, When a session is
  first opened".

### `ui/argv-editor.tsx`

There is no field that takes `claude --model opus` and splits it: splitting a string
into argv has no correct implementation — `zsh -lc "echo 'a b'"` has no right answer —
and every wrong one is a quoting bug in a program the user cares about. Position is the
label, and the inputs are monospaced because a trailing space or an l/1 confusion is
the bug being looked for.

### `ui/profile-icon.tsx`

`aria-hidden` without exception: every place it is rendered puts a name beside it, so
announcing the glyph reads the same thing twice. An icon that is the *only* label is a
control that needs a label, not an icon that needs a role.

### `model/profile-rules.ts`

Separate from `shared/model/profile-draft.ts` — that holds the form shape, which
`SettingsDraft` carries and so must sit below the window store. Rules belong with the
screen that enforces them.

- `profileViolations` is deliberately short: a profile is a command Janela starts, so
  the only knowable wrongs are the ones that make it unstartable or unnameable. Whether
  `claude` is a good idea is not ours to judge, and whether it is *installed* is
  availability's answer. Note the asymmetry — a *later* blank argument is legal, because
  `["zsh", "-lc", ""]` passes an empty argument on purpose.
- Built-ins cannot be removed, because `BUILT_IN_PROFILES` is re-seeded on every open
  and a deleted one would silently return and look like a bug in deletion. They cannot
  be renamed for a separate reason: seeding matches built-ins **by name** (ids are
  minted at seed time, and a hardcoded one would collide with a user's copy), so
  renaming "Codex" makes the next open insert a fresh "Codex" beside it. Duplicating is
  the supported route, and the editor says so.
- `duplicatedProfile` drops `isBuiltIn` — the entire point — and mints a fresh id,
  because two rows with one id is a lost profile.
- `profileTitle` exists because a row with no title reads as a list that failed to
  render rather than a form waiting for a word.

### `model/automation-commands.ts`

The list is authored here and executed by the daemon. Two load-bearing properties:
`command` is an **argv array**, never a shell string; and the commands live in Janela's
database and never in the repository, for the same code-execution reason as above.

- `sessionTeardown` is the only blocking event, so it is the only one whose timeout
  means anything — a timeout field on the others would imply a guarantee that does not
  exist. The default waits 30 s, then asks.
- A new command is appended **disabled**: nothing may run because the user clicked
  "add" to see what the field looked like.
- Commands for one event run in sequence and do not gate each other, so the list's
  order is the whole scheduling model.
- `automationMoving` moves within its own event: the stored list is flat and mixes
  events, so a naive index swap would trade places with a neighbour from another event.
  A command at its end is returned unchanged, because a run order is not a carousel.
- `automationViolations` catches the case worth catching: an *enabled* command with no
  executable would fail at every session creation, visibly, forever.

### `model/background-service.ts`

Stopping the daemon terminates the user's terminals — never something Janela does to
make its own life easier — so both controls are explicit user choices, and an explicit
choice made without knowing the cost is not a choice.

- `serviceStopCost` reads what the daemon reported: a terminal with no reported state
  is idle, not live, so an unknown id is deliberately not counted. Its `sentence` is a
  fragment so the two controls and the version-skew banner can embed it without three
  near-identical counting implementations drifting.
- Both cost strings name the terminals explicitly: "Are you sure?" is not a stated cost,
  and the number is what makes someone stop and read. The confirm label says what
  happens, not "OK".
- `serviceControlReducer`'s load-bearing line is the `request` case: pressing a control
  **performs nothing**, it only reveals what pressing it again would cost. A `confirm`
  for a request that is not pending is inert, which is what stops a stale click — "Stop"
  pressed, read, then "Stop and unregister" — from performing the request the user
  walked away from.

### `model/draft-save.ts`

- A violation carries its route, because with one Save for every tab a blank executable
  in a project's automation would otherwise disable a button on the Terminal pane with
  no way to find out why. Only *staged* values are checked.
- `settingsDraftRequests` is the only place "the user pressed Save" becomes writes, and
  a mapping exercised only by clicking a button is a mapping nothing checks. Everything
  identical to `since` is left out: a save leaves its values on screen (dropping them
  would show the mirror's older answer until the broadcast landed), so without this a
  second Save re-sends the first one's writes, including a `removeLaunchProfile` for a
  profile that is already gone. Compared by reference, because every edit is an
  immutable update. Order is deliberate: profiles before the projects that may name one
  as their default, and removals after saves so an edit and a deletion of the same
  profile cannot resurrect it.
- Global settings are not in that list — they are the client's own store and never
  cross the socket.
- `draftEditCount` counts against `since` for the same reason, because the number and
  the messages have to be the same answer or the sentence is a lie about the button
  beside it.

---

## `shared/model`

### `client-environment.tsx`

`MainWindow()` takes no props — it is the window, not a widget — and the composition
root lives one layer up, so the environment arrives by context and **the interface
lives down here** with the code that consumes it (AGENTS.md § The layering rule).

Attention *delivery* is deliberately absent: whether a signal interrupts anybody is
`AttentionPolicy`'s call, and this layer reports only which terminal has focus — the
one fact the policy cannot compute. The selected session is not reported either: it is
already in `SessionStore.selection`, and a second channel for one fact is a second
thing that can be wrong.

- `CommandSource` is a port because the menu bar is native: views know a command
  happened, not that a `tauri://` event carried it, so a CLI or browser supplies its own
  source and every row still works.
- `NativeShell` is down to the two things only the shell can do: Finder and
  Terminal.app. Asking a question is no longer one of them, and neither is choosing a
  folder.
- `DirectoryPicking` sits beside `confirmations` rather than under `local`, because
  every client can answer it: the Mac with `NSOpenPanel`, a browser page with the
  daemon's own listing (`directory-picker.ts`). That is what lets Open Folder… and
  Add Project… stay in every palette.
- `WindowControls` carries the *fact*, not a width: how much room three buttons need is
  the client's business, and a pixel count crossing this seam would put the window's
  layout in the shell.
- `Clipboard` is the one place a platform can refuse — reading is a permission on some —
  and a refusal is not an error to show anyone: `paste` answers `undefined` and the
  terminal receives nothing.
- `restartDaemon` is the version-skew banner's button and the only thing that may cause
  it, because restarting kills live terminals (§ Non-negotiables 7).
- `useStoreValue`'s third argument is the point: without a server snapshot
  `renderToStaticMarkup` throws, and these views are tested by rendering to markup.
  `read` must be reference-stable between notifications, so composing an object literal
  in it would re-render forever.

### `confirmation.ts`

**Why this is not `NativeShell.confirm` any more.** Tauri's `ask()` was an AppKit alert,
wrong in three ways only a real dialog fixes: it could not offer a third answer, so
"Remove Session" could not also offer "Don't ask again"; it is not this application —
the type, spacing, spring and surface ladder stop at the window edge; and it is
unobservable, so the most consequential sentences in the product were the only copy
nothing could assert on.

- A promise, because every caller is a decision and reads as one. A store rather than
  component state, because the callers — `closeTerminals`, the sidebar actions, the
  version-skew banner — are not inside the React tree that renders the dialog.
- **One question at a time, and no queue.** A second request while one is on screen is
  answered "no" without being shown: the dialog is modal, so the only way to produce one
  is a chord or a notification click, and the safe reading of "⌘W arrived while you were
  being asked about ⌘W" is that nothing happens. A queue would show a question about
  something the user has stopped looking at (§ Non-negotiables 9 — nothing accumulates
  without a bound, including questions).
- `destructive` defaults on, because everything that asks here ends something.
  `remember` is absent by default, which is right for anything that can delete a
  directory. `silence` is honoured only on agreement: silencing a question you declined
  would mean the next one proceeds without asking.
- The queue takes `view` and `settings`, because a silenced question has to survive the
  window *and* take effect immediately. The storage write is best-effort: losing the
  preference costs one more question, not the answer just given.

### `directory-picker.ts`

The port a folder question goes through, and the queue a client without a native
panel answers it with.

- `DirectoryPicking` is one promise-returning method, the same shape `NativeShell`
  carried until it was the last thing there a browser could also do. The Mac client
  implements it with the real panel; there is no reason to draw a lesser Finder on
  the machine that has Finder.
- `DirectoryPickerQueue` is `ConfirmationQueue`'s shape without settings: one
  request on screen, a second one answered `undefined` without being shown, for the
  same reason — it is modal, and the only way to produce a second is a chord. The
  web root composes it and mounts `DirectoryPickerHost` beside `MainWindow`;
  `MainWindow` itself never learns which implementation it is talking to.

### `global-settings.ts`

Small on purpose: a setting earns a place only when it is a fact about the person rather
than a repository, and there is deliberately no per-session tier.

**Why client state, not daemon state.** Every field is about rendering or interrupting,
and both are facts only a client holds. A CLI has no use for any of it, which is the
test for whether something belongs on the wire. `defaultProfileID` looks shared and is
not: it is the fallback for a project that expressed no preference, and the project's own
`defaultProfileID` — which *is* daemon state — wins.

- An absent `terminalFontFamily` is the default stack, which is not the same as an empty
  string. The key is *removed* rather than set to `undefined`, because
  `exactOptionalPropertyTypes` makes those different types and a persisted
  `{"terminalFontFamily": null}` would read back as an override to nothing. Same rule for
  `defaultProfileID`.
- `notifiesOnBell` is off by default, because programs ring the bell for reasons the user
  has not agreed are important. An explicit OSC 9 or OSC 777 delivers regardless.
- `TERMINAL_FONT_SIZE_BOUNDS` is not taste: below the minimum the grid stops being
  legible and above the maximum an 80-column view no longer fits a laptop display, and
  both ends produce "the app is broken" reports. A number input yields `NaN` for an empty
  field and for "12pt", and `NaN` propagates into a CSS `font-size` the WebView drops,
  which looks like a rendering bug rather than a typo.
- `ConfirmationKey` is a closed union because the set *is* the policy: a confirmation
  earns "Don't ask again" only when it is repetitive **and** what it guards is
  recoverable. Removing a session or project is deliberately excluded — both can delete a
  directory with uncommitted work, and a checkbox that silences that forever eventually
  loses someone a day's work. Silenced keys are stored as the list of silenced ones, so
  the default is an absent key rather than a row that has to be written correctly — which
  is also what an older build's settings look like.
- `SettingsStoring` is a port: this package may not touch storage any more than it may
  spawn a process. `load` answering the defaults on a first launch or an unparseable file
  is expected behaviour, not an error.

### `view-state.ts`

**Why a store.** Pane focus lived in `SessionDetail`'s `useState` while the only thing
that moved it was a click. A menu chord, the jump list and a notification click all have
to reach the same focus and each originates outside that tree, so `focusTerminal` is the
single entry point — a second way to move pane focus would disagree with the first the
moment a notification arrives while the palette is open.

Everything here is this window's view of the mirror; none of it is on the wire, and
session **selection** stays on `SessionStore`, where the sidebar already reads it.

- Settings is a screen because a modal would leave the user reading settings through a
  scrim, and the navigation it needs — a search field, six panes *and* a row per
  project — has no room in a dialog. A project is a route rather than a seventh pane
  because there are as many as the user has added.
- `applyLayout` reads the mirror at the moment of the edit, not from a render: an edit
  applies to the layout on screen now.
- `focusTerminal` on an unknown id does nothing and notifies nobody, because a
  notification for a dropped terminal is not an error.
- The settings draft is a pair — current and as-last-saved — because every edit is an
  immutable update, so a new object *is* "the user changed something" and
  `hasUnsavedSettings` is reference inequality. A deep comparison would exist only to make
  a value typed back to its original un-savable. They live here so Back does not throw
  away what the user typed.
- `settingsDraftSaved` leaves the values on screen: clearing them would show the mirror's
  older answer until the broadcast arrives, which reads as the save being undone.
- `showSettings` without a route stays where settings last was, so ⌘, twice does not send
  someone back to the first tab.
- Registered surfaces are how Clear Scrollback reaches a viewport and how focus returns
  to the terminal; a pane in an unfocused tab is not mounted, so an absent handle is
  normal. They are **not** notified state — mount bookkeeping must not re-render the tree
  that just mounted. Unregistration deletes only if the handle is still the registered
  one, because a remount registers the new handle before the old one's cleanup runs. A
  focus call may find an unmounted surface: the pane renders after the notification and
  `TerminalSurface` focuses itself when `focused` becomes true.
- A change that changed nothing is not a notification: `focusNeighbour` on a single pane
  happens constantly.

### `local-layout.ts`

- `LocalLayoutEntry.base` is held by reference on purpose: it is how "the daemon changed
  the layout" is told from "the user dragged a divider", with no deep comparison and no
  revision counter on the wire.
- Validation and repair are `@janela/core`'s: a view that invented its own would be a
  second opinion about an invariant.
- **Which tab survives an adoption.** Splits and pane closes are daemon-persisted
  (protocol v4), so a split arrives as a whole new layout and adopting all of it would
  move the user off the tab they were looking at — the stored `focusedTabIndex` is
  whatever the last tab creation left. Tab selection is this window's, so it survives.
  The exception is the daemon moving it itself: `createTerminal` without a placement
  appends a focused tab, and following it is the whole point of ⌘T. The two are told apart
  by whether `focusedTabIndex` changed.
- `withFraction` takes a path because `resizeSplit` addresses a split by a terminal it
  contains, which cannot name the divider of an outer split whose children are both
  splits.
- `withFocusedTab` clamps rather than trusts.
- The five close scopes differ only in which run of indices they mean, so the arithmetic
  is one tested function rather than four handlers each deciding what "to the left" is.
  An index the layout does not have names nothing, because a terminal exiting anywhere can
  renumber the strip under an open menu. `"all"` does not read the tab it was opened on,
  so it still means every tab when that tab has just gone.

### `profile-draft.ts`

**The rule this file protects:** `command` is argv, edited one element at a time, because
the moment a field splits `claude --model opus` Janela owns a quoting bug class it does
not have.

**Why the editor does not edit the domain value.** `readonly string[]` and a `Record`
cannot represent what a user is halfway through typing — a blank variable name, two rows
that collide, a duplicate argument — and both are positional in a way React needs
identity for: remove argument 1 of three and an index-keyed list remounts 2 and 3, which
drops the caret out of the field being typed in.

- `argvOf` passes values through verbatim: a trailing empty argument and an argument of
  two spaces are both things a program can be given, and deciding they are mistakes would
  be us editing the user's command.
- `variableDrafts` sorts by name so the editor does not reorder itself when a value is
  saved and read back — object key order is insertion order, and a round trip through a
  JSON column need not preserve it.
- `environmentOf` drops blank names (a row started, not a variable called "") and keeps
  the last of a repeated name, matching what a process sees when its environment array
  carries a duplicate.
- `blankProfile` starts with one blank argv element, because `[]` would present a valid
  profile — the login shell — that the user did not ask for.

### `settings-draft.ts`

**Why every tab has a draft.** The panes used to apply as you type, which is right for a
preference and wrong for programs: applied per keystroke, `pnpm ins` is a real command
until the next character arrives, and a half-typed executable is what ⌘T offers meanwhile.
Once one surface needs a Save button the rest do too — a screen where some switches commit
instantly and others wait is one where the user cannot tell which did what.

Two deliberate consequences: switching tabs (and leaving settings entirely) keeps the
edits, because the draft lives in `ViewState`; and saving writes every tab's changes,
which is why the bar says how many.

Not here: actions, and the rules a save obeys. Stopping the background service happens
when pressed, and a draft would put the user's terminals in a state they have to remember
to confirm.

**Edits, not a copy.** A field holds the mirror's value *or* the user's, so an untouched
project keeps flowing from the daemon while another is edited and a save sends exactly
what was touched. Additions go last rather than in name order, because the row the user
just created should be where they can find it. `withoutDraftProfile` takes `stored`
because deleting a draft-only profile is a discard, and `removeLaunchProfile` for an id
the daemon never saw would be asking it to forget nothing.

---

## `shared/config`

### `commands.ts`

**Every shortcut must be one a terminal user will not miss.** `Ctrl`-anything belongs to
the running program, and ⌘K, ⌘L, ⌘D and friends are contested; we take the small set
macOS users expect from a document app and leave the rest alone. Splits and tabs are
⌘-based precisely because `Ctrl-b` and `Ctrl-a` belong to tmux and screen, and a user
running either inside Janela must not think about which layer ate their keystroke.
Anything reachable only through a menu is a feature we have half-shipped.

**Where they are bound.** The definitions live in the client because the UI acts on them;
the menu bar is built in `src-tauri` as a *real* menu, because a developer tool that fakes
the menu bar taxes every interaction. The shell is handed the table at startup and knows
nothing else about it, so adding a row here adds it to the menu bar *and* the palette with
no Rust change — the property that stops the two lists drifting.

- `app` is the application menu, where macOS expects Settings, About and Quit. Edit and
  Window hold only predefined items and are not represented.
- `section` is what puts a menu's separators in this table rather than re-deciding them in
  Rust.
- ⌘⇧O is the one shortcut worth spending, because it is how you get anywhere without the
  sidebar. The bracket pair is spent one level up from a multiplexer's: ⌘⇧[ / ⌘⇧] switch
  **sessions**, ⌘[ / ⌘] switch tabs, because switching sessions is what this app is judged
  on. ⌘W closes a **pane**; Quit is ⌘Q and the Window menu deliberately has no Close item.
  ⌘⌥arrow moves pane focus, because plain arrows and anything with `Ctrl` belong to the
  program.
- Copy and Paste are absent on purpose: they are the Edit menu's predefined items, which
  is what routes ⌘C/⌘V to the WebView and lets the terminal handle the DOM events itself.
- `COMMAND_BY_ID` is one derived structure rather than a lookup and a membership set that
  could disagree, and membership is asked with `Object.hasOwn` rather than `in`, because
  `"constructor"` is on every prototype chain and is not a command.
- `acceleratorCaps` renders the table's Tauri notation rather than storing a second
  spelling that could disagree, and joins on `+` because the menu draws a cap per token: a
  glyph string it cannot split — `⌘,`, `⌘⇧]` — lands in one wide cap beside chords that did.

### `profile-icons.ts`

`LaunchProfile.iconName` was an SF Symbol, then a Lucide name; the keys are **persisted**
in the daemon's database, so they stay what they were while the glyph behind each is
whatever the current icon set offers. Two consequences: an unrecognised name falls back to
the terminal glyph, never to nothing, because a profile rendering a hole is worse than one
rendering a terminal (and everything Janela launches is a command in a terminal, so the
fallback is never a lie); and it is a closed set, because Hugeicons ships thousands of
exports and naming them all would put every icon in the client bundle to serve a field the
user picks from a grid. A profile stored with an unknown name keeps it — we never rewrite
the user's row.

---

## `shared/lib`

### `fuzzy-match/`

One implementation, because the jump list and the palette must agree about what "matching"
means: a user who learns that `jan pt` finds `fix/pty` should not learn a second rule.
Deliberately small — tens of sessions and twenty-odd commands, where a proper
Smith-Waterman would be more code defending a difference nobody can see. Scoring favours
word starts and consecutive runs, which is what makes an acronym (`gts` → "Go to Session…")
and a prefix both behave; it is greedy with no backtracking. An empty query matches
everything with score `0`, leaving `tieBreak` in charge — the case the user sees most,
since the list is open before they type.

### `test-fakes/`

Not exported from `index.ts`, and nothing ships them. A client package may not import
another package's test fakes either, so where these overlap with `@janela/client`'s they
were written again rather than reached for.

- `fakeClientEnvironment` is deliberately not configurable: a test that cares what is in
  the mirror builds its own over `createStores()`.
- `environmentOver` runs over a **real mirror**, because the structural fakes can only
  prove what a view does with state it was handed, while this proves what the client stack
  *decides* when the daemon sends state and the user has chosen nothing.
- The recording ports refuse by default — `inertNativeShell` cancels the dialog,
  confirmations decline — because a test that has not said the user agreed must not observe
  the consequence of agreeing. `asked` holds every question whole so a test can assert on
  copy, though copy is tested where it is written.
- `recordingClipboard` starts empty, so `paste` answers `undefined`: the refusal a real
  clipboard gives, and the case a terminal must survive without sending a stray byte.
- `overlaidWindowControls` is a constant because the whole port is one boolean; its
  opposite is `NO_WINDOW_CONTROLS` in `shared/model`, which the browser client uses
  for real.
- `window-fixture`'s `subscribe` does nothing, because markup rendering never notifies —
  which is also the limit of what those fakes can prove.

### `web-platform/`

The ports a standards-compliant browser implements on its own, so the desktop app and
the browser client share one implementation rather than two drifting copies. They are
exported from the package index; the Tauri-only ports (Finder, Terminal.app,
`launchctl`) stay in `apps/desktop/src/adapters/` under `ClientEnvironment.local`.

- `clipboard.ts` — `navigator.clipboard`, no plugin: available to a WKWebView in a
  secure context, which `tauri://` is, and to a browser page over `https:` or
  `localhost`. Writing is allowed from a user gesture, which every call is; reading is
  the one WebKit can refuse, and a rejection answers `undefined` so the terminal
  receives nothing rather than a dialog. Never logged: the text, in either direction.
  Over plain `http://` on a tailnet IP the clipboard API is absent and every call is
  the refusal path — which is one reason the gateway is published through
  `tailscale serve` rather than by IP.
- `settings-storage.ts` — `localStorage` rather than a file: it is the page's own
  store, it survives an app update, and reaching for the filesystem would mean a
  Rust command, a permission and a path — for two numbers and a boolean. Nothing
  here is on the wire, because every field is about rendering or interrupting.
  Anything unreadable is the defaults, by the port's contract: settings that refuse
  to load must not stop the window from painting. Parsing is **field by field**:
  this is data an older build wrote, and one bad field must cost that field rather
  than every setting; the font size goes through `withTerminalFontSize`, so the
  bounds are enforced in one place. A silenced-confirmation key this build does not
  know is dropped rather than carried — a question that no longer exists must not
  silence the one that replaced it.
- `keyboard-commands.ts` — a `CommandSource` over `keydown`, for a client with no
  native menu bar to own the accelerators. `commandForChord` matches
  `Command.accelerator` against `KeyboardEvent.code` (layout-independent: `⌘⇧]` is
  `BracketRight` with shift, whatever `key` says) and **only ⌘**: `Ctrl-anything`
  belongs to the program in the terminal (AGENTS.md non-negotiable 4), so a chord
  with `ctrlKey` is nobody's command. The listener runs in the capture phase on
  `window`, ahead of xterm's own handler, and claims a match with `preventDefault`
  + `stopPropagation`. Chords the browser reserves for itself (⌘W, ⌘N, ⌘T, ⌘Q,
  ⌘,) never reach the page; the palette (⌘⇧P) lists every available command, so
  nothing is unreachable, only slower. It takes the command list as a parameter so
  the browser passes `availableCommands(false)` and never claims a chord for a
  command it cannot run. The third argument, `held`, is the modal that owns the
  keyboard: the source still claims the chord — a ⌘N over the folder picker must not
  fall through to the browser's new-window — but runs nothing while a picker is on
  screen, which is what a native panel does to the menu bar.

---

## `shared/ui`

### `context-menu-region.tsx`

**Why the rows are data.** The interesting part is which rows a context offers and which
are available, and a decision buried in JSX can only be tested by rendering a menu and
reading the DOM.

It also removes the bookkeeping error this menu invites: the registry's `MenuItem` is
numbered by its caller — the number is how the fluid-hover highlight finds the row's box —
and those numbers count *items*, not children, so a separator or label takes none. Written
by hand that is a silent off-by-one whenever a row is inserted. Keys come from labels
rather than array positions, because a menu whose rows change with the context would
otherwise re-key every row below the one that changed and remount rows that did not.

- `onOpen` exists for the one availability fact React does not hold — whether a terminal
  has a selection — and a state update there lands in the same event, so rows paint with
  the answer rather than a frame behind it.
- The popup opens down and to the right like every other context menu on the platform, and
  is narrower than the registry's 288px default because these rows are two or three words.
- Remaining props belong to the wrapper the trigger renders, because a tab is also a drop
  target and the region is where its drag handlers sit.

### `find-surface.tsx`

Both find surfaces are the same interaction with a different haystack; the interaction is
the registry's `CommandMenu` and what lives here is three decisions.

- **The ranking is ours and the menu does not re-filter it.** The menu's own filter is a
  word-substring test that would drop `jan pt` → `fix/pty` on the way to the list, so the
  query is controlled here, rows are re-ranked per keystroke, and the menu's filter accepts
  everything.
- **A session row carries its state.** `status` becomes a badge where a command's keycaps
  go — the one thing a row shows that the menu has no slot for, and "running" beside a name
  is why the palette can replace looking at the sidebar. Statuses are kept by row rather
  than read off the item the menu hands back, because `renderItem` is typed in the menu's
  own row data and a cast would promise the compiler something this file cannot see.
- Escape closes the sheet and Enter names what it will do, both from `CommandMenuShell`:
  the shell the menu asks to close is the dialog `SheetHost` already had.
- The input carries `data-autofocus`, because the sheet exists to be typed into.

### `project-icon.tsx`

**Why generated.** A sidebar of identically-shaped rows is read by name, one word at a
time, because position changes. A distinct picture per project is the cheapest thing that
makes a row recognisable before it is read, and generating it means nobody has to draw,
store or choose one.

**The seed is the directory, not the name and not the id.** A name is editable, so seeding
from it would repaint the icon on rename — the one moment the user is most sure which
project they are looking at. An id is stable but fresh every time the project is added, so
removing a folder and adding it back would produce a stranger. The directory is what a
project *is* (`domain-model.md` § Project): renaming keeps the icon, re-adding gets it
back, and two clones of one repository look different.

**The favicon seam.** `imageSource` is the whole extension point, and Base UI's `Avatar`
already owns the hard part — an image that fails to load falls back rather than leaving a
hole. Nothing passes it yet, and that is a data question: `Project` carries no icon field,
so wiring one is a `@janela/core` change, a migration and a protocol version.

- The avatar is decorative as a whole: the name is the row's text, and `DitherAvatar`
  labels itself with its seed — without `aria-hidden` every row would read out a filesystem
  path.
- Squared corners against the registry's `rounded-full`: a circle reads as a person, and
  this is a folder. The ring is squared separately, being a pseudo-element with its own
  radius.
- `animate={false}`: the registry sweeps cells in over 600ms on mount, and these mount
  constantly — typing in the filter remounts every surviving row, so the icons would
  shimmer while the user reads the names they are filtering.

### `window-chrome.tsx`

Two screens, one window: an inset sidebar on the window's surface, a bar above a raised
card, and the card. That was a claim written twice and drifting — settings had an uninset
sidebar, no way back from a collapsed one, and its form against the window frame.

- **`TRAFFIC_LIGHT_POSITION`.** The title bar is an overlay, so the lights sit inside the
  window on the sidebar's first row — the row that used to say the app's name 16px below a
  title bar already saying it. Two places have to agree and cannot import each other, so
  `apps/desktop`'s `window-controls.test.ts` holds the config to these numbers. Both are
  measured, not chosen: `x` puts the close button where the mark's left edge was, and `y`
  centres a 16pt button on a 28px row whose top is 16px down. **`y` is not the buttons' top
  edge** — tao resizes the title bar *container* to `buttonHeight + y` and moves the buttons
  only horizontally, leaving their top at `y - 10`. Measured on a running window through the
  accessibility API, because the arithmetic is AppKit's.
- **`WINDOW_CONTROLS_ROOM`** is 68px, and the row's own leading padding makes up the rest of
  the 74 the buttons occupy, so the next control clears the zoom button by a couple of pixels
  on the sidebar's row and six on the window bar's. Slack is room; overlap would be a bug,
  which is why this is not the exact remainder. `self-stretch` because an empty box in an
  `items-center` row is 0px tall, and a band you cannot hit is a window you cannot move.
- **`WINDOW_DRAG_REGION`** is `"deep"` so the whole row drags rather than only the element
  carrying it; Tauri's script walks up from whatever was pressed and stops at the first
  clickable thing, so buttons keep their clicks without opting out. Every row under the
  window's top edge needs it, because removing the system title bar took drag and
  double-click with it.
- **`WINDOW_GUTTER_REGION`** is `"true"` — a *bare* region, which Tauri's script honours only
  on a direct hit — and it goes on the three elements that own the chrome pixels no row
  covers: the sidebar wrapper (the strip above the column, left by the inset variant's `m-2`),
  the column itself (the gap between the window bar and the card, and the gutters around it)
  and the sidebar's header (its `p-2`, and the panel's `py-2` band once the header is pulled
  into it). Bare, not `"deep"`, because these elements are the whole window: `deep` would make
  a press on a terminal drag the window. Measured before the fix, presses in the window's top
  8px — 16px on the sidebar side — reached the WebView and matched no region at all: no drag,
  no double-click zoom, and a click the drag script had already swallowed. A row that stops
  short of the window's edge is a title bar with a dead strip along its top, which is exactly
  what a user reaches for first.
- **`SidebarChromeHeader`** is `SidebarHeader` pulled up into the panel's inset (`-mt-2`) with
  the 8px given back as padding (`pt-4`), so its box reaches the window's top edge while
  everything inside it — including the traffic lights' row — stays where macOS draws the
  buttons. Not in the drawer: a sheet has no inset to reclaim, and `-mt-2` there would hang the
  header above the sheet's own top.
- **`WindowControlsRoom`** renders nothing wherever the title bar is not an overlay — in
  fullscreen, and on any platform drawing controls above the WebView. The row is then simply
  empty at its leading end; the mark and the word "Janela" are not coming back as a fallback.
  Below the drawer breakpoint both the sidebar header and the window bar draw it, because the
  drawer is an overlay *above* the bar.
- **`SidebarTitleRow`** carries `mt-2` in the drawer, and is the one place that has to know
  it: the desktop panel is inset 8px by the `inset` variant's `py-2`, the drawer's sheet by
  nothing, and macOS draws the buttons at the same point either way.
- **`WindowBar`** sits on the window's surface rather than the card, because what it holds are
  *handles on* the card: on the card, tabs read as chrome the terminals grew; off it, the card
  is one object the tabs point at. Its top is 8px rather than 4 — the one asymmetry — which
  puts its centre line on the sidebar header's; invisible until the window controls moved into
  that row, since macOS draws them at a fixed point. It is a component rather than a class
  string because the bar is also a title bar, and a second row that forgot to say so is a band
  that looks draggable and is not.
- **`ContentCard`** both paints level 2 and *announces* it, so a menu opened from inside climbs
  from 2 rather than from the page — the announcement is why this is a component. The sidebar's
  `inset` variant paints nothing, so this card is the only thing separating content from the
  window behind it.
- **`PANE_REGION`** is deliberately not a card: a terminal is already raised and has its own
  edge, so a card behind it would be a second elevation saying the same thing twice.
- **`WINDOW_COLUMN`** exists because the primitive is asked not to paint (`surface={false}`)
  rather than overridden: `shadow-surface-2` is a project token `cn` cannot group with
  `shadow-none`, so both survive and the column keeps a hairline around the whole window —
  measured as a 1px ring at rgb(28,28,28) on a rgb(23,23,23) window.
- **`SIDEBAR_SCROLLER`** brings the scrollbar in off the edge, because the sidebar's
  resize/collapse rail is an 8px strip on the panel's inner edge and above the scroller in
  z-order: left flush, 8px of the track's 10px sit behind the rail, leaving the thumb
  unhoverable and a drag on it resizing the sidebar. A translate, not an offset, because the
  primitive positions its scrollbar with an inline `inset-inline-end` no class can outrank
  without `!important`.
- **`PANE_COLUMN`** lives here because both screens need it and a project's pane owns its own
  scroller, so it applies the measure itself.
- **`useIsSidebarOutOfLayout`** has a second case that is easy to miss: below the drawer
  breakpoint the panel is an overlay whatever `state` says, so a narrow window reports
  `"expanded"` while the sidebar is off screen. Reading only `state` there left the bar with no
  room and no trigger — the traffic lights landed on the tabs and there was no way to open the
  sidebar at all.
- **`ShowSidebarButton`** exists because collapsing is offcanvas (the list is names, and a
  column of initials would be useless), so the button that brings the sidebar back cannot live
  in it. It sits at the head of the window bar, where the space was not being used by tabs, and
  the traffic lights come with it — which is why neither bar has to know that the title bar is
  an overlay. The primitive's trigger brings its own tooltip naming the action for the state it
  is in.
- **`ShowSidebarBar`** renders nothing while the sidebar is in the layout, because a band
  holding one absent button is a band of nothing. Its row is a control tall even though the
  trigger is smaller, so the card does not jump 4px between the welcome screen and a session.
