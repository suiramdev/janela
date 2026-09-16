import {
  BotIcon,
  BoxIcon,
  CloudIcon,
  CodeIcon,
  ContainerIcon,
  CpuIcon,
  DatabaseIcon,
  FlaskConicalIcon,
  GitBranchIcon,
  Notification01Icon,
  PackageIcon,
  RocketIcon,
  ServerIcon,
  SparklesIcon,
  TerminalIcon,
  WrenchIcon,
  ZapIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";

const ICON_BY_NAME = {
  terminal: TerminalIcon,
  sparkles: SparklesIcon,
  code: CodeIcon,
  box: BoxIcon,
  bot: BotIcon,
  server: ServerIcon,
  database: DatabaseIcon,
  container: ContainerIcon,
  rocket: RocketIcon,
  wrench: WrenchIcon,
  "flask-conical": FlaskConicalIcon,
  "git-branch": GitBranchIcon,
  package: PackageIcon,
  cpu: CpuIcon,
  cloud: CloudIcon,
  zap: ZapIcon,
  bell: Notification01Icon,
} satisfies Record<string, IconSvgElement>;

type ProfileIconName = keyof typeof ICON_BY_NAME;

export const PROFILE_ICON_NAMES: readonly string[] = Object.keys(ICON_BY_NAME);

export const FALLBACK_ICON_NAME = "terminal";

export function isProfileIconName(name: string): name is ProfileIconName {
  return Object.hasOwn(ICON_BY_NAME, name);
}

export function iconForName(name: string): IconSvgElement {
  return isProfileIconName(name) ? ICON_BY_NAME[name] : TerminalIcon;
}
