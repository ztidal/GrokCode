/** The parts of an element this needs, so a test does not have to build a DOM. */
export interface MeasurableElement {
  scrollWidth: number;
  clientWidth: number;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/**
 * Give an element a `title` only while its own text does not fit.
 *
 * A tooltip that repeats a label you can already read is noise on every card in
 * the list; one that appears exactly where the text is cut off is the only way
 * to read that name at all. So the tooltip is a function of the measurement,
 * not of the markup.
 *
 * Measured when the pointer arrives rather than watched: the session rail is
 * resizable, so a width that fit at mount need not fit later, and one
 * ResizeObserver per card — to learn something that only matters while the
 * pointer is on that one card — is a poor trade for a list that pages.
 *
 * `force` keeps the tooltip on text that does fit, for the case where it says
 * something the text cannot: a renamed card, whose tooltip carries the agent's
 * own title underneath the new one.
 *
 * Returns whether a tooltip is now set, for tests and callers that care.
 */
export function applyOverflowTitle(
  element: MeasurableElement,
  text: string,
  force = false,
): boolean {
  // A 1px allowance: fractional layout widths round against each other, and a
  // sub-pixel difference is not text anyone is missing.
  const clipped = element.scrollWidth - element.clientWidth > 1;
  if (!text || (!clipped && !force)) {
    element.removeAttribute("title");
    return false;
  }
  element.setAttribute("title", text);
  return true;
}

/**
 * The tooltip for a session card's name: the name itself, plus the agent's own
 * title when a rename is covering it — so a card someone renamed six weeks ago
 * can still be traced back to the session it is.
 */
export function cardTitleTooltip(
  displayed: string,
  original: string | null,
): string {
  if (original == null || original === displayed) return displayed;
  return `${displayed}\nRenamed — agent's title: ${original}`;
}
