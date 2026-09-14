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
 * 4. `SidebarProvider`'s keyboard shortcut is `⌘B` only. The registry copy also
 *    accepts `Ctrl-B`, which is tmux's prefix, and `Ctrl` belongs to the program
 *    running in the terminal (AGENTS.md § Non-negotiables 4).
 * 5. `command` is not vendored. It is built on `cmdk`, which brings Radix — a
 *    second primitive library beside Base UI, and one whose list binds `Ctrl-n`
 *    and `Ctrl-p`. The find surfaces compose `InputGroup`, `Item` and `Kbd`
 *    around their own ranking instead.
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
export {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuPortal,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "./components/ui/context-menu.tsx";
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
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu.tsx";
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
export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
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
