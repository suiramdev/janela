/**
 * Menu commands and their key equivalents.
 *
 * ## Principle
 *
 * Every shortcut here must be one a terminal user will not miss. **The terminal owns
 * the keyboard**: `Ctrl`-anything belongs to the running program, and ⌘K, ⌘L, ⌘D and
 * friends are contested. We take the small set macOS users expect from a document
 * app and leave the rest alone.
 *
 * This is also why splits and tabs are `⌘`-based and never `Ctrl`-based: `Ctrl-b` and
 * `Ctrl-a` belong to tmux and screen, and a user running either inside Janela must
 * not have to think about which layer ate their keystroke.
 *
 * Anything the user can do here must also be reachable without the mouse, and
 * anything reachable only through a menu is a feature we have half-shipped.
 *
 * ## Where these are bound
 *
 * The *definitions* live here, in the client, because the UI is what acts on them.
 * The native menu bar that surfaces them is built in `apps/desktop/src-tauri` — a
 * real menu, not an HTML imitation, because a developer tool that fakes the menu bar
 * costs its users a tax on every interaction. See
 * docs/decisions/0023-macos-first-portable.md.
 */
export interface Command {
  readonly id: CommandID;
  readonly title: string;
  /** Accelerator in Tauri's notation, e.g. `CmdOrCtrl+Shift+B`. */
  readonly accelerator?: string;
}

export type CommandID =
  // File
  | "newSession"
  | "newTerminal"
  | "openFolder"
  | "addProject"
  // Session
  | "goToSession"
  | "newBranchSession"
  | "nextSession"
  | "previousSession"
  | "revealInFinder"
  | "openInTerminal"
  // Terminal
  | "splitRight"
  | "splitDown"
  | "focusPaneLeft"
  | "focusPaneRight"
  | "focusPaneUp"
  | "focusPaneDown"
  | "restartTerminal"
  | "clearScrollback";

/**
 * The command table.
 *
 * ⌘⇧O is the one shortcut worth spending: it is how you get anywhere without
 * touching the sidebar, and it is the app's fastest path.
 *
 * Note ⌘⌥arrow for pane focus. Plain arrows, and anything with `Ctrl`, belong to the
 * program running in the terminal.
 */
export const COMMANDS: readonly Command[] = [
  { id: "newSession", title: "New Session", accelerator: "CmdOrCtrl+N" },
  { id: "newTerminal", title: "New Terminal", accelerator: "CmdOrCtrl+T" },
  { id: "openFolder", title: "Open Folder…", accelerator: "CmdOrCtrl+O" },
  { id: "addProject", title: "Add Project…", accelerator: "CmdOrCtrl+Alt+O" },

  { id: "goToSession", title: "Go to Session…", accelerator: "CmdOrCtrl+Shift+O" },
  { id: "newBranchSession", title: "New Branch Session…", accelerator: "CmdOrCtrl+Shift+B" },
  { id: "nextSession", title: "Next Session", accelerator: "CmdOrCtrl+Shift+]" },
  { id: "previousSession", title: "Previous Session", accelerator: "CmdOrCtrl+Shift+[" },
  { id: "revealInFinder", title: "Reveal in Finder" },
  { id: "openInTerminal", title: "Open in Terminal" },

  { id: "splitRight", title: "Split Right", accelerator: "CmdOrCtrl+D" },
  { id: "splitDown", title: "Split Down", accelerator: "CmdOrCtrl+Shift+D" },
  { id: "focusPaneLeft", title: "Focus Pane Left", accelerator: "CmdOrCtrl+Alt+Left" },
  { id: "focusPaneRight", title: "Focus Pane Right", accelerator: "CmdOrCtrl+Alt+Right" },
  { id: "focusPaneUp", title: "Focus Pane Up", accelerator: "CmdOrCtrl+Alt+Up" },
  { id: "focusPaneDown", title: "Focus Pane Down", accelerator: "CmdOrCtrl+Alt+Down" },
  { id: "restartTerminal", title: "Restart Terminal", accelerator: "CmdOrCtrl+Shift+R" },
  { id: "clearScrollback", title: "Clear Scrollback", accelerator: "CmdOrCtrl+Shift+K" },
];
