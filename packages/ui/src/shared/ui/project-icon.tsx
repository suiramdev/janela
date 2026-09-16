import type { Project } from "@janela/core";
import { Avatar, AvatarFallback, AvatarImage, cn, DitherAvatar } from "@janela/design";
import type { ReactElement } from "react";

export interface ProjectIconProps {
  readonly project: Pick<Project, "name" | "directory">;

  readonly imageSource?: string | undefined;

  readonly className?: string | undefined;
}

const ICON_SHAPE = "size-4 shrink-0 rounded-[3px] after:rounded-[3px]";

export function ProjectIcon(props: ProjectIconProps): ReactElement {
  const { project, imageSource, className } = props;

  return (
    <Avatar aria-hidden="true" className={cn(ICON_SHAPE, className)}>
      {imageSource === undefined ? undefined : (
        <AvatarImage src={imageSource} alt="" className="rounded-[3px]" />
      )}
      <AvatarFallback className="rounded-[3px] bg-transparent">
        <DitherAvatar name={project.directory} animate={false} className="size-full" />
      </AvatarFallback>
    </Avatar>
  );
}
