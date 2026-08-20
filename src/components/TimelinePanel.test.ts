import { describe, expect, it } from "vitest";
import { isNearTimelineBottom } from "./TimelinePanel";
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
