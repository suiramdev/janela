import {
  Bell,
  Bot,
  Box,
  Cloud,
  Code,
  Container,
  Cpu,
  Database,
  FlaskConical,
  GitBranch,
  type LucideIcon,
  Package,
  Rocket,
  Server,
  Sparkles,
  Terminal,
  Wrench,
  Zap,
} from "lucide-react";
import type { ReactElement } from "react";
import { createElement } from "react";

/**
 * The icons a launch profile may name.
 *
 * `LaunchProfile.iconName` used to be an SF Symbol; the client is a WebView, so it
 * now names a Lucide icon. Two consequences this table exists to handle:
 *
 * 1. **An unrecognised name falls back to the terminal glyph**, never to nothing.
 *    A profile that renders a hole because someone typed `sparkle` is worse than
 *    one that renders a terminal.
 * 2. **It is a closed set, not free text.** Lucide ships over six thousand
 *    exports; naming them all would put every icon in the client bundle to serve a
 *    field the user picks from a grid. So the editor offers these, the way the
 *    accent picker offers ten colours.
 *
 * A profile stored with a name outside this set keeps that name — we never rewrite
 * the user's row — and renders the fallback until the set grows.
 */
const ICON_BY_NAME: Record<string, LucideIcon> = {
  terminal: Terminal,
  sparkles: Sparkles,
  code: Code,
  box: Box,
  bot: Bot,
  server: Server,
  database: Database,
  container: Container,
  rocket: Rocket,
  wrench: Wrench,
  "flask-conical": FlaskConical,
  "git-branch": GitBranch,
  package: Package,
  cpu: Cpu,
  cloud: Cloud,
  zap: Zap,
  bell: Bell,
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
 * Resolves an icon name to a component, falling back rather than failing.
 *
 * Total by construction: there is no path that returns undefined, so no call site
 * has to decide what to draw instead.
 */
export function iconForName(name: string): LucideIcon {
  return ICON_BY_NAME[name] ?? Terminal;
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
 *
 * Built with `createElement` rather than `<Icon />`: a capitalised local binding
 * in JSX position is indistinguishable from a component defined during render,
 * which is a real bug elsewhere and is why the linter refuses it.
 */
export function ProfileIcon(props: ProfileIconProps): ReactElement {
  return createElement(iconForName(props.iconName), {
    size: props.size ?? 16,
    "aria-hidden": true,
  });
}
