import { ComputerTerminal01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Button,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Kbd,
} from "@janela/design";
import type { ReactElement } from "react";

import { ContentCard, ShowSidebarBar, WindowBackdrop } from "../../../shared/ui/index.ts";

export function EmptySessionScreen(props: { readonly onNewTerminal: () => void }): ReactElement {
  return (
    <>
      <ShowSidebarBar />
      <ContentCard>
        <WindowBackdrop />
        <Empty className="relative h-full">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={ComputerTerminal01Icon} strokeWidth={2} />
            </EmptyMedia>
            <EmptyTitle>No terminals in this session</EmptyTitle>
            <EmptyDescription>
              Closing the last one closed its tab, and the session is still here. Start another and
              it runs in the same directory.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="lg" onClick={props.onNewTerminal}>
              <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
              New Terminal
              <Kbd>⌘T</Kbd>
            </Button>
          </EmptyContent>
        </Empty>
      </ContentCard>
    </>
  );
}
