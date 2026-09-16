export interface Command {
  readonly id: CommandID;
  readonly title: string;
  readonly accelerator?: string;
  readonly menu: CommandMenu;
  readonly section?: number;
  readonly localOnly?: true;
}

export type CommandMenu = "app" | "file" | "view" | "session" | "terminal";

export type CommandID =
  | "openSettings"
  | "newSession"
  | "newTerminal"
  | "openFolder"
  | "addProject"
  | "showCommands"
  | "goToSession"
  | "nextSession"
  | "previousSession"
  | "revealInFinder"
  | "openInTerminal"
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

export const COMMANDS: readonly Command[] = [
  { id: "openSettings", title: "Settings…", accelerator: "CmdOrCtrl+,", menu: "app" },

  { id: "newSession", title: "New Session", accelerator: "CmdOrCtrl+N", menu: "file" },
  { id: "newTerminal", title: "New Terminal", accelerator: "CmdOrCtrl+T", menu: "file" },
  {
    id: "openFolder",
    title: "Open Folder…",
    accelerator: "CmdOrCtrl+O",
    menu: "file",
    section: 1,
    localOnly: true,
  },
  {
    id: "addProject",
    title: "Add Project…",
    accelerator: "CmdOrCtrl+Alt+O",
    menu: "file",
    section: 1,
    localOnly: true,
  },

  { id: "showCommands", title: "Command Palette…", accelerator: "CmdOrCtrl+Shift+P", menu: "view" },

  { id: "goToSession", title: "Go to Session…", accelerator: "CmdOrCtrl+Shift+O", menu: "session" },
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
  {
    id: "revealInFinder",
    title: "Reveal in Finder",
    menu: "session",
    section: 2,
    localOnly: true,
  },
  {
    id: "openInTerminal",
    title: "Open in Terminal",
    menu: "session",
    section: 2,
    localOnly: true,
  },

  { id: "splitRight", title: "Split Vertically", accelerator: "CmdOrCtrl+D", menu: "terminal" },
  {
    id: "splitDown",
    title: "Split Horizontally",
    accelerator: "CmdOrCtrl+Shift+D",
    menu: "terminal",
  },
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

export const COMMAND_BY_ID: Readonly<Record<string, Command | undefined>> = Object.fromEntries(
  COMMANDS.map((command) => [command.id, command]),
);

const ACCELERATOR_SYMBOLS = {
  CmdOrCtrl: "⌘",
  Shift: "⇧",
  Alt: "⌥",
  Left: "←",
  Right: "→",
  Up: "↑",
  Down: "↓",
} satisfies Record<string, string>;

type AcceleratorToken = keyof typeof ACCELERATOR_SYMBOLS;

export function isCommandID(value: string): value is CommandID {
  return Object.hasOwn(COMMAND_BY_ID, value);
}

function isAcceleratorToken(part: string): part is AcceleratorToken {
  return Object.hasOwn(ACCELERATOR_SYMBOLS, part);
}

export function acceleratorCaps(accelerator: string): string {
  return accelerator
    .split("+")
    .map((part) => (isAcceleratorToken(part) ? ACCELERATOR_SYMBOLS[part] : part))
    .join("+");
}
export function availableCommands(hasLocalShell: boolean): readonly Command[] {
  return hasLocalShell ? COMMANDS : COMMANDS.filter((command) => command.localOnly !== true);
}
