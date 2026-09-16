import {
  ArrowLeftDoubleIcon,
  ArrowRightDoubleIcon,
  Cancel01Icon,
  CancelCircleIcon,
  ClipboardPasteIcon,
  ComputerTerminal01Icon,
  Copy01Icon,
  Delete02Icon,
  Eraser01Icon,
  FolderAddIcon,
  FolderOpenIcon,
  LayoutTwoColumnIcon,
  LayoutTwoRowIcon,
  PlusSignIcon,
  Search01Icon,
  Settings01Icon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import type { Project, Session } from "@janela/core";
import { hugeicon } from "@janela/design";

import type { CommandID } from "./commands.ts";
import type { MenuRow } from "./context-menu-region.tsx";
import type { TabCloseScope } from "./layout-edits.ts";
import type { SidebarActions } from "./sidebar-actions.ts";

/**
 * What each part of the window offers on a right-click.
 *
 * Pure functions over data, for the reason in `context-menu-region.tsx`: the
 * decisions here are which rows a context has and which of them are available,
 * and both are worth a test that does not render a menu.
 *
 * ## What belongs in a context menu
 *
 * Only actions about **the thing under the pointer**. A context menu is not a
 * second menu bar: `COMMANDS` acts on the selection and is reachable from ⌘⇧P
 * and the menu bar, and repeating all of it on every surface would make the
 * gesture worthless — the reason to right-click a project you have not opened
 * is that the menu is about *that project*.
 *
 * So a row appears here when it names its subject ("New Session in janela",
 * "Close Terminal"), and stays out when it is a window-wide command that the
 * two places built for them already carry.
 */

const ICON = {
  newSession: hugeicon(PlusSignIcon),
  newTerminal: hugeicon(ComputerTerminal01Icon),
  reveal: hugeicon(FolderOpenIcon),
  terminal: hugeicon(TerminalIcon),
  settings: hugeicon(Settings01Icon),
  remove: hugeicon(Delete02Icon),
  addProject: hugeicon(FolderAddIcon),
  search: hugeicon(Search01Icon),
  copy: hugeicon(Copy01Icon),
  paste: hugeicon(ClipboardPasteIcon),
  clear: hugeicon(Eraser01Icon),
  // The same two glyphs the strip's split buttons carry: one control, one
  // picture of what it does to the pane.
  splitRight: hugeicon(LayoutTwoColumnIcon),
  splitDown: hugeicon(LayoutTwoRowIcon),
  // The same ✕ the tab carries, for the row that does what the ✕ does; the
  // arrows say which side of the pointed-at tab goes, which is the only thing
  // the four bulk closes differ by.
  closeTab: hugeicon(Cancel01Icon),
  closeOthers: hugeicon(CancelCircleIcon),
  closeLeft: hugeicon(ArrowLeftDoubleIcon),
  closeRight: hugeicon(ArrowRightDoubleIcon),
} as const;

/** A project row in the sidebar. */
export function projectMenuRows(project: Project, actions: SidebarActions): readonly MenuRow[] {
  return [
    { kind: "label", label: project.name },
    {
      kind: "item",
      label: "New Session…",
      icon: ICON.newSession,
      onSelect: () => actions.newSession(project.id),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Reveal in Finder",
      icon: ICON.reveal,
      onSelect: () => actions.revealInFinder(project.directory),
    },
    {
      kind: "item",
      label: "Open in Terminal",
      icon: ICON.terminal,
      onSelect: () => actions.openInTerminal(project.directory),
    },
    {
      kind: "item",
      // No ellipsis: this one goes somewhere rather than asking something. The
      // form is a pane in the settings screen, not a dialog over this row.
      label: "Project Settings",
      icon: ICON.settings,
      onSelect: () => actions.openProjectSettings(project.id),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Remove Project…",
      icon: ICON.remove,
      destructive: true,
      onSelect: () => actions.removeProject(project),
    },
  ];
}

/** A session row in the sidebar. */
export function sessionMenuRows(session: Session, actions: SidebarActions): readonly MenuRow[] {
  return [
    { kind: "label", label: session.name },
    {
      kind: "item",
      label: "New Terminal",
      icon: ICON.newTerminal,
      onSelect: () => actions.newTerminal(session.id),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Reveal in Finder",
      icon: ICON.reveal,
      onSelect: () => actions.revealInFinder(session.directory),
    },
    {
      kind: "item",
      label: "Open in Terminal",
      icon: ICON.terminal,
      onSelect: () => actions.openInTerminal(session.directory),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Remove Session…",
      icon: ICON.remove,
      destructive: true,
      onSelect: () => actions.removeSession(session),
    },
  ];
}

/**
 * The window itself: the sidebar's empty space, the bar, the welcome card.
 *
 * The only place a context menu carries window-wide commands, because here
 * there is nothing else under the pointer — and it carries the three that start
 * something, not the whole table.
 */
export function windowMenuRows(dispatch: (id: CommandID) => void): readonly MenuRow[] {
  return [
    {
      kind: "item",
      label: "New Session…",
      icon: ICON.newSession,
      onSelect: () => dispatch("newSession"),
    },
    {
      kind: "item",
      label: "Add Project…",
      icon: ICON.addProject,
      onSelect: () => dispatch("addProject"),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Search…",
      icon: ICON.search,
      onSelect: () => dispatch("showCommands"),
    },
  ];
}

/** What a terminal offers. `hasSelection` decides whether Copy is available. */
export interface TerminalMenuTarget {
  /** Whether anything is selected in this terminal — Copy's availability. */
  readonly hasSelection: boolean;
  readonly copy: () => void;
  readonly paste: () => void;
  readonly clear: () => void;
  readonly splitRight: () => void;
  readonly splitDown: () => void;
  readonly newTerminal: () => void;
  readonly close: () => void;
}

/**
 * A terminal pane.
 *
 * Copy first, and disabled with nothing selected: this is the menu a user opens
 * to move text, and the two rows that do it are why the gesture exists in a
 * terminal at all. Clearing is *this client's view* — the daemon keeps the
 * scrollback, which is what makes it safe to offer here.
 */
export function terminalMenuRows(target: TerminalMenuTarget): readonly MenuRow[] {
  return [
    {
      kind: "item",
      label: "Copy",
      icon: ICON.copy,
      disabled: !target.hasSelection,
      onSelect: target.copy,
    },
    { kind: "item", label: "Paste", icon: ICON.paste, onSelect: target.paste },
    { kind: "separator" },
    {
      kind: "item",
      label: "Split Right",
      icon: ICON.splitRight,
      onSelect: target.splitRight,
    },
    {
      kind: "item",
      label: "Split Down",
      icon: ICON.splitDown,
      onSelect: target.splitDown,
    },
    {
      kind: "item",
      label: "New Terminal",
      icon: ICON.newTerminal,
      onSelect: target.newTerminal,
    },
    { kind: "separator" },
    { kind: "item", label: "Clear", icon: ICON.clear, onSelect: target.clear },
    {
      kind: "item",
      label: "Close Terminal",
      icon: ICON.remove,
      destructive: true,
      // Never disabled, and never guarded here: closing goes through
      // `closeTerminals`, which is what names the cost of closing the last one.
      // The pane's own ✕ is the same call.
      onSelect: target.close,
    },
  ];
}

/** What a tab in the strip offers. */
export interface TabMenuTarget {
  readonly newTerminal: () => void;
  readonly splitRight: () => void;
  readonly splitDown: () => void;
  /** Closes the tabs a scope names, this one included when it names it. */
  readonly close: (scope: TabCloseScope) => void;
  /** Where this tab sits in the strip, and how long the strip is. */
  readonly index: number;
  readonly tabCount: number;
}

/**
 * A tab in the strip.
 *
 * The five closes are the reason this menu is worth opening on a tab you are
 * not in: the ✕ closes one, and everything else — the rest, one side, all of
 * them — is a gesture that would otherwise be a click per tab. They are one
 * section because they do one thing in five sizes, and all five are marked
 * destructive: a row that ends *more* programs must not look safer than the one
 * above it.
 *
 * Availability is arithmetic, and dimmed rather than hidden: a menu whose rows
 * move depending on where in the strip you clicked cannot be learned. The left
 * and right rows are unavailable at the ends, "others" with nothing else open,
 * and closing every tab is always possible because there is always this one.
 */
export function tabMenuRows(target: TabMenuTarget): readonly MenuRow[] {
  const { close, index, tabCount } = target;
  return [
    {
      kind: "item",
      label: "New Terminal",
      icon: ICON.newTerminal,
      onSelect: target.newTerminal,
    },
    { kind: "item", label: "Split Right", icon: ICON.splitRight, onSelect: target.splitRight },
    { kind: "item", label: "Split Down", icon: ICON.splitDown, onSelect: target.splitDown },
    { kind: "separator" },
    {
      kind: "item",
      label: "Close Tab",
      icon: ICON.closeTab,
      destructive: true,
      onSelect: () => close("this"),
    },
    {
      kind: "item",
      label: "Close Other Tabs",
      icon: ICON.closeOthers,
      destructive: true,
      disabled: tabCount <= 1,
      onSelect: () => close("others"),
    },
    {
      kind: "item",
      label: "Close Tabs to the Left",
      icon: ICON.closeLeft,
      destructive: true,
      disabled: index <= 0,
      onSelect: () => close("left"),
    },
    {
      kind: "item",
      label: "Close Tabs to the Right",
      icon: ICON.closeRight,
      destructive: true,
      disabled: index >= tabCount - 1,
      onSelect: () => close("right"),
    },
    {
      kind: "item",
      label: "Close All Tabs",
      icon: ICON.remove,
      destructive: true,
      onSelect: () => close("all"),
    },
  ];
}
