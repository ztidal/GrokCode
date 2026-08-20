import { describe, expect, it } from "vitest";
import {
  DETAIL_MIN_PX,
  LEFT_RAIL_MIN_PX,
  WORKSPACE_MIN_PX,
  clampRailWidth,
  parseStoredRailWidth,
} from "./useRailWidth";
import { leftRailMaxWidth } from "./useLeftRailWidth";

const CONFIG = { minPx: LEFT_RAIL_MIN_PX, maxWidth: leftRailMaxWidth };
const WIDE = 1600;
/** Derived: a literal here is how the stale 180px rail hid for a release. */
const WIDE_MAX = WIDE - WORKSPACE_MIN_PX - DETAIL_MIN_PX;

describe("leftRailMaxWidth", () => {
  it("leaves both other columns their floors", () => {
    expect(leftRailMaxWidth(WIDE)).toBe(WIDE_MAX);
  });

  it("never drops below the rail's own minimum", () => {
    expect(leftRailMaxWidth(700)).toBe(LEFT_RAIL_MIN_PX);
    expect(leftRailMaxWidth(0)).toBe(LEFT_RAIL_MIN_PX);
  });
});

describe("clampRailWidth for the session rail", () => {
  it("passes through a width inside the band", () => {
    expect(clampRailWidth(500, WIDE, CONFIG)).toBe(500);
  });

  it("clamps both ends", () => {
    expect(clampRailWidth(10, WIDE, CONFIG)).toBe(LEFT_RAIL_MIN_PX);
    expect(clampRailWidth(9000, WIDE, CONFIG)).toBe(WIDE_MAX);
  });

  it("prefers the minimum when the viewport cannot honour both bounds", () => {
    expect(clampRailWidth(900, 700, CONFIG)).toBe(LEFT_RAIL_MIN_PX);
  });

  it("rounds to whole pixels so the CSS variable stays stable", () => {
    expect(clampRailWidth(500.4, WIDE, CONFIG)).toBe(500);
    expect(clampRailWidth(500.6, WIDE, CONFIG)).toBe(501);
  });
});

describe("parseStoredRailWidth", () => {
  it("treats absent and junk as no explicit width", () => {
    for (const raw of [null, "", "   ", "wide", "0", "-40", "Infinity"]) {
      expect(parseStoredRailWidth(raw, WIDE, CONFIG)).toBeNull();
    }
  });

  it("clamps a width persisted on a larger monitor", () => {
    expect(parseStoredRailWidth("500", WIDE, CONFIG)).toBe(500);
    expect(parseStoredRailWidth("9000", WIDE, CONFIG)).toBe(WIDE_MAX);
  });
});
