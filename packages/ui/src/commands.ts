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
 *
 * The shell is handed this table at startup and knows nothing else about it: it
 * reads ids, titles, accelerators and where each row goes, and emits the id back
 * when the user picks one. Adding a row here adds it to the menu bar and to the
 * command palette, with no Rust change — which is the property that stops the two
 * lists drifting.
 */
export interface Command {
  readonly id: CommandID;
  readonly title: string;
  /** Accelerator in Tauri's notation, e.g. `CmdOrCtrl+Shift+B`. */
  readonly accelerator?: string;
  /** Which menu the row belongs to. */
  readonly menu: CommandMenu;
  /**
   * A group within its menu. Absent is `0`.
   *
   * Consecutive rows of one menu whose sections differ get a separator between
   * them, which is how the menu's grouping stays in this table rather than being
   * re-decided in Rust.
   */
  readonly section?: number;
}

/**
 * The menus, in bar order.
 *
 * `app` is the application menu — the one named "Janela" — where macOS expects
 * Settings, About and Quit. Edit and Window hold only predefined items and are
 * therefore not represented here.
 */
export type CommandMenu = "app" | "file" | "view" | "session" | "terminal";

export type CommandID =
  // App
  | "openSettings"
  // File
  | "newSession"
  | "newTerminal"
  | "openFolder"
  | "addProject"
  // View
  | "showCommands"
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
  | "nextTab"
  | "previousTab"
  | "closePane"
  | "restartTerminal"
  | "clearScrollback";

/**
 * The command table.
 *
 * ⌘⇧O is the one shortcut worth spending: it is how you get anywhere without
 * touching the sidebar, and it is the app's fastest path.
 *
 * The bracket pair is spent one level up from where a terminal multiplexer puts
 * it: ⌘⇧[ / ⌘⇧] switch **sessions**, ⌘[ / ⌘] switch tabs. Switching sessions is
 * what this app is judged on, so it gets the chord your hand already knows.
 *
 * ⌘W closes a **pane**, not the window — a terminal user reaches for it a hundred
 * times a day, and a window with a running agent in it is not something to close
 * by reflex. Quit is ⌘Q, and the Window menu deliberately has no Close item.
 *
 * Note ⌘⌥arrow for pane focus. Plain arrows, and anything with `Ctrl`, belong to the
 * program running in the terminal.
 *
 * Copy and Paste are absent on purpose: they are the Edit menu's predefined items,
 * which is what routes ⌘C/⌘V to the WebView and lets the terminal handle the DOM
 * `copy`/`paste` events itself.
 */
export const COMMANDS: readonly Command[] = [
  { id: "openSettings", title: "Settings…", accelerator: "CmdOrCtrl+,", menu: "app" },

  { id: "newSession", title: "New Session", accelerator: "CmdOrCtrl+N", menu: "file" },
  { id: "newTerminal", title: "New Terminal", accelerator: "CmdOrCtrl+T", menu: "file" },
  { id: "openFolder", title: "Open Folder…", accelerator: "CmdOrCtrl+O", menu: "file", section: 1 },
  {
    id: "addProject",
    title: "Add Project…",
    accelerator: "CmdOrCtrl+Alt+O",
    menu: "file",
    section: 1,
  },

  { id: "showCommands", title: "Command Palette…", accelerator: "CmdOrCtrl+Shift+P", menu: "view" },

  { id: "goToSession", title: "Go to Session…", accelerator: "CmdOrCtrl+Shift+O", menu: "session" },
  {
    id: "newBranchSession",
    title: "New Branch Session…",
    accelerator: "CmdOrCtrl+Shift+B",
    menu: "session",
  },
  {
    id: "nextSession",
    title: "Next Session",
    accelerator: "CmdOrCtrl+Shift+]",
    menu: "session",
    section: 1,
  },
  {
    id: "previousSession",
    title: "Previous Session",
    accelerator: "CmdOrCtrl+Shift+[",
    menu: "session",
    section: 1,
  },
  { id: "revealInFinder", title: "Reveal in Finder", menu: "session", section: 2 },
  { id: "openInTerminal", title: "Open in Terminal", menu: "session", section: 2 },

  { id: "splitRight", title: "Split Right", accelerator: "CmdOrCtrl+D", menu: "terminal" },
  { id: "splitDown", title: "Split Down", accelerator: "CmdOrCtrl+Shift+D", menu: "terminal" },
  {
    id: "focusPaneLeft",
    title: "Focus Pane Left",
    accelerator: "CmdOrCtrl+Alt+Left",
    menu: "terminal",
    section: 1,
  },
  {
    id: "focusPaneRight",
    title: "Focus Pane Right",
    accelerator: "CmdOrCtrl+Alt+Right",
    menu: "terminal",
    section: 1,
  },
  {
    id: "focusPaneUp",
    title: "Focus Pane Up",
    accelerator: "CmdOrCtrl+Alt+Up",
    menu: "terminal",
    section: 1,
  },
  {
    id: "focusPaneDown",
    title: "Focus Pane Down",
    accelerator: "CmdOrCtrl+Alt+Down",
    menu: "terminal",
    section: 1,
  },
  { id: "nextTab", title: "Next Tab", accelerator: "CmdOrCtrl+]", menu: "terminal", section: 2 },
  {
    id: "previousTab",
    title: "Previous Tab",
    accelerator: "CmdOrCtrl+[",
    menu: "terminal",
    section: 2,
  },
  {
    id: "closePane",
    title: "Close Pane",
    accelerator: "CmdOrCtrl+W",
    menu: "terminal",
    section: 3,
  },
  {
    id: "restartTerminal",
    title: "Restart Terminal",
    accelerator: "CmdOrCtrl+Shift+R",
    menu: "terminal",
    section: 4,
  },
  {
    id: "clearScrollback",
    title: "Clear Scrollback",
    accelerator: "CmdOrCtrl+Shift+K",
    menu: "terminal",
    section: 4,
  },
];

/**
 * The table, keyed. Also what `isCommandID` asks: one derived structure rather
 * than a lookup and a membership set that could disagree.
 */
export const COMMAND_BY_ID: Readonly<Record<string, Command | undefined>> = Object.fromEntries(
  COMMANDS.map((command) => [command.id, command]),
);

/**
 * Whether a string names a command.
 *
 * The shell emits whatever the user picked as a plain string, so the id arriving
 * from the menu is untyped by construction. Built from the table rather than a
 * hand-kept list, and asked with `Object.hasOwn` rather than `in` — `"constructor"`
 * is on every object's prototype chain and is not a command.
 */
export function isCommandID(value: string): value is CommandID {
  return Object.hasOwn(COMMAND_BY_ID, value);
}

/**
 * An accelerator as the symbols a Mac user reads.
 *
 * The table is in Tauri's notation because that is what the shell parses; the
 * palette shows the same chord the menu bar does, so it renders it here rather
 * than storing a second spelling that could disagree.
 */
export function acceleratorSymbols(accelerator: string): string {
  return accelerator
    .split("+")
    .map((part) => ACCELERATOR_SYMBOLS[part] ?? part)
    .join("");
}

const ACCELERATOR_SYMBOLS: Readonly<Record<string, string>> = {
  CmdOrCtrl: "⌘",
  Shift: "⇧",
  Alt: "⌥",
  Left: "←",
  Right: "→",
  Up: "↑",
  Down: "↓",
};
