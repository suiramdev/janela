import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Switch,
} from "@janela/design";
import type { ReactElement } from "react";
import { useCallback, useId, useRef, useState } from "react";

import { useClientEnvironment, useStoreValue } from "./client-environment.tsx";
import type { ConfirmationQueue, ConfirmationRequest } from "./confirmation.ts";

/**
 * The question, as a dialog. Rendered once, beside `SheetHost`.
 *
 * Keyed by title so the checkbox does not survive into the next question: a
 * remount is how "Don't ask again" starts unticked every time, without an
 * effect that resets it a frame late.
 */
export function ConfirmationHost(): ReactElement | null {
  const { confirmations } = useClientEnvironment();
  const pending = useStoreValue(confirmations, () => confirmations.pending);

  if (pending === undefined) return null;
  return <ConfirmationDialog key={pending.title} request={pending} queue={confirmations} />;
}

function ConfirmationDialog(props: {
  readonly request: ConfirmationRequest;
  readonly queue: ConfirmationQueue;
}): ReactElement {
  const { request, queue } = props;
  const [silenced, setSilenced] = useState(false);
  const switchID = useId();
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  const decline = useCallback(() => {
    queue.answer(false);
  }, [queue]);

  const agree = useCallback(() => {
    queue.answer(true, silenced);
  }, [queue, silenced]);

  // Escape, the scrim and the ✕ all mean "no": a dismissed question is a
  // declined one, never a silent yes.
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) queue.answer(false);
    },
    [queue],
  );

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent
        size="sm"
        showCloseButton={false}
        // Cancel, not the first tabbable element — which is the switch when
        // there is one. A question is read and then answered, and the answer
        // this dialog opens on is the reversible one: Enter cancels, which is
        // what a ⌘W arriving from muscle memory should do.
        initialFocus={cancelRef}
        finalFocus={false}
      >
        <DialogHeader>
          <DialogTitle>{request.title}</DialogTitle>
          <DialogDescription>{request.message}</DialogDescription>
        </DialogHeader>

        {request.remember === undefined ? null : (
          <div className="flex items-center gap-2">
            <Switch id={switchID} checked={silenced} onCheckedChange={setSilenced} />
            <Label htmlFor={switchID} className="text-muted-foreground text-xs font-normal">
              Don&rsquo;t ask again
            </Label>
          </div>
        )}

        <DialogFooter>
          <Button ref={cancelRef} type="button" variant="outline" size="sm" onClick={decline}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={request.destructive === false ? "default" : "destructive"}
            size="sm"
            onClick={agree}
          >
            {request.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
