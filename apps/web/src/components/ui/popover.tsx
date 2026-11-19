import * as React from "react";
import { Popover as PopoverPrimitive, Slot } from "radix-ui";
import { cn } from "@/lib/utils";
import { ESCAPE_LAYER, useEscapeLayer } from "@/lib/escape-layer";
import { useCloseOnPhoneBack } from "@/lib/close-on-back";
import { useSurfaceDocument } from "@/lib/surface";
import { steadyAnchor, type Measurable } from "@/lib/steady-anchor";

/** Where the open popover's trigger or anchor tells what it stands against (`steadyAnchor`). */
const AnchorSource = React.createContext<React.RefObject<(() => Measurable | null) | null> | null>(null);

/**
 * shadcn's Popover (Radix), styled like a dialog: a box on the
 * lighter surface with the dialog's border and the one shadow; it comes down from
 * what opened it (up, when it opens above). Used for choices and small forms; on a short screen what it holds
 * scrolls inside it, as on the other surfaces.
 *
 * Every popover is placed against one steady anchor (`steadyAnchor`): it stays where it opened when what opened it
 * changes size, and follows it only when it moves.
 */
function Popover({ open, onOpenChange, children, ...props }: Omit<React.ComponentProps<typeof PopoverPrimitive.Root>, "defaultOpen">) {
  const [uncontrolled, setUncontrolled] = React.useState(false);
  const shown = open ?? uncontrolled;
  const change = (next: boolean) => {
    if (open === undefined) setUncontrolled(next);
    onOpenChange?.(next);
  };
  useEscapeLayer(shown, ESCAPE_LAYER.popup, () => change(false));
  // Open for a moment only: on a phone Back closes it along with the page's step.
  useCloseOnPhoneBack(shown, () => change(false));
  const source = React.useRef<(() => Measurable | null) | null>(null);
  const [anchor] = React.useState(() => ({ current: steadyAnchor(() => source.current?.()) }));
  // Closed, the place is forgotten: the next opening is placed against the anchor as it is then.
  React.useLayoutEffect(() => { if (!shown) anchor.current.reset(); }, [shown, anchor]);
  return <PopoverPrimitive.Root data-slot="popover" {...props} open={shown} onOpenChange={change}>
    <PopoverPrimitive.Anchor virtualRef={anchor} />
    <AnchorSource.Provider value={source}>{children}</AnchorSource.Provider>
  </PopoverPrimitive.Root>;
}

/** Tells the popover the element (or virtual element) it stands against. */
function useAnchorSource(ref?: React.Ref<HTMLElement>) {
  const source = React.useContext(AnchorSource);
  return React.useCallback((node: HTMLElement | null) => {
    if (source) source.current = () => node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  }, [source, ref]);
}

function PopoverTrigger({ ref, ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" ref={useAnchorSource(ref)} {...props} />;
}

/** What the popover stands against when it is not its trigger: an element of the page, or a virtual one (`virtualRef`). */
function PopoverAnchor({ ref, virtualRef, asChild, ...props }: Omit<React.ComponentProps<"div">, "ref"> & {
  ref?: React.Ref<HTMLElement>; virtualRef?: React.RefObject<Measurable | null>; asChild?: boolean }) {
  const source = React.useContext(AnchorSource);
  const own = useAnchorSource(ref);
  React.useLayoutEffect(() => {
    if (!virtualRef || !source) return;
    source.current = () => virtualRef.current;
  });
  if (virtualRef) return null;
  const Comp = asChild ? Slot.Root : "div";
  return <Comp data-slot="popover-anchor" ref={own} {...props} />;
}

function PopoverContent({
  className,
  align = "start",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  // Opened in the coordinator's own window, it opens there.
  const page = useSurfaceDocument().body;
  return (
    <PopoverPrimitive.Portal container={page}>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          "z-(--layer-popover) w-80 max-w-[calc(100vw-16px)] max-h-(--radix-popover-content-available-height) overflow-auto overscroll-contain animate-drop data-[side=top]:animate-rise rounded-lg border border-lit-line bg-raised p-3 text-ink shadow-float outline-none",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverAnchor, PopoverContent };
