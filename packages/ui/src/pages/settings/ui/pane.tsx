import { cn, Label } from "@janela/design";
import type { ReactElement, ReactNode } from "react";

import { PANE_COLUMN } from "../../../shared/ui/index.ts";
import { type SettingsSection, sectionElementID } from "../model/settings-index.ts";

const REVEALED =
  "rounded-lg transition-[background-color] duration-150 data-[revealed=true]:bg-muted/50";

export const CONTROL_WIDTH = "w-56";

export function Pane(props: { readonly children: ReactNode }): ReactElement {
  return <div className={cn(PANE_COLUMN, "flex flex-col gap-8")}>{props.children}</div>;
}

export function PaneHeader(props: {
  readonly id: string;
  readonly title: string;
  readonly directory?: string | undefined;
}): ReactElement {
  return (
    <header className="flex flex-col gap-1">
      <h2 id={props.id} className="text-base leading-tight font-semibold">
        {props.title}
      </h2>
      {props.directory === undefined ? undefined : (
        <p className="text-muted-foreground truncate font-mono text-xs">{props.directory}</p>
      )}
    </header>
  );
}

export function SettingsGroup(props: {
  readonly section: SettingsSection;
  readonly description?: string | undefined;
  readonly children: ReactNode;
}): ReactElement {
  const { section } = props;

  return (
    <RowGroup
      id={sectionElementID(section.id)}
      title={section.title}
      description={props.description}
    >
      {props.children}
    </RowGroup>
  );
}

export function RowGroup(props: {
  readonly id: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly children: ReactNode;
}): ReactElement {
  const titleID = `${props.id}-title`;

  return (
    <section
      id={props.id}
      aria-labelledby={titleID}
      className={cn("flex scroll-mt-4 flex-col gap-1", REVEALED)}
    >
      <h3 id={titleID} className="text-muted-foreground text-xs font-medium">
        {props.title}
      </h3>
      {props.description === undefined ? undefined : (
        <p className="text-muted-foreground text-xs/relaxed">{props.description}</p>
      )}
      <div className="divide-border flex flex-col divide-y">{props.children}</div>
    </section>
  );
}

export const labelIDFor = (controlID: string): string => `${controlID}-label`;

export function SettingRow(props: {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly controlID?: string | undefined;
  readonly media?: ReactNode;
  readonly isDisabled?: boolean | undefined;
  readonly children?: ReactNode;
}): ReactElement {
  const { controlID } = props;

  return (
    <div
      data-disabled={props.isDisabled === true ? true : undefined}
      className="flex min-h-12 items-center gap-6 py-2.5"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {props.media}
        <div className="flex min-w-0 flex-col gap-0.5">
          {controlID === undefined ? (
            <span className="text-xs/relaxed font-medium">{props.label}</span>
          ) : (
            <Label
              id={labelIDFor(controlID)}
              htmlFor={controlID}
              className="leading-snug data-[disabled=true]:opacity-50"
            >
              {props.label}
            </Label>
          )}
          {props.description === undefined ? undefined : (
            <div className="text-muted-foreground text-xs/relaxed text-balance">
              {props.description}
            </div>
          )}
        </div>
      </div>
      {props.children === undefined ? undefined : (
        <div className="flex shrink-0 items-center gap-2">{props.children}</div>
      )}
    </div>
  );
}

export function SettingBlock(props: {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly controlID: string;
  readonly sectionID?: string | undefined;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div id={props.sectionID} className={cn("flex scroll-mt-4 flex-col gap-2 py-3", REVEALED)}>
      <div className="flex flex-col gap-0.5">
        <Label id={labelIDFor(props.controlID)} htmlFor={props.controlID} className="leading-snug">
          {props.label}
        </Label>
        {props.description === undefined ? undefined : (
          <div className="text-muted-foreground text-xs/relaxed">{props.description}</div>
        )}
      </div>
      {props.children}
    </div>
  );
}
