/** Focuses the element `id` once it is drawn (one just added to the page is drawn on the next render), and scrolls to it. */
export function focusSoon(id: string, frames = 5) {
  requestAnimationFrame(() => {
    const element = document.getElementById(id);
    if (element) { element.scrollIntoView({ block: "nearest" }); element.focus(); }
    else if (frames > 1) focusSoon(id, frames - 1);
  });
}
