import type { Project } from "@janela/core";
import { Avatar, AvatarFallback, AvatarImage, cn, DitherAvatar } from "@janela/design";
import type { ReactElement } from "react";

/**
 * A project's icon: a generated avatar, or an image when the project has one.
 *
 * ## Why generated
 *
 * A sidebar of identically-shaped rows is read by position, and position changes
 * — a project added, a search narrowing the list — so it is read by *name*, one
 * word at a time. A distinct picture per project is the cheapest thing that makes
 * the row recognisable before it is read, and generating it means nobody has to
 * draw, store, or choose one. `DitherAvatar` is deterministic in its `name`: the
 * same string is the same picture, in this window and in the next one.
 *
 * ## The seed is the directory, not the name and not the id
 *
 * A project's name is editable, so seeding from it would repaint the icon on
 * rename — the one moment the user is *most* sure which project they are looking
 * at. Its id is stable but is a fresh value every time the project is added, so
 * removing a folder and adding it back would produce a stranger. The directory is
 * what a project *is* (docs/domain-model.md § Project), so: renaming keeps the
 * icon, re-adding the same folder gets its icon back, and two clones of one
 * repository in two places look different — which is the case where telling them
 * apart matters most.
 *
 * ## The favicon seam
 *
 * `imageSource` is where a custom icon goes, and it is the whole extension point:
 * an `AvatarImage` when there is one, the generated avatar as the fallback
 * underneath. Base UI's `Avatar` already owns the hard part — an image that fails
 * to load falls back rather than leaving a hole — so a project whose favicon
 * 404s degrades to its generated icon with no code here.
 *
 * Nothing passes it yet, and that is a data question rather than a view one:
 * `Project` carries no icon field, so wiring one is a `@janela/core` change, a
 * migration and a protocol version. When that happens this component does not
 * change — which is the point of putting the seam here now rather than reaching
 * for the picture in three call sites later.
 */
export interface ProjectIconProps {
  readonly project: Pick<Project, "name" | "directory">;

  /**
   * A custom icon to show instead of the generated one — a favicon fetched from
   * the project's forge, or a file the user chose.
   */
  readonly imageSource?: string | undefined;

  /** Tailwind sizing. Defaults to the sidebar's row-height-matched square. */
  readonly className?: string | undefined;
}

export function ProjectIcon(props: ProjectIconProps): ReactElement {
  const { project, imageSource, className } = props;

  return (
    // Decorative, as a whole. The project's name is the row's text, so a second
    // announcement is noise in a list read one row at a time — and `DitherAvatar`
    // labels itself with its seed, which here is the project's **directory**.
    // Without this, every row would read out a filesystem path.
    //
    // Squared corners, against the registry's `rounded-full` on all three parts:
    // a circle reads as a person, and this is a folder. The ring has to be
    // squared separately — it is a pseudo-element with its own radius.
    <Avatar aria-hidden="true" className={cn(ICON_SHAPE, className)}>
      {imageSource === undefined ? undefined : (
        <AvatarImage src={imageSource} alt="" className="rounded-[3px]" />
      )}
      <AvatarFallback className="rounded-[3px] bg-transparent">
        {/* `animate={false}`: the registry's default sweeps the cells in over
            600ms on mount, and these mount constantly — typing in the sidebar
            filter remounts every row that survives the keystroke, so the icons
            would shimmer while the user reads the names they are filtering. An
            icon is an identity, not an event: it has nothing to announce, and
            the one thing it must do is be recognisable the instant it appears. */}
        <DitherAvatar name={project.directory} animate={false} className="size-full" />
      </AvatarFallback>
    </Avatar>
  );
}

const ICON_SHAPE = "size-4 shrink-0 rounded-[3px] after:rounded-[3px]";
