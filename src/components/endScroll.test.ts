import { describe, expect, it } from "vitest";
import {
  MAX_END_SCROLL_PASSES,
  runEndScroll,
  type EndScrollTarget,
} from "./endScroll";

/**
 * A list that discovers it is taller every time you scroll to its end — which
 * is what a virtualized list does, because scrolling is what renders the rows
 * that get measured.
 */
function growingList(heights: number[], wanted = () => true) {
  const scrolls: ScrollBehavior[] = [];
  let pass = 0;
  const queue: (() => void)[] = [];
  let cancelled: number | null = null;
  const target: EndScrollTarget = {
    scrollHeight: () => heights[Math.min(pass, heights.length - 1)]!,
    scrollToEnd: (behavior) => {
      scrolls.push(behavior);
      pass += 1;
    },
    stillWanted: wanted,
    schedule: (step) => {
      queue.push(step);
      return queue.length;
    },
    cancel: (handle) => {
      cancelled = handle;
    },
  };
  const drain = () => {
    let guard = 0;
    while (queue.length && guard++ < 50) queue.shift()!();
  };
  return {
    target,
    scrolls,
    drain,
    passes: () => pass,
    cancelled: () => cancelled != null,
  };
}

describe("runEndScroll", () => {
  it("keeps going while the content grows under it", () => {
    // The symptom this exists for: one jump landed short, a second got closer.
    // Heights are what the list reports *after* n passes, so this one grows
    // twice and then holds — three scrolls, the third confirming the second.
    const list = growingList([1000, 1400, 1600, 1600]);
    runEndScroll(list.target);
    list.drain();
    expect(list.passes()).toBe(3);
  });

  it("stops as soon as the bottom stops moving", () => {
    const list = growingList([1000, 1000]);
    runEndScroll(list.target);
    list.drain();
    expect(list.passes()).toBe(2);
  });

  it("cannot spin on a list that never settles", () => {
    // A reply still streaming keeps growing; the next metrics report will
    // scroll again, so this pass has no reason to hold on.
    const forever = Array.from({ length: 100 }, (_, i) => 1000 + i * 50);
    const list = growingList(forever);
    runEndScroll(list.target);
    list.drain();
    expect(list.passes()).toBe(MAX_END_SCROLL_PASSES);
  });

  it("lets the reader win", () => {
    // Scrolling up mid-convergence has to end it, or the view fights back.
    let wanted = true;
    const list = growingList([1000, 1400, 1800, 2000], () => wanted);
    runEndScroll(list.target);
    wanted = false;
    list.drain();
    expect(list.passes()).toBe(1);
  });

  it("can be stopped part-way, including the pass it had queued", () => {
    // Every pass schedules the next, so a caller starting a new scroll has to
    // be able to reach whichever one is outstanding now.
    const list = growingList([1000, 1400, 1800, 2200, 2200]);
    const stop = runEndScroll(list.target);
    expect(list.passes()).toBe(1);
    stop();
    list.drain();
    expect(list.passes()).toBe(1);
    expect(list.cancelled()).toBe(true);
  });

  it("animates only the first pass", () => {
    // Restarting a smooth scroll every frame never arrives anywhere.
    const list = growingList([1000, 1400, 1600, 1600]);
    runEndScroll(list.target, "smooth");
    list.drain();
    expect(list.scrolls).toEqual(["smooth", "auto", "auto"]);
  });
});
