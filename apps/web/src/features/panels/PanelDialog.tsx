import type * as React from "react";
import { Dialog, DialogBody, DialogContent, DialogHeading } from "@/components/ui/dialog";
import { useDialogBack, useDialogStore } from "@/state/dialog-store";

/**
 * The frame the three panels share: the one modal
 * dialog with its title row and description, closed by the close button, Esc
 * or a click outside.
 */
export function PanelDialog({
  title,
  description,
  size,
  ownBody = false,
  wide = false,
  children,
}: {
  title: string;
  /** Left out where the dialog's own tabs already say what it holds (settings). */
  description?: string;
  size?: "default" | "large";
  /** Wider than a large one, for a side list of sections beside the page (settings on a computer). */
  wide?: boolean;
  /** The children bring their own DialogBody (settings: its tabs stay with the head, over the part that scrolls). */
  ownBody?: boolean;
  children: React.ReactNode;
}) {
  const close = useDialogStore((state) => state.close);
  const back = useDialogBack();
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      {/* Without a description, Radix is told so explicitly rather than pointed at nothing. */}
      <DialogContent size={size} className={wide ? "data-[size=large]:w-[56rem]" : undefined} {...(description ? {} : { "aria-describedby": undefined })}>
        <DialogHeading title={title} description={description} back={back} />
        {ownBody ? children : <DialogBody>{children}</DialogBody>}
      </DialogContent>
    </Dialog>
  );
}
