import { useEffect, useState } from "react";
import { sizeObserver, useSurfaceDocument } from "./surface";

/**
 * Which sides of a box that scrolls sideways have more beyond them: "start", "end", both, or none (undefined), for its
 * `data-more` (styles.css's `scroll-more-x` fades those sides). Read again as it scrolls and as it or what it holds (its
 * first child) changes size, and when the same box moves to another surface document.
 */
export function useScrollMore(box: HTMLElement | null) {
  const at = useSurfaceDocument();
  const [more, setMore] = useState("");
  useEffect(() => {
    if (!box) return;
    const measure = () => {
      const beyond = box.scrollWidth - box.clientWidth - box.scrollLeft;
      setMore([box.scrollLeft > 1 && "start", beyond > 1 && "end"].filter(Boolean).join(" "));
    };
    // The same DOM box can move between surfaces; its observation belongs to the current one.
    const sizes = sizeObserver(box, measure);
    sizes.observe(box);
    if (box.firstElementChild) sizes.observe(box.firstElementChild);
    box.addEventListener("scroll", measure, { passive: true });
    measure();
    return () => { sizes.disconnect(); box.removeEventListener("scroll", measure); };
  }, [box, at]);
  return more || undefined;
}
