/**
 * `@janela/design` — layer 7, client side. The visual constants, and the
 * primitives every screen builds on.
 *
 * Knows nothing about projects or sessions; it could be lifted into another app.
 * That constraint is what keeps it a design system rather than a pile of Janela
 * views, and it is why `@janela/core` is deliberately absent from its dependencies.
 *
 * ## Tokens, and vendored primitives
 *
 * The tokens are hand-written. The controls under `components/` are **vendored
 * from a registry**, not authored here:
 *
 * - `components/ui/*` — shadcn/ui, `base-mira` style, which is the Base UI
 *   (`@base-ui/react`) variant rather than the Radix one. Installed with
 *   `bunx shadcn@latest add <name>`; `components.json` here holds the
 *   configuration that decides where they land. Presets (`shadcn apply`) must
 *   run from `apps/desktop`, the only package whose framework the CLI detects,
 *   with a throwaway `components.json` and `@/*` path pointed at this package.
 *   Icons are Hugeicons, rendered through `HugeiconsIcon`; the app-level views
 *   import the same two packages rather than a wrapper here.
 * - `components/dither-kit/*` — Dither Kit, installed with
 *   `npx @dither-kit/cli add avatar`. It generates a deterministic avatar from a
 *   string on a canvas, which is how a project gets an icon without anyone
 *   drawing one.
 *
 * Vendored files are edited on the way in, and only in ways worth the drift:
 *
 * 1. Import specifiers become relative and carry their extension. The registry
 *    emits `@/components/ui/button`; Vite resolves this package through a
 *    workspace symlink and never reads its `tsconfig` paths, so an alias here
 *    would build in the app and fail in a browser.
 * 2. `"use client"` is dropped. There is no server component in a Tauri WebView.
 * 3. Dither Kit's private `clsx`/`tailwind-merge` copy re-exports the `cn`
 *    package instead — one class merger per package, or conflicting Tailwind
 *    utilities resolve by different rules depending on which control you used.
 * 4. `SidebarProvider`'s keyboard shortcut is `⌘B`, not the registry's bare `[`.
 *    A bare key is typed into whatever is running in a terminal; `Ctrl-B` is
 *    tmux's prefix. The terminal owns the keyboard (AGENTS.md §
 *    Non-negotiables 4), so the binding takes ⌘ and the copy's text-field guard
 *    is gone with it — xterm's focus target is a `<textarea>`.
 * 5. shadcn's own `command` is still not vendored. It is built on `cmdk`, which
 *    brings Radix — a second primitive library beside Base UI, and one whose
 *    list binds `Ctrl-n` and `Ctrl-p`. Fluid Functionalism's command menu
 *    (item 11) replaces it without either: no `cmdk`, and no `Ctrl` chord.
 * 6. Fluid Hover (`hooks/use-fluid-hover.ts`, `components/ui/fluid-hover-highlight.tsx`,
 *    `lib/springs.ts`) comes from the Fluid Functionalism registry
 *    (`npx shadcn@latest add https://www.fluidfunctionalism.com/r/use-fluid-hover.json`)
 *    and is the only thing here that uses `framer-motion`. Its highlight paints
 *    `bg-hover`.
 * 7. The sidebar is Fluid Functionalism's
 *    (`npx shadcn@latest add https://www.fluidfunctionalism.com/r/base/sidebar.json`):
 *    `components/ui/sidebar.tsx` plus `sidebar-core.tsx` and `sidebar-menu.tsx`,
 *    over the `lib/` context system it reads (`size`, `shape`, `surface`,
 *    `icon`, `font-weight`). Three of its seams are this application's, not the
 *    registry's, and each would otherwise have pulled a second convention in:
 *
 *    - **`Button` and `Tooltip` stay ours.** The registry's button has no
 *      `outline` or `destructive` variant — `--overwrite` would have silently
 *      unstyled thirty call sites — and its tooltip is a single `content` prop
 *      where this client composes `TooltipTrigger`/`TooltipContent`. The two
 *      tooltips inside the vendored copy were rewritten to the composition.
 *    - **Icons are Hugeicons.** `lib/icon-context.tsx` maps the three names the
 *      sidebar looks up onto `HugeiconsIcon`, so `lucide-react` is not a
 *      dependency of a component that renders three glyphs.
 *    - **Widths are `SIDEBAR_WIDTH` from `tokens.ts`**, so the rail cannot drag
 *      the sidebar to a size the rest of the window was not designed for.
 *
 *    Its surface and interaction tokens (`--surface-1…8`, `--shadow-1…8`,
 *    `--hover`, `--active`, `--selected`, `--focus-ring`) live in
 *    `apps/desktop/src/styles.css` with the rest, and the window itself is
 *    level 1 of that ladder.
 * 8. The scroll area is Fluid Functionalism's too
 *    (`npx shadcn@latest add …/r/base/scroll-area.json`), and it is a *system*
 *    rather than a component: `components/ui/scroll-area.tsx` and
 *    `hooks/use-touch-primary.ts`, plus the CSS the registry item ships as its
 *    `css` payload — `.scroll-fade`, `.scroll-divider`, and a restyle of the
 *    **native** scrollbar under `@media (pointer: fine)`. That last part is the
 *    reason to take the whole thing: it reaches the scrollers no component of
 *    ours owns, including xterm's own viewport, which no `ScrollArea` will ever
 *    wrap. It lives in `apps/desktop/src/styles.css`, verbatim except for
 *    `--overlay` — the ink an overlay tints with, as an `R G B` triplet, so the
 *    thumb can compose it at three opacities.
 *
 *    On a touch-primary device the component drops the whole Base UI machinery
 *    for native overflow scrolling, which is why `use-touch-primary` exists and
 *    why `ScrollBar` renders nothing there.
 *
 * 9. `lib/size-context.tsx` — the size ladder — arrived with the sidebar, and
 *    `tabs.tsx` was edited to read it: its list carried a literal `h-8` and
 *    `p-[3px]`, which made a segmented control 4px taller than every other
 *    control beside it. A segmented control *is* a control, so its box is the
 *    ladder's step and its padding the ladder's `segmentPad`. The classes are
 *    plain rather than `group-data-horizontal/tabs:`-prefixed, because a
 *    prefixed utility wins on source order and would have taken the vertical
 *    override with it.
 *
 *    Nothing else here was rewired: `Button` and the rest keep an explicit
 *    `size` prop, whose default *is* the compact step (28px), and the 36px step
 *    exists for a density this application does not offer.
 *
 * 10. `lib/elevated.tsx` completes the surfaces system
 *    (`npx shadcn@latest add …/r/elevated.json`), whose other three files —
 *    `surface-context`, `surface-classes` and the token ladder — arrived with
 *    the sidebar. Verbatim apart from the import paths and the dropped
 *    `"use client"`.
 *
 *    Installing it was the small half. The large half is that every overlay now
 *    *climbs* the ladder instead of painting `bg-popover`: a menu is two steps
 *    above its substrate with the shadow pinned to 3, a dialog or sheet four
 *    steps with the shadow pinned to 5, and each re-provides its own level so a
 *    submenu keeps climbing. `--popover` in dark appearance is the same value as
 *    `--surface-1`, which is a step *below* the card these overlays open over —
 *    so an overlay receded instead of rising, and two stacked ones were the same
 *    colour.
 *
 *    `Tooltip` is deliberately left off the ladder: it is inverted ink
 *    (`bg-foreground`), a label rather than a surface, and giving it an
 *    elevation would make it a small dialog.
 *
 *    The dark shadow ladder in `apps/desktop/src/styles.css` was rebuilt from
 *    the registry's at the same time, because it mattered the moment levels 3–7
 *    were in use: each step now keeps every drop below it instead of carrying a
 *    single one, and the inset highlight and hairline ramp with the level. One
 *    simplification is recorded there — the outer edge is one alpha rather than
 *    a ramp from 12% to 22%.
 *
 * 11. The command menu is Fluid Functionalism's
 *    (`npx shadcn@latest add …/r/base/command-menu.json`):
 *    `components/ui/command-menu.tsx` over `lib/popup.ts` and
 *    `components/ui/tabs-subtle.tsx`, and it is what both of this app's find
 *    surfaces are drawn with. It answers item 5 — a palette with rows,
 *    headings, keycaps and a hint strip, on Base UI and `framer-motion`
 *    instead of `cmdk` and Radix — and its field claims four keys and no
 *    chords: ↑↓ move, Enter runs, Home/End jump while the query is empty, and
 *    a modified arrow is left to the caret.
 *
 *    Two adaptations beyond the usual paths:
 *
 *    - **`CommandMenuDialog` is not vendored.** The registry's shell is a
 *      dialog that binds a global combo on `window`; this app's shortcuts are
 *      one table (`commands.ts`) feeding the native menu, and the terminal owns
 *      every key that table does not claim. `CommandMenuShell` replaces it: it
 *      provides the same context — the one thing the shell owes the menu is a
 *      way to close it — around the sheet the app already had. The shortcut
 *      *matchers* went with the shell; the formatter that draws keycaps stayed.
 *    - **The strict-index and `exactOptionalPropertyTypes` reads are fixed in
 *      place** (four of them, all mechanical): an end of the enabled-row list,
 *      a token in a shortcut string, the tab a wrapped index lands on, and an
 *      absent icon passed as `undefined`.
 *
 *    One class had to be replaced rather than defined: the section headings ask
 *    for `text-caption`, a size that lives in that site's own theme and ships
 *    with no registry item. Defining it as a token does not work either — `cn`
 *    reads an unknown `text-` name as a colour, so `text-caption` and the
 *    heading's `text-muted-foreground` become one group and the colour wins. It
 *    is an arbitrary length instead, which the merger reads as a size. The
 *    subtle tabs' `.scrollbar-hide` is in `apps/desktop/src/styles.css`.
 *
 * 12. Menus — every one in the window — are Fluid Functionalism's dropdown
 *    (`npx shadcn@latest add …/r/base/dropdown.json`):
 *    `components/ui/dropdown.tsx` and `components/ui/menu-item.tsx` over
 *    `lib/popup.ts`. It replaced the two base-mira menus (`dropdown-menu.tsx`
 *    and `context-menu.tsx`), which were the last surfaces in the window still
 *    painting `bg-popover` with a CSS keyframe and a `focus:bg-accent` row: the
 *    popup is now an `Elevated` two steps above its substrate with the shadow
 *    pinned, the rows are the fluid-hover fill, and the open and close are
 *    `spring.fast` with the primitive's unmount deferred until the exit lands.
 *
 *    Three parts of it were not vendored, because each is a feature this
 *    application does not have and would only have shipped as dead code: the
 *    inline `Dropdown` panel (settings here are `NativeSelect` and
 *    `RadioGroup`), `dropdown-search.tsx` (searching is the command menu's job,
 *    item 11), and the multi-select merge/split runs with the
 *    `use-merge-split` hook they need — no menu here checks more than one row.
 *
 *    Two things were added, and both are the context menu:
 *
 *    - **`ContextMenu` and `ContextMenuTrigger`.** The registry ships no
 *      context menu and does not need to: Base UI's is a Menu whose
 *      *positioner* anchors to the pointer instead of to a trigger, and every
 *      part below that — portal, popup, item, group — is literally Menu's own.
 *      So the root provides `contextual: true` and `DropdownContent` swaps one
 *      component; the surface, the hover, the spring and the dismissal are the
 *      same code the dropdown uses.
 *    - **`aria-label` on `DropdownContent`, and `destructive` on `MenuItem`.** A
 *      dropdown is named by its trigger; a context menu's trigger is a region of
 *      the window, so the name has nowhere else to go. And a menu that can
 *      *remove* what it was opened over needs that row to be unmistakable
 *      before it is read — the base-mira row had the same variant.
 *
 * 13. The **dialog** is Fluid Functionalism's
 *    (`npx shadcn@latest add …/r/base/dialog.json`): a framer-motion panel and
 *    backdrop on `spring.slow`, four ladder steps above its substrate, sized
 *    by `sm` / `lg` / `xl` and positioned `center` or `top`. It replaced the
 *    base-mira dialog, whose enter was a CSS keyframe and whose width was
 *    whatever `max-w` each caller wrote — so every sheet in the window now
 *    picks a step of one ladder (`sheets.tsx` § SHEET_SHAPE) instead of a
 *    Tailwind class, and `position="top"` replaced a `top-24 translate-y-0`
 *    that had to fight the panel's own transform.
 *
 *    Two adaptations, and both are props the primitive owns:
 *
 *    - **`initialFocus` and `finalFocus` are named and forwarded.** The
 *      registry's panel spreads its remaining props onto the `motion.div`, so
 *      left in that bag these two would have become DOM attributes and Base UI
 *      would never have seen them. Every sheet here needs both: they open from
 *      a menu, a chord or the palette and so have no trigger to restore focus
 *      to, and the field a sheet was opened to type in is frequently not the
 *      first tabbable one.
 *    - **The shadow is pinned to 5, and the merged inline style is cast once.**
 *      A modal is the top of the ladder wherever it was opened from, and the
 *      scrim is what separates it from the window — the same adaptation the
 *      base-mira dialog carried. The cast is `exactOptionalPropertyTypes`
 *      against framer-motion's `MotionStyle`, which declares its properties
 *      without `| undefined`; no value is narrowed by it.
 *
 *    `x` joined the icon table for its corner close (item 5's table is the
 *    registry's contract, so the glyph is looked up by the Lucide name).
 *    `DialogOverlay` and `DialogPortal` are gone: the panel owns both, and
 *    nothing else rendered them. `DialogFooter`'s `showCloseButton` went with
 *    them — no footer in the app used it.
 *
 * `@base-ui/react` is gated to this package in `scripts/layers.ts`, for the same
 * reason `@xterm/*` is gated to the two terminal seams: a view that names the
 * primitive library directly is a view that has to be rewritten when it changes.
 */

export * from "./tokens.ts";

// ---- The class merger. Re-exported so the rest of the client composes Tailwind
// classes the same way the primitives do; `scripts/layers.ts` gates the package
// itself to here so a second merger cannot appear.
export { cn } from "cn";

// ---- Registry primitives. Re-exported by name rather than with `export *`, so
// this list is the package's public surface and adding to it is a decision.
export { Alert, AlertAction, AlertDescription, AlertTitle } from "./components/ui/alert.tsx";
export { Avatar, AvatarFallback, AvatarImage } from "./components/ui/avatar.tsx";
export { Badge, badgeVariants } from "./components/ui/badge.tsx";
export { Button, buttonVariants } from "./components/ui/button.tsx";
export {
  ButtonGroup,
  ButtonGroupSeparator,
  ButtonGroupText,
} from "./components/ui/button-group.tsx";
export {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./components/ui/collapsible.tsx";
// One menu system, two roots. The popup — surface, fluid hover, spring,
// dismissal — is `DropdownContent` either way; `ContextMenu` anchors it to the
// pointer and `DropdownMenu` to a trigger. `MenuItem` is the row in both.
// `Dropdown`'s inline panel, its search field and its multi-select runs are not
// vendored: see item 12 above.
export {
  ContextMenu,
  ContextMenuTrigger,
  DropdownContent,
  DropdownLabel,
  DropdownMenu,
  DropdownSeparator,
  DropdownTrigger,
  type DropdownContentProps,
} from "./components/ui/dropdown.tsx";
export { MenuItem } from "./components/ui/menu-item.tsx";
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog.tsx";
export {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./components/ui/empty.tsx";
export {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from "./components/ui/field.tsx";
export { Input } from "./components/ui/input.tsx";
export {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "./components/ui/input-group.tsx";
export {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemHeader,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "./components/ui/item.tsx";
export { Kbd, KbdGroup } from "./components/ui/kbd.tsx";
export { Label } from "./components/ui/label.tsx";
// The command menu, as much of it as this client draws. `CommandMenuTabs` and
// `CommandMenuFilters` stay unexported: a palette that files its rows under
// tabs is a second way to narrow a list beside typing, and this window has one
// search surface on purpose.
export {
  CommandMenu,
  CommandMenuEmpty,
  CommandMenuFooter,
  CommandMenuInput,
  CommandMenuItem,
  CommandMenuList,
  CommandMenuShell,
  CommandMenuShortcut,
  type CommandMenuHint,
  type CommandMenuItemData,
} from "./components/ui/command-menu.tsx";
export {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from "./components/ui/native-select.tsx";
export { RadioGroup, RadioGroupItem } from "./components/ui/radio-group.tsx";
export { ScrollArea, ScrollBar } from "./components/ui/scroll-area.tsx";
export { Separator } from "./components/ui/separator.tsx";
export { Skeleton } from "./components/ui/skeleton.tsx";
export { Spinner } from "./components/ui/spinner.tsx";
export { Switch } from "./components/ui/switch.tsx";
export { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs.tsx";
// The sidebar's own constants are deliberately absent: `SIDEBAR_WIDTH` is the
// token in `tokens.ts`, which the vendored copy reads, and a second name for it
// on this surface is how the two drift.
export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupActions,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuActions,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from "./components/ui/sidebar.tsx";
// The size ladder. `SizeProvider` pins a subtree to a step; `useSize` is how a
// surface asks how tall a control is instead of writing `h-7`; `sizeMap` is the
// same ladder as data, for the module-scope class constants and the tests that
// pin them to it. `useSizeContext` and `useTypeScale` are deliberately absent:
// nothing here switches the step at runtime — one window, one density — and the
// type scale would be a second vocabulary beside Tailwind's `text-*`.
export {
  sizeMap,
  SizeProvider,
  useSize,
  useSizeVariant,
  type SizeClasses,
  type SizeVariant,
} from "./lib/size-context.tsx";
export { ShapeProvider, useShape, type ShapeVariant } from "./lib/shape-context.tsx";
export { SurfaceProvider, useSurface } from "./lib/surface-context.tsx";
export { surfaceClasses } from "./lib/surface-classes.ts";
// The plain-div half of the surfaces system: it reads the substrate, paints the
// level above it, and re-provides that level so the next surface keeps climbing.
// Primitives whose element belongs to Base UI do those three lines by hand —
// there is no div of ours to wrap. `surfaceHoverClasses` is deliberately not
// exported: a row's lit state is the interaction ladder (`bg-hover`), which is
// one token every row already shares with the sidebar's travelling highlight.
export { Elevated } from "./lib/elevated.tsx";
export {
  hugeicon,
  IconProvider,
  type IconComponent,
  type IconComponentProps,
  type IconName,
} from "./lib/icon-context.tsx";
export { fontWeights } from "./lib/font-weight.ts";
export {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./components/ui/tooltip.tsx";

// ---- Generated avatars. `DitherAvatar` is deterministic in `name`: the same
// string is the same picture, in this window and in the next one.
export {
  DitherAvatar,
  type AvatarMirror,
  type DitherAvatarProps,
} from "./components/dither-kit/avatar.tsx";

// ---- Fluid Hover: one lit row, wherever the pointer is, plus the spring the
// highlight travels on. The hook measures and picks; the highlight paints. A
// view gets both from here because `framer-motion` is gated to this package.
export {
  useFluidHover,
  useRegisterFluidHoverItem,
  type ItemRect,
  type UseFluidHoverOptions,
  type UseFluidHoverReturn,
} from "./hooks/use-fluid-hover.ts";
export {
  FluidHoverHighlight,
  type FluidHoverHighlightProps,
} from "./components/ui/fluid-hover-highlight.tsx";
// The motion ladder itself: three tiers, an enter spring and a matching exit
// tween each. `exitFallbackMs` is the timer a deferred unmount guards its exit
// with, derived from the tier so the two cannot drift. The CSS half of the same
// ladder is `--spring-*` in apps/desktop/src/styles.css.
export { exitFallbackMs, spring } from "./lib/springs.ts";
