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

  it("follows the stream when the content grows under a pinned view", () => {
    // The bug this exists for: a reply being written into makes the tail 400px
    // away without anyone touching the scrollbar. Reading that as intent unpins
    // the timeline the moment its own output arrives.
    const grown = at(1400, 2400);
    expect(readStickIntent(grown, pinnedAtBottom, true)).toEqual({
      pinned: true,
      follow: true,
    });
  });

  it("keeps following through several chunks in a row", () => {
    let previous = pinnedAtBottom;
    let pinned = true;
    for (const height of [2400, 2800, 3300]) {
      const m = at(previous.scrollTop, height);
      const intent = readStickIntent(m, previous, pinned);
      expect(intent).toEqual({ pinned: true, follow: true });
      pinned = intent.pinned;
      previous = { scrollTop: m.scrollTop, scrollHeight: height };
    }
  });

  it("lets go when the view actually moves up", () => {
    // 1400 → 900 is someone dragging the scrollbar, not content arriving.
    expect(readStickIntent(at(900), pinnedAtBottom, true)).toEqual({
      pinned: false,
      follow: false,
    });
  });

  it("takes the pin back when the view returns to the bottom", () => {
    const away = { scrollTop: 900, scrollHeight: 2000 };
    expect(readStickIntent(at(1400), away, false)).toEqual({
      pinned: true,
      follow: false,
    });
  });

  it("does not follow a stream nobody is pinned to", () => {
    // Reading up through history while output arrives: the view stays put.
    const away = { scrollTop: 900, scrollHeight: 2000 };
    expect(readStickIntent(at(900, 2400), away, false)).toEqual({
      pinned: false,
      follow: false,
    });
  });

  it("ignores a sub-pixel scroll position, which is not a decision", () => {
    const jittered = at(1399.5);
    expect(readStickIntent(jittered, pinnedAtBottom, true).pinned).toBe(true);
  });

  it("stays pinned when the content shrinks under it", () => {
    // A tool card collapsing: the browser clamps scrollTop, which is not the
    // user asking for anything.
    const shrunk = at(1000, 1600);
    expect(readStickIntent(shrunk, pinnedAtBottom, true)).toEqual({
      pinned: true,
      follow: false,
    });
  });
});
