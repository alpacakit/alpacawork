import * as React from "react";
import { cn } from "@/lib/utils";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useTranslation } from "react-i18next";
import { BackButton } from "@/components/ui/back-button";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ESCAPE_LAYER, useEscapeLayer } from "@/lib/escape-layer";
import { giveFocusBack, openerChain, rememberOpener } from "@/lib/focus-return";
import { useCloseOnPhoneBack } from "@/lib/close-on-back";
import { notify } from "@/lib/notify";
import { useSurfaceDocument } from "@/lib/surface";

/**
 * shadcn's Dialog (Radix): a flat
 * box with no shadow, rising into place over a dark scrim that fades in, 460px wide (`size="large"`:
 * 790px), with a title row, description, body and footer. The head stays where it is: only the body scrolls, inside
 * the box, so the close button is in reach at any place in a long body.
 * Centred as the native modal `<dialog>` is (inset 0, margin auto, fit-content
 * height), not with a translate: a half-pixel translate moves the text off
 * the pixel grid.
 *
 *   <Dialog open onOpenChange={...}>
 *     <DialogContent size="large">
 *       <DialogHeading title="Global settings" description="..." />
 *       <DialogBody>... <DialogFooter>...</DialogFooter></DialogBody>
 *     </DialogContent>
 *   </Dialog>
 */
function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  useEscapeLayer(!!props.open, ESCAPE_LAYER.dialog, () => props.onOpenChange?.(false));
  // Open for a moment only: on a phone Back closes it along with the page's step.
  useCloseOnPhoneBack(!!props.open, () => props.onOpenChange?.(false));
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

/** The dialog's backdrop: a third of black over the screen. */
function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn("fixed inset-0 z-(--layer-dialog) animate-fade bg-dim-dialog", className)}
      {...props}
    />
  );
}

/** The close icon button in the title row. */
function DialogCloseButton() {
  const { t } = useTranslation();
  return (
    <DialogPrimitive.Close asChild>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("dialog.close")}
        className="press-end press-reach"
      >
        <Icon name="close" />
      </Button>
    </DialogPrimitive.Close>
  );
}

/**
 * On open, focus goes to the title,
 * not to the first button as in Radix. A dialog that starts in a field focuses
 * it in its own `onOpenAutoFocus` and calls `preventDefault()`, so a form's
 * focus moves to its first field right after opening.
 *
 * On close, focus goes back to what had it when the dialog opened, without
 * scrolling, unless something opened since has taken it. Radix gives it to a `DialogTrigger`, and the
 * screen's dialogs have none: they are opened through `useDialogStore`.
 */
function DialogContent({
  className,
  children,
  size = "default",
  onOpenAutoFocus,
  onCloseAutoFocus,
  onInteractOutside,
  onFocus,
  onPointerDownCapture,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  size?: "default" | "large";
}) {
  const at = useSurfaceDocument();
  // Read on the first render, before Radix moves the focus into the dialog.
  const [opener] = React.useState(() => openerChain(at.activeElement));
  // Only which staying toasts are shown is affected by a covering surface, never its position.
  React.useLayoutEffect(() => notify.cover(at), [at]);
  // A press inside the dialog may put the focus on its box (starting to select its words): that one stays there.
  const pressing = React.useRef(false);
  React.useEffect(() => {
    const release = () => { pressing.current = false; };
    at.addEventListener("pointerup", release, true); at.addEventListener("pointercancel", release, true);
    return () => { at.removeEventListener("pointerup", release, true); at.removeEventListener("pointercancel", release, true); };
  }, [at]);
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={(content) => rememberOpener(content, opener)}
        data-slot="dialog-content"
        data-size={size}
        className={cn(
          "fixed inset-0 z-(--layer-dialog) m-auto flex h-fit animate-rise max-h-[calc(100dvh-56px)] w-dialog max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-pane border border-lit-line bg-raised p-0 text-ink outline-none",
          // A large one keeps one height whatever it holds, so moving among its pages or tabs never moves its edges.
          "data-[size=large]:h-[min(50rem,calc(100dvh-56px))] data-[size=large]:w-dialog-wide narrow:data-[size=large]:h-[calc(100dvh-28px)]",
          // The pages one moves among (the large ones: Settings, a project's settings; and any opened from another,
          // with Back) stand at one height from the top, so a head stays where it was whatever the page below holds.
          "data-[size=large]:mt-7 narrow:data-[size=large]:mt-3.5 has-[[data-dialog-back]]:mt-7 narrow:has-[[data-dialog-back]]:mt-3.5",
          "narrow:max-h-[calc(100dvh-28px)] narrow:max-w-[calc(100vw-24px)]",
          className,
        )}
        // When what had the focus went away and Radix catches the focus on the dialog's own box, its title takes it, as
        // when the dialog opened, so the focus is still seen and read. A press on the box (selecting words) keeps it.
        onPointerDownCapture={(event) => { onPointerDownCapture?.(event); pressing.current = true; }}
        onFocus={(event) => {
          onFocus?.(event);
          if (event.target !== event.currentTarget || pressing.current) return;
          event.currentTarget.querySelector<HTMLElement>('[data-slot="dialog-title"]')?.focus({ preventScroll: true });
        }}
        onOpenAutoFocus={(event) => {
          onOpenAutoFocus?.(event);
          if (event.defaultPrevented || !(event.currentTarget instanceof HTMLElement)) return;
          const title = event.currentTarget.querySelector<HTMLElement>('[data-slot="dialog-title"]');
          if (!title) return;
          event.preventDefault();
          title.focus();
        }}
        // A toast stands over the dialog (lib/notify.ts); pressing it or moving the focus to it (its Undo, its ×) is
        // not leaving the dialog. Radix judges a press when its click has ended, and a toast's × has taken the toast
        // away by then: a press on what is no longer there was on a toast (nothing else outside a dialog takes presses).
        onInteractOutside={(event) => {
          onInteractOutside?.(event);
          const target = event.target;
          if (target instanceof Element && (!target.isConnected || target.closest("[data-toaster]"))) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (event.defaultPrevented) return;
          event.preventDefault();
          // Radix calls this a task after the dialog is gone. Whatever was opened since (a click is handled ahead
          // of that task) keeps the focus, as a closed popup leaves it (popup.tsx `returnFocus`).
          giveFocusBack(opener);
        }}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

/** The dialog's header row. */
function DialogHeader({ className, ...props }: React.ComponentProps<"header">) {
  return (
    <header
      data-slot="dialog-header"
      className={cn("flex-none px-6 pt-5.5 pb-4 narrow:px-4.5 narrow:pt-5 narrow:pb-3", className)}
      {...props}
    />
  );
}

/**
 * The title takes the focus when the dialog opens, and it stands outside the body that scrolls: the keys that scroll a
 * page are passed on to that body while the focus is still here, so a long dialog is read by keyboard from its opening.
 */
function scrollBodyByKey(event: React.KeyboardEvent<HTMLElement>) {
  // Shift with a key other than Space selects the title's words (caret browsing): the browser keeps those.
  if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey && event.key !== " ") return;
  const body = event.currentTarget.closest('[data-slot="dialog-content"]')?.querySelector<HTMLElement>('[data-slot="dialog-body"]');
  if (!body) return;
  const page = body.clientHeight * 0.9, line = 40;
  const to = event.key === "Home" ? 0 : event.key === "End" ? body.scrollHeight
    : body.scrollTop + (event.key === "PageDown" || event.key === " " && !event.shiftKey ? page : event.key === "PageUp" || event.key === " " ? -page
      : event.key === "ArrowDown" ? line : event.key === "ArrowUp" ? -line : NaN);
  if (Number.isNaN(to)) return;
  event.preventDefault();
  body.scrollTop = to;
}

function DialogTitle({ className, onKeyDown, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      tabIndex={-1}
      className={cn("min-w-0 text-lg outline-none", className)}
      onKeyDown={(event) => { onKeyDown?.(event); if (!event.defaultPrevented) scrollBodyByKey(event); }}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("mt-type-close text-base [overflow-wrap:anywhere] text-muted", className)}
      {...props}
    />
  );
}

/**
 * Title, an optional action beside it, close button and optional description: the whole `.dialog-head` of every dialog.
 * A dialog opened from another (`back`) stands as the reader does: Back at the head's left end and × at its right, on
 * one row above the title, so the title keeps the whole width.
 */
function DialogHeading({ title, description, action, back }: {
  title: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode; back?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <DialogHeader>
      {/* × stays where a dialog without Back has it, so moving between them it does not move. */}
      {back && <div data-dialog-back-row className="mb-1.5 flex items-center justify-between gap-2">
        {/* Its chevron, not its face, lines up with the title's left edge. */}
        <BackButton data-dialog-back label={t("dialog.back")} onClick={back} className="-ml-1.5 narrow:-ml-0.5" />
        <DialogCloseButton />
      </div>}
      <div className="flex items-center justify-between gap-2">
        <DialogTitle>{title}</DialogTitle>
        {/* As tall as the action's button, so the title does not move when the action comes or goes. */}
        {action ? <div className="ml-auto flex min-h-control-sm items-center narrow:min-h-11">{action}</div> : null}
        {!back && <DialogCloseButton />}
      </div>
      {description ? <DialogDescription>{description}</DialogDescription> : null}
    </DialogHeader>
  );
}

/**
 * What the dialog holds under its head, and the one part of it that scrolls. Its scrollbar is thin, in the box's own
 * greys, and stands inside the box: the room it takes comes out of the body's own side room (`--scroll-gutter`, measured
 * here, since a bar that lies over the text takes none), so the words keep the head's margins with or without it. A line
 * parts the head from a body scrolled under it, and the body's last lines fade into the box's foot.
 */
function DialogBody({ className, onScroll, ref, ...props }: React.ComponentProps<"div">) {
  const measure = React.useCallback((body: HTMLDivElement | null) => {
    if (body) body.style.setProperty("--scroll-gutter", `${body.offsetWidth - body.clientWidth}px`);
    if (typeof ref === "function") ref(body);
    else if (ref) ref.current = body;
  }, [ref]);
  return (
    <div
      ref={measure}
      data-slot="dialog-body"
      className={cn("pane-scroll min-h-0 flex-1 border-t border-transparent pb-3 [--pane-side:--spacing(6)] data-scrolled:border-line narrow:[--pane-side:--spacing(4.5)]", className)}
      onScroll={(event) => {
        onScroll?.(event);
        event.currentTarget.toggleAttribute("data-scrolled", event.currentTarget.scrollTop > 0);
      }}
      {...props}
    />
  );
}

/** The buttons row under a rule, inside the body. */
function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "mt-6 flex items-center justify-end gap-2 border-t border-line pt-4 narrow:mt-4.5 narrow:[&_button]:min-h-control-lg",
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogCloseButton,
  DialogContent,
  DialogFooter,
  DialogHeading,
  DialogTitle,
};
