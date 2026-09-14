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
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ReactElement } from "react";

/**
 * The icons a launch profile may name.
 *
 * `LaunchProfile.iconName` used to be an SF Symbol, then a Lucide name; the keys
 * are **persisted** in the daemon's database, so they stay what they were while
 * the glyph behind each one is whatever the current icon set offers. Two
 * consequences this table exists to handle:
 *
 * 1. **An unrecognised name falls back to the terminal glyph**, never to nothing.
 *    A profile that renders a hole because someone typed `sparkle` is worse than
 *    one that renders a terminal.
 * 2. **It is a closed set, not free text.** Hugeicons ships thousands of exports;
 *    naming them all would put every icon in the client bundle to serve a field
 *    the user picks from a grid. So the editor offers these, the way the accent
 *    picker offers ten colours.
 *
 * A profile stored with a name outside this set keeps that name — we never rewrite
 * the user's row — and renders the fallback until the set grows.
 */
const ICON_BY_NAME: Record<string, IconSvgElement> = {
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
};

/** What the editor offers, in the order it offers them. */
export const PROFILE_ICON_NAMES: readonly string[] = Object.keys(ICON_BY_NAME);

/**
 * The glyph for a profile with no icon, and for one whose icon we do not know.
 *
 * Everything Janela launches is a command in a terminal, so the terminal glyph is
 * never a lie — which is what makes it a safe fallback rather than a placeholder.
 */
export const FALLBACK_ICON_NAME = "terminal";

/** Whether the editor's grid contains this name. */
export function isProfileIconName(name: string): boolean {
  return Object.hasOwn(ICON_BY_NAME, name);
}

/**
 * Resolves an icon name to its glyph, falling back rather than failing.
 *
 * Total by construction: there is no path that returns undefined, so no call site
 * has to decide what to draw instead.
 */
export function iconForName(name: string): IconSvgElement {
  return ICON_BY_NAME[name] ?? TerminalIcon;
}

export interface ProfileIconProps {
  readonly iconName: string;
  readonly size?: number;
}

/**
 * A profile's glyph, always decorative.
 *
 * `aria-hidden` without exception: every place this is rendered puts the profile's
 * name, the tab's title or an `aria-label` beside it, so announcing the glyph too
 * would read the same thing twice. An icon that is the *only* label is a control
 * that needs a label, not an icon that needs a role.
 */
export function ProfileIcon(props: ProfileIconProps): ReactElement {
  return (
    <HugeiconsIcon
      icon={iconForName(props.iconName)}
      size={props.size ?? 16}
      strokeWidth={2}
      aria-hidden
    />
  );
}
