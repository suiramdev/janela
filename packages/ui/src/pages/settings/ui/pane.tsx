import { cn, Elevated, FieldDescription, FieldGroup, FieldLegend, FieldSet } from "@janela/design";
import type { ReactElement, ReactNode } from "react";

import { PANE_COLUMN } from "../../../shared/ui/index.ts";
import { type SettingsSection, sectionElementID } from "../model/settings-index.ts";

const REVEALED_RING =
  "transition-[box-shadow] duration-150 data-[revealed=true]:ring-2 data-[revealed=true]:ring-ring/60";

export function Pane(props: { readonly children: ReactNode }): ReactElement {
  return <div className={cn(PANE_COLUMN, "flex flex-col gap-4")}>{props.children}</div>;
}

export function PaneHeader(props: {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly directory?: string | undefined;
}): ReactElement {
  return (
    <header className="mb-1 flex flex-col px-1">
      <h2 id={props.id} className="text-base leading-tight font-semibold">
        {props.title}
      </h2>
      {props.directory === undefined ? undefined : (
        <p className="text-muted-foreground mt-1 truncate font-mono text-xs">{props.directory}</p>
      )}
      <p className="text-muted-foreground mt-2 text-xs leading-relaxed">{props.description}</p>
    </header>
  );
}

export function PaneGroup(props: {
  readonly section: SettingsSection;
  readonly children: ReactNode;
}): ReactElement {
  const { section } = props;
  const titleID = `${sectionElementID(section.id)}-title`;

  return (
    <section
      id={sectionElementID(section.id)}
      aria-labelledby={titleID}
      className="mt-2 flex scroll-mt-4 flex-col gap-4"
    >
      <div className="px-1">
        <h3 id={titleID} className="text-sm font-medium">
          {section.title}
        </h3>
        {section.hint === undefined ? undefined : (
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{section.hint}</p>
        )}
      </div>
      {props.children}
    </section>
  );
}

export function PaneCard(props: {
  readonly title: string;
  readonly hint?: string | undefined;
  readonly id?: string | undefined;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <Elevated offset={1} id={props.id} className={cn("scroll-mt-4 rounded-xl p-4", REVEALED_RING)}>
      <FieldSet>
        <FieldLegend>{props.title}</FieldLegend>
        {props.hint === undefined ? undefined : <FieldDescription>{props.hint}</FieldDescription>}
        <FieldGroup>{props.children}</FieldGroup>
      </FieldSet>
    </Elevated>
  );
}

export function Section(props: {
  readonly section: SettingsSection;
  readonly children: ReactNode;
}): ReactElement {
  const { section } = props;

  return (
    <PaneCard title={section.title} hint={section.hint} id={sectionElementID(section.id)}>
      {props.children}
    </PaneCard>
  );
}
