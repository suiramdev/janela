import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactElement } from "react";

import { iconForName } from "../../../shared/config/index.ts";

export interface ProfileIconProps {
  readonly iconName: string;
  readonly size?: number;
}

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
