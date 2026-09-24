import {
  cn,
  Dotm3x3_15,
  Dotm3x3_20,
  type Dotm3x3_20Props,
  type IconComponent,
  type IconComponentProps,
} from "@janela/design";
import type { ComponentType, ReactElement } from "react";

import type { SessionStatus } from "../model/session-rows.ts";

export const SESSION_STATUS_ICON = {
  error: statusGlyph(Dotm3x3_15, "text-failure", false),
  running: statusGlyph(Dotm3x3_20, "text-muted-foreground", true),
  unread: statusGlyph(Dotm3x3_15, "text-attention", true),
  idle: statusGlyph(Dotm3x3_20, "invisible", false),
} satisfies Record<SessionStatus, IconComponent>;

export function SessionStatusGlyph(props: {
  readonly status: SessionStatus;
  readonly size?: number | undefined;
  readonly className?: string | undefined;
}): ReactElement {
  const Glyph = SESSION_STATUS_ICON[props.status];

  return <Glyph size={props.size ?? 14} className={props.className ?? ""} />;
}

function statusGlyph(
  Loader: ComponentType<Dotm3x3_20Props>,
  tint: string,
  animated: boolean,
): IconComponent {
  return function StatusGlyph({ size = 14, className }: IconComponentProps) {
    return (
      <span aria-hidden="true" className={cn("inline-flex shrink-0", className, tint)}>
        <Loader size={size} boxSize={size} minSize={size} animated={animated} />
      </span>
    );
  };
}
