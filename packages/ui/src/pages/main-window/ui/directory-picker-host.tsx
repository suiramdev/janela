import type { AbsolutePath } from "@janela/core";
import { Dialog, DialogContent } from "@janela/design";
import { parseDirectoryListing, type DirectoryListing } from "@janela/protocol";
import type { ReactElement } from "react";
import { useCallback, useRef } from "react";

import {
  type DirectoryPickerQueue,
  type DirectoryPickerRequest,
  useClientEnvironment,
  useStoreValue,
} from "../../../shared/model/index.ts";
import { DirectoryBrowser } from "./directory-browser.tsx";

export interface DirectoryPickerHostProps {
  readonly picker: DirectoryPickerQueue;
}

class ListingMissing extends TypeError {
  constructor() {
    super("the daemon acknowledged a directory listing without a listing");
    this.name = "ListingMissing";
  }
}

export function DirectoryPickerHost(props: DirectoryPickerHostProps): ReactElement | null {
  const { picker } = props;
  const { connection } = useClientEnvironment();
  const pending = useStoreValue(picker, () => picker.pending);

  const load = useCallback(
    async (directory: AbsolutePath | undefined): Promise<DirectoryListing> => {
      const text = await connection.request(
        directory === undefined ? { type: "listDirectory" } : { type: "listDirectory", directory },
      );

      if (text === undefined) throw new ListingMissing();

      return parseDirectoryListing(text);
    },
    [connection],
  );

  if (pending === undefined) return null;

  return <DirectoryPickerDialog key={pending.title} request={pending} load={load} queue={picker} />;
}

function DirectoryPickerDialog(props: {
  readonly request: DirectoryPickerRequest;
  readonly load: (directory: AbsolutePath | undefined) => Promise<DirectoryListing>;
  readonly queue: DirectoryPickerQueue;
}): ReactElement {
  const { request, load, queue } = props;
  const contentRef = useRef<HTMLDivElement | null>(null);

  const cancel = useCallback(() => {
    queue.answer(undefined);
  }, [queue]);

  const choose = useCallback(
    (directory: AbsolutePath) => {
      queue.answer(directory);
    },
    [queue],
  );

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) queue.answer(undefined);
    },
    [queue],
  );

  const initialFocus = useCallback(
    () => contentRef.current?.querySelector<HTMLElement>("[data-autofocus]") ?? null,
    [],
  );

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent
        ref={contentRef}
        size="xl"
        showCloseButton={false}
        initialFocus={initialFocus}
        finalFocus={false}
        className="flex h-[min(70dvh,560px)] flex-col overflow-hidden p-0"
      >
        <DirectoryBrowser title={request.title} load={load} onChoose={choose} onCancel={cancel} />
      </DialogContent>
    </Dialog>
  );
}
