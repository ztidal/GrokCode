/**
 * Scrolling to the bottom of a list that does not yet know how tall it is.
 *
 * Under virtualization the list's height is a sum of measured rows plus an
 * estimate for every row that has never been rendered. Scrolling toward that
 * estimate is what brings the real rows into the window, so they are measured
 * only *after* the scroll — the total grows, and the bottom has moved further
 * down than where the scroll landed. One jump-to-latest therefore stops short,
 * and a second gets closer: the convergence was real, it was just being driven
 * by the reader clicking.
 *
 * This drives it instead. Each pass scrolls to the end and looks at whether the
 * content grew underneath; while it is still growing there is more to go.
 */
export interface EndScrollTarget {
  /** Current scroll height of the container, after the last pass. */
  scrollHeight(): number;
  /** Put the view at the end, however this list does that. */
  scrollToEnd(behavior: ScrollBehavior): void;
  /** False once the reader has taken over, or the panel has gone away. */
  stillWanted(): boolean;
  schedule(step: () => void): number;
  cancel(handle: number): void;
}

/**
 * Bounded so a list whose height never settles — a reply still streaming into
 * it, say — cannot spin: it will be scrolled again by the next report anyway.
 */
export const MAX_END_SCROLL_PASSES = 8;

export function runEndScroll(
  target: EndScrollTarget,
  behavior: ScrollBehavior = "auto",
  maxPasses: number = MAX_END_SCROLL_PASSES,
): () => void {
  let passes = 0;
  let lastHeight = -1;
  let pending: number | null = null;
  let stopped = false;

  const step = () => {
    pending = null;
    if (stopped || !target.stillWanted()) return;
    // Only the first pass may animate. A smooth scroll that keeps being
    // restarted never arrives, and the later passes are corrections of a few
    // pixels that should not read as movement.
    target.scrollToEnd(passes === 0 ? behavior : "auto");
    const height = target.scrollHeight();
    passes += 1;
    if (height === lastHeight || passes >= maxPasses) return;
    lastHeight = height;
    pending = target.schedule(step);
  };

  step();

  // Every pass schedules the next, so cancelling has to reach whichever one is
  // outstanding now — not just the one this call started with.
  return () => {
    stopped = true;
    if (pending != null) {
      target.cancel(pending);
      pending = null;
    }
  };
}
