import { describe, expect, it } from "vitest";
import { isNearTimelineBottom, readStickIntent } from "./TimelinePanel";
import type { VirtualScrollMetrics } from "../hooks/useVirtualWindow";

describe("isNearTimelineBottom", () => {
  /** 600px viewport over a 2000px stream; `dist` is how far the tail is below it. */
  const atDistance = (dist: number): VirtualScrollMetrics => ({
    scrollHeight: 2000,
    clientHeight: 600,
    scrollTop: 2000 - 600 - dist,
    listTop: 0,
  });

  it("is true at the tail and within the threshold", () => {
    expect(isNearTimelineBottom(atDistance(0))).toBe(true);
    expect(isNearTimelineBottom(atDistance(63))).toBe(true);
  });

  it("is false from the threshold outward", () => {
    expect(isNearTimelineBottom(atDistance(64))).toBe(false);
    expect(isNearTimelineBottom(atDistance(900))).toBe(false);
  });

  it("is true when the stream does not fill the viewport", () => {
    expect(
      isNearTimelineBottom({
        scrollHeight: 400,
        clientHeight: 600,
        scrollTop: 0,
        listTop: 0,
      }),
    ).toBe(true);
  });

  it("is true past the tail, as rubber-band overscroll reports", () => {
    expect(isNearTimelineBottom(atDistance(-20))).toBe(true);
  });
});

describe("readStickIntent", () => {
  const at = (scrollTop: number, scrollHeight = 2000): VirtualScrollMetrics => ({
    scrollHeight,
    clientHeight: 600,
    scrollTop,
    listTop: 0,
  });
  /** Pinned at the tail of a 2000px stream in a 600px viewport. */
  const pinnedAtBottom = { scrollTop: 1400, scrollHeight: 2000 };
  const following = { pinned: true, escaped: false };
  const reading = { pinned: false, escaped: true };

  it("follows the stream when the content grows under a pinned view", () => {
    // The bug this exists for: a reply being written into makes the tail 400px
    // away without anyone touching the scrollbar. Reading that as intent unpins
    // the timeline the moment its own output arrives.
    expect(readStickIntent(at(1400, 2400), pinnedAtBottom, following)).toEqual({
      pinned: true,
      escaped: false,
      follow: true,
    });
  });

  it("keeps following through several chunks in a row", () => {
    let previous = pinnedAtBottom;
    let state = following;
    for (const height of [2400, 2800, 3300]) {
      const m = at(previous.scrollTop, height);
      const intent = readStickIntent(m, previous, state);
      expect(intent).toEqual({ pinned: true, escaped: false, follow: true });
      state = { pinned: intent.pinned, escaped: intent.escaped };
      previous = { scrollTop: m.scrollTop, scrollHeight: height };
    }
  });

  it("lets a reader scroll back a little without dragging them down again", () => {
    // The reason for two flags. 30px up is inside the 64px near-bottom band, so
    // a single geometry-derived pin called this "still at the bottom" and the
    // next chunk yanked the view back — re-reading the sentence you just
    // watched arrive was not possible.
    const nudgedUp = at(1370);
    const intent = readStickIntent(nudgedUp, pinnedAtBottom, following);
    expect(intent).toEqual({ pinned: false, escaped: true, follow: false });

    // …and the next chunk must leave them where they are.
    const grown = at(1370, 2400);
    expect(
      readStickIntent(grown, { scrollTop: 1370, scrollHeight: 2000 }, intent).follow,
    ).toBe(false);
  });

  it("lets go when the view moves up a long way", () => {
    expect(readStickIntent(at(900), pinnedAtBottom, following)).toEqual({
      pinned: false,
      escaped: true,
      follow: false,
    });
  });

  it("keeps the reader out of the stream while they are away", () => {
    // Reading up through history while output arrives: the view stays put, and
    // arriving near the bottom is not the same as choosing to be there.
    const away = { scrollTop: 900, scrollHeight: 2000 };
    expect(readStickIntent(at(900, 2400), away, reading)).toEqual({
      pinned: false,
      escaped: true,
      follow: false,
    });
  });

  it("gives the pin back only at the bottom itself", () => {
    const away = { scrollTop: 900, scrollHeight: 2000 };
    // Near the bottom, still escaped.
    expect(readStickIntent(at(1360), away, reading).pinned).toBe(false);
    // On it, released.
    expect(readStickIntent(at(1400), away, reading)).toEqual({
      pinned: true,
      escaped: false,
      follow: false,
    });
  });

  it("ignores a sub-pixel scroll position, which is not a decision", () => {
    expect(readStickIntent(at(1399.5), pinnedAtBottom, following).pinned).toBe(
      true,
    );
  });

  it("stays pinned when the content shrinks under it", () => {
    // A tool card collapsing, or a queued row leaving: the browser clamps
    // scrollTop, which is not the user asking for anything. Indistinguishable
    // from a scroll by position alone, which is why height has to agree.
    expect(readStickIntent(at(1000, 1600), pinnedAtBottom, following)).toEqual({
      pinned: true,
      escaped: false,
      follow: false,
    });
  });

  it("does not read a shrink part-way up as the reader leaving", () => {
    const midStream = { scrollTop: 1200, scrollHeight: 2000 };
    const shrunk = at(900, 1700);
    expect(readStickIntent(shrunk, midStream, following).escaped).toBe(false);
  });
});
