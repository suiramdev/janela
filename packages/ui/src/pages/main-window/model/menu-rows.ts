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

import type { CommandID } from "../../../shared/config/index.ts";
import type { TabCloseScope } from "../../../shared/model/index.ts";
import type { MenuRow } from "../../../shared/ui/index.ts";
import type { SidebarActions } from "./sidebar-actions.ts";

export interface TerminalMenuTarget {
  readonly hasSelection: boolean;
  readonly copy: () => void;
  readonly paste: () => void;
  readonly clear: () => void;
  readonly splitRight: () => void;
  readonly splitDown: () => void;
  readonly newTerminal: () => void;
  readonly close: () => void;
}

export interface TabMenuTarget {
  readonly newTerminal: () => void;
  readonly splitRight: () => void;
  readonly splitDown: () => void;
  readonly close: (scope: TabCloseScope) => void;
  readonly index: number;
  readonly tabCount: number;
}

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
  splitRight: hugeicon(LayoutTwoColumnIcon),
  splitDown: hugeicon(LayoutTwoRowIcon),
  closeTab: hugeicon(Cancel01Icon),
  closeOthers: hugeicon(CancelCircleIcon),
  closeLeft: hugeicon(ArrowLeftDoubleIcon),
  closeRight: hugeicon(ArrowRightDoubleIcon),
} as const;

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
      onSelect: target.close,
    },
  ];
}

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
