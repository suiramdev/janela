# `@janela/design`

Layer 7, client side. It knows nothing about projects or sessions and could be
lifted into another app — which is why `@janela/core` is deliberately absent from
its dependencies. `@base-ui/react`, `framer-motion` and `cn` are gated to this
package in `scripts/layers.ts`, for the same reason `@xterm/*` is gated to the two
terminal seams: a view that names the primitive library directly is a view that has
to be rewritten when it changes.

## `index.ts`

Registry primitives are re-exported **by name** rather than with `export *`, so this
list is the package's public surface and adding to it is a decision. The deliberate
omissions:

| Not exported | Why |
| --- | --- |
| `ComboboxChips` | the multiple-selection field; nothing in this window picks more than one of anything |
| `CommandMenuTabs`, `CommandMenuFilters` | filing rows under tabs is a second way to narrow a list beside typing; this window has one search surface on purpose |
| `SIDEBAR_WIDTH` from the vendored sidebar | the token in `tokens.ts` is the one the vendored copy reads; a second name for it is how the two drift |
| `useSizeContext`, `useTypeScale` | nothing switches the step at runtime (one window, one density), and the type scale would be a second vocabulary beside Tailwind's `text-*` |
| `surfaceHoverClasses` | a row's lit state is the interaction ladder (`bg-hover`), one token every row already shares with the sidebar's travelling highlight |

- `cn` is re-exported so the rest of the client composes Tailwind classes the way the
  primitives do; the `cn` package is gated here so a second merger cannot appear.
- One menu system, two roots: the popup is `DropdownContent` either way, and
  `ContextMenu` differs only in anchoring to the pointer.
- `Elevated` is the plain-div half of the surfaces system. Primitives whose element
  belongs to Base UI do its three lines by hand — there is no div of ours to wrap.
- `DitherAvatar` is deterministic in `name`: the same string is the same picture, in
  this window and the next one.
- `spring` / `exitFallbackMs` are the motion ladder; `exitFallbackMs` is derived from
  the tier so a deferred unmount's guard cannot drift from its exit. The CSS half of
  the same ladder is `--spring-*` in `src/styles.css`.

## `tokens.ts`

The bar for adding something: it is used in at least two places, or it encodes a
decision someone would otherwise get wrong. Everything else is a literal at the call
site, where it is easier to read.

Colours are semantic, not literal. There is no `janela.blue`, because a name like
that says nothing about when to use it and guarantees drift. Every `COLOR` entry is
defined once in the stylesheet for light, dark and increased contrast, so no
component branches on appearance. When the stack moved to a WebView the tokens did
not change — only where they resolve: an asset catalog that adapted through the
system became custom properties that adapt through `prefers-color-scheme` and
`prefers-contrast`.

- `SIDEBAR_WIDTH`'s three values are all load-bearing: the vendored sidebar starts at
  `ideal` and its rail clamps a drag to the other two, so this is the only place the
  window's navigation width is decided. Below the minimum, session names truncate
  uselessly — they sit indented under a project, so they start further right than the
  width alone suggests.
- `TERMINAL_INSETS` is asymmetric on purpose: the extra leading space keeps text off
  the window edge without making the first column look indented.
- `failure` is text and glyphs for a terminal that exited non-zero, including a failed
  automation command, whose terminal stays open showing exactly why.
- `TERMINAL_FONT_STACK` is only the default — Settings overrides it, and
  `xtermRendering` is what applies either one. SF Mono first because it ships with
  macOS, has the coverage agents need and hints well at small sizes; then a stack,
  because a WebView on another platform has to render something.
- The stack names `TERMINAL_SYMBOL_FONT` — `Symbols Nerd Font Mono` — before the
  generics because agent CLIs, starship prompts and `eza` draw from the Nerd Font
  private-use ranges, and no font that ships with macOS carries them. Naming a font
  the user may not have is a coin toss, so the application **ships** it:
  `src/fonts/SymbolsNerdFontMono-Regular.woff2` (Nerd Fonts v3.5.1, MIT, licence
  beside it) is declared as an `@font-face` in `styles.css`, which is why the
  family in this token always resolves. It lives in this package rather than in a
  client because `styles.css` does, and both the app and the web client import
  that: an icon is a property of the design, not of the shell around it. It
  carries the icon ranges and nothing else, so per-glyph fallback keeps SF Mono
  for text and asks it only for the codepoints the text fonts do not have. A user
  who names their own patched font in Settings never reaches it.
- Powerline separators are the exception that made this look like a font problem
  rather than a wiring one: xterm draws `U+E0B0`–`U+E0B7` itself, so those alone
  survive a stack with no icon coverage.
- Motion is **not** here. It lives in `lib/springs.ts`, because the tier says how big
  the thing that moves is and the number follows from that; a two-value `MOTION`
  constant here was a second, unused vocabulary for the same decision. A CSS
  transition cannot read TypeScript, so `styles.css` publishes the same ladder in
  milliseconds and `styles.test.ts` fails if the two drift. Either way the transition
  must respect `prefers-reduced-motion`, enforced once in `styles.css` for everything.
  A component that animates unconditionally is a bug, not a flourish.

## `styles.css` and `styles.test.ts`

The stylesheet lives here rather than in an app because two apps mount the same
views: `apps/desktop` and `apps/web` both `import "@janela/design/styles.css"`
(the package's second export), and Tailwind's `@source` lines name the three
client packages relative to this file. It holds the tokens as custom properties,
the four appearance blocks (`prefers-color-scheme` and `prefers-contrast`, never a
`.dark` class), the shadcn token set the vendored primitives read, the scroll
restyling, and the reduced-motion collapse. The token names are `tokens.ts`'s and
`styles.test.ts` pins the file to them.

The tokens are declared in TypeScript and consumed as CSS custom properties, and
nothing notices when the two disagree: a component reading an undefined property
paints transparent, and an appearance missing a token falls back to the light one.

- Custom properties inherit and the four appearance blocks have equal specificity, so
  the winning value is the one the *last* matching block declared — which is how an
  appearance can leave a token alone and still have one. `MATCHING_BLOCKS` encodes
  which blocks each appearance matches.
- The dark block must redefine **all eight** surface levels: `surfaceClasses` hands
  out `bg-surface-N shadow-surface-N` as literal strings, and a missing level paints
  transparent — which, since the window itself is level 1, is a black-on-black window
  rather than an obvious mistake.
- The shadows are a **ladder**: `shadow-5` is `shadow-4` plus one more, further,
  softer drop. That is what makes a dialog read as further from the page than a menu,
  and it is the part that is easy to lose by hand — the dark ladder once carried a
  single drop per level, so level 7 cast less than level 3.
- `bg-hover` is painted by the sidebar's travelling highlight *and* by rows that draw
  their own hover, so an appearance missing it makes one of the two invisible.
- `--overlay` must be an `R G B` triplet, because the scroll thumb composes it at
  three opacities: a missing or `oklch()` value makes the declaration invalid and the
  thumb invisible. Light inks black, dark inks white; Increase Contrast inherits,
  because contrast does not change which way the overlay tints.
- The scrim alphas must agree across light and dark and stay at or below 0.6. A black
  scrim is a dimmer — the same alpha removes the same fraction of whatever is behind
  it — and past ~60% the dark window (#171717) is indistinguishable from the black
  outside the window. It is Increase Contrast, not darkness, that asks for more. The
  defect this replaced: the vendored backdrops carried
  `bg-black/40 dark:bg-black/80`, and `dark:` is `prefers-color-scheme` here, so every
  dark user got 80% black composited to #050505 with the surface ladder crushed flat.
- The scroll-fade default must live in `@layer base`: an unlayered rule beats every
  `[--scroll-fade-size:…]` utility on source order alone, and the override would be
  silently ignored — nothing would look broken, it would just fade far too much. A
  48px fade is two rows of a 28px list, which is why the quick list and the tab strip
  both pass their own size. The file has two `@layer base` blocks; this is the second,
  the first being the border/font reset.
- The springs are the source and `--spring-*` is derived: a
  `duration-(--spring-moderate)` transition and a `spring.moderate` animation are the
  same decision, so re-tiering one and not the other is the drift this catches.

## The vendoring ledger

The tokens are hand-written. The controls under `components/` are vendored from a
registry, not authored here, and `.oxlintrc.json` turns every evidence rule off for
`src/components/**`, `src/hooks/**` and `src/lib/**` for that reason.

- `components/ui/*` — shadcn/ui, `base-mira` style, which is the Base UI variant
  rather than the Radix one. `components.json` here holds the configuration that
  decides where they land. Presets (`shadcn apply`) must run from `apps/desktop`, the
  only package whose framework the CLI detects, with a throwaway `components.json` and
  `@/*` pointed at this package. Icons are Hugeicons; app-level views import the same
  two packages rather than a wrapper here.
- `components/dither-kit/*` — Dither Kit (`npx @dither-kit/cli add avatar`), which is
  how a project gets an icon without anyone drawing one.

### Edits made on the way in

Vendored files are edited on the way in, and only in ways worth the drift.

1. Import specifiers become relative and carry their extension. Vite resolves this
   package through a workspace symlink and never reads its `tsconfig` paths, so the
   registry's `@/…` alias would build in the app and fail in a browser.
2. `"use client"` is dropped. There is no server component in a Tauri WebView.
3. Dither Kit's private `clsx`/`tailwind-merge` copy re-exports the `cn` package
   instead — one class merger per package, or conflicting Tailwind utilities resolve by
   different rules depending on which control you used.
4. `SidebarProvider`'s keyboard shortcut is `⌘B`, not the registry's bare `[`. A bare
   key is typed into whatever is running in a terminal, and `Ctrl-B` is tmux's prefix;
   the terminal owns the keyboard (AGENTS.md § Non-negotiables 4). The copy's
   text-field guard went with the change — xterm's focus target is a `<textarea>`.
5. shadcn's own `command` is still not vendored: it is built on `cmdk`, which brings
   Radix — a second primitive library beside Base UI, and one whose list binds `Ctrl-n`
   and `Ctrl-p`. Item 11 replaces it without either.
6. Fluid Hover (`hooks/use-fluid-hover.ts`, `fluid-hover-highlight.tsx`,
   `lib/springs.ts`) is the only thing here that uses `framer-motion`.
7. The sidebar is Fluid Functionalism's. Three of its seams are this application's:
   - **`Button` and `Tooltip` stay ours.** The registry's button has no `outline` or
     `destructive` variant — `--overwrite` would have silently unstyled thirty call
     sites — and its tooltip is a single `content` prop where this client composes
     `TooltipTrigger`/`TooltipContent`.
   - **Icons are Hugeicons.** `lib/icon-context.tsx` maps the three names the sidebar
     looks up, so `lucide-react` is not a dependency of a component rendering three
     glyphs.
   - **Widths are `SIDEBAR_WIDTH`**, so the rail cannot drag the sidebar to a size the
     rest of the window was not designed for.
8. The scroll area is a *system* rather than a component, and the reason to take the
   whole thing is its CSS payload: it restyles the **native** scrollbar under
   `@media (pointer: fine)`, reaching scrollers no component of ours owns — including
   xterm's own viewport, which no `ScrollArea` will ever wrap. It lives in
   `src/styles.css`, verbatim except for `--overlay`, an `R G B` triplet
   so the thumb can compose it at three opacities. On a touch-primary device the
   component drops the Base UI machinery for native overflow scrolling, which is why
   `use-touch-primary` exists and why `ScrollBar` renders nothing there.
9. `tabs.tsx` was edited to read the size ladder: its list carried a literal `h-8` and
   `p-[3px]`, which made a segmented control 4px taller than every other control beside
   it. The classes are plain rather than `group-data-horizontal/tabs:`-prefixed, because
   a prefixed utility wins on source order and would have taken the vertical override
   with it. Nothing else was rewired: the default `size` *is* the compact step (28px),
   and the 36px step exists for a density this application does not offer.
10. `lib/elevated.tsx` completes the surfaces system. Installing it was the small half;
    the large half is that every overlay now *climbs* the ladder instead of painting
    `bg-popover`: a menu two steps above its substrate with the shadow pinned to 3, a
    dialog four with the shadow pinned to 5, each re-providing its level so a submenu
    keeps climbing. `--popover` in dark appearance is the same value as `--surface-1`, a
    step *below* the card these overlays open over — so an overlay receded instead of
    rising, and two stacked ones were the same colour. `Tooltip` is deliberately left
    off the ladder: it is inverted ink, a label rather than a surface, and an elevation
    would make it a small dialog. The dark shadow ladder was rebuilt at the same time,
    because it mattered the moment levels 3–7 were in use: each step now keeps every
    drop below it instead of carrying a single one.
11. The command menu is Fluid Functionalism's, and it is what both find surfaces are
    drawn with. Its field claims four keys and no chords: ↑↓ move, Enter runs, Home/End
    jump while the query is empty, and a modified arrow is left to the caret.
    - **`CommandMenuDialog` is not vendored.** The registry's shell binds a global combo
      on `window`; this app's shortcuts are one table feeding the native menu, and the
      terminal owns every key that table does not claim. `CommandMenuShell` provides the
      same context — a way to close — around the sheet the app already had. The shortcut
      *matchers* went with the shell; the formatter that draws keycaps stayed.
    - One class had to be replaced rather than defined: the headings ask for
      `text-caption`, a size that lives in that site's own theme and ships with no
      registry item. Defining it as a token does not work either — `cn` reads an unknown
      `text-` name as a colour, so `text-caption` and `text-muted-foreground` become one
      group and the colour wins. It is an arbitrary length instead, which the merger
      reads as a size.
12. Menus are Fluid Functionalism's dropdown, which replaced the two base-mira menus —
    the last surfaces still painting `bg-popover` with a CSS keyframe and a
    `focus:bg-accent` row. Three parts were not vendored, because each is a feature this
    application does not have and would only have shipped as dead code: the inline
    `Dropdown` panel (settings here are `NativeSelect` and `RadioGroup`),
    `dropdown-search.tsx` (searching is the command menu's job), and the multi-select
    merge/split runs. Two things were added, and both are the context menu:
    - **`ContextMenu` and `ContextMenuTrigger`.** The registry ships none and does not
      need to: Base UI's is a Menu whose *positioner* anchors to the pointer, and every
      part below that is Menu's own — so the root provides `contextual: true` and
      `DropdownContent` swaps one component.
    - **`aria-label` on `DropdownContent`, `destructive` on `MenuItem`.** A dropdown is
      named by its trigger; a context menu's trigger is a region of the window, so the
      name has nowhere else to go. And a menu that can *remove* what it was opened over
      needs that row unmistakable before it is read.
13. The dialog is Fluid Functionalism's: a framer-motion panel four ladder steps above
    its substrate, sized by a ladder step instead of whatever `max-w` each caller wrote,
    and `position="top"` replacing a `top-24 translate-y-0` that had to fight the panel's
    own transform.
    - **`initialFocus` and `finalFocus` are named and forwarded.** The registry's panel
      spreads remaining props onto the `motion.div`, so left in that bag these two would
      have become DOM attributes Base UI never saw. Every sheet needs both: they open
      from a menu, a chord or the palette and have no trigger to restore focus to, and
      the field a sheet was opened to type in is frequently not the first tabbable one.
    - **The backdrop paints `bg-scrim`, not the registry's
      `bg-black/40 dark:bg-black/80`.** That `dark:` is Tailwind's own
      `prefers-color-scheme` variant and this application has no `.dark` class to gate
      it, so the 80% was what every dark user saw: a level-1 window (#171717)
      composited to #050505, with the surface ladder crushed flat behind it. A black
      scrim is a dimmer, so one alpha serves both appearances, and it is Increase
      Contrast that asks for more of it. The sheet and the sidebar's drawer paint the
      same class so a fourth overlay cannot arrive with its own opinion.
    - `DialogOverlay` and `DialogPortal` are gone: the panel owns both, and nothing else
      rendered them.
14. The combobox is the one field in the window that both picks from a list and accepts
    a name the list does not have — which is what "the branch, or a new branch" is. It
    was **not installed with the CLI**: its `registryDependencies` are thirteen items,
    twelve already vendored and adapted, and `shadcn add` offers to overwrite each one.
    The two files were taken from the item's JSON (`jq -r '.files[0].content'`) with the
    usual two edits. `use-merge-split` came with it although item 12 had refused it:
    here the list imports it directly to paint one background across a run of adjacent
    picks, so pruning it would be a rewrite of the primitive rather than an omission —
    the file is vendored whole and `ComboboxChips` is simply not exported.
