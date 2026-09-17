import { ComputerTerminal01Icon, FolderAddIcon, PlusSignIcon } from "@hugeicons/core-free-icons";
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
import { useCallback, type ReactElement } from "react";

import type { CommandID } from "../../../shared/config/index.ts";
import { ContentCard, ShowSidebarBar, WindowBackdrop } from "../../../shared/ui/index.ts";

export function WelcomeScreen(props: { readonly dispatch: (id: CommandID) => void }): ReactElement {
  const { dispatch } = props;

  const newSession = useCallback(() => {
    dispatch("newSession");
  }, [dispatch]);

  const addProject = useCallback(() => {
    dispatch("addProject");
  }, [dispatch]);

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
            <EmptyTitle>No session open</EmptyTitle>
            <EmptyDescription>
              A session is a directory with terminals in it. Start one in any folder, or add a
              project to keep its sessions together — whatever you start keeps running when this
              window closes.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button size="lg" onClick={newSession}>
                <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
                New Session
                <Kbd>⌘N</Kbd>
              </Button>
              <Button size="lg" variant="outline" onClick={addProject}>
                <HugeiconsIcon icon={FolderAddIcon} strokeWidth={2} />
                Add Project
              </Button>
            </div>
          </EmptyContent>
        </Empty>
      </ContentCard>
    </>
  );
}
