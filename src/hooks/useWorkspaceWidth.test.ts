import { describe, expect, it } from "vitest";
import {
  DETAIL_MIN_PX,
  LEFT_RAIL_DEFAULT_PX,
  WORKSPACE_MIN_PX,
} from "./useRailWidth";
import {
  clampWorkspaceWidth,
  parseStoredCollapsed,
  parseStoredWidth,
  workspaceMaxWidth,
} from "./useWorkspaceWidth";

const WIDE = 1600;
/** Derived, not spelled: a hard-coded number here hid a stale rail width once. */
const WIDE_HEADROOM = WIDE - LEFT_RAIL_DEFAULT_PX - DETAIL_MIN_PX;

describe("workspaceMaxWidth", () => {
  it("leaves room for the left rail and a usable detail column", () => {
    expect(workspaceMaxWidth(WIDE)).toBe(WIDE_HEADROOM);
  });

  it("shrinks as the left rail is widened", () => {
    expect(workspaceMaxWidth(WIDE, 600)).toBe(WIDE - 600 - DETAIL_MIN_PX);
    expect(workspaceMaxWidth(WIDE, 600)).toBeLessThan(workspaceMaxWidth(WIDE));
  });

  it("never drops below the minimum on a cramped viewport", () => {
    expect(workspaceMaxWidth(700)).toBe(WORKSPACE_MIN_PX);
    expect(workspaceMaxWidth(0)).toBe(WORKSPACE_MIN_PX);
  });
});

describe("clampWorkspaceWidth", () => {
  it("passes through a width inside the band", () => {
    expect(clampWorkspaceWidth(520, WIDE)).toBe(520);
  });

  it("clamps to the minimum and the viewport-derived maximum", () => {
    expect(clampWorkspaceWidth(10, WIDE)).toBe(WORKSPACE_MIN_PX);
    expect(clampWorkspaceWidth(9000, WIDE)).toBe(WIDE_HEADROOM);
  });

  it("rounds to whole pixels so the CSS variable stays stable", () => {
    expect(clampWorkspaceWidth(520.4, WIDE)).toBe(520);
    expect(clampWorkspaceWidth(520.6, WIDE)).toBe(521);
  });

  it("prefers the minimum when the viewport cannot honour both bounds", () => {
    expect(clampWorkspaceWidth(900, 700)).toBe(WORKSPACE_MIN_PX);
  });
});

describe("parseStoredWidth", () => {
  it("treats an absent or blank value as the 1fr default", () => {
    expect(parseStoredWidth(null, WIDE)).toBeNull();
    expect(parseStoredWidth("", WIDE)).toBeNull();
    expect(parseStoredWidth("   ", WIDE)).toBeNull();
  });

  it("discards junk rather than guessing a width", () => {
    expect(parseStoredWidth("wide", WIDE)).toBeNull();
    expect(parseStoredWidth("NaN", WIDE)).toBeNull();
    expect(parseStoredWidth("Infinity", WIDE)).toBeNull();
    expect(parseStoredWidth("0", WIDE)).toBeNull();
    expect(parseStoredWidth("-40", WIDE)).toBeNull();
  });

  it("clamps a width persisted on a larger monitor", () => {
    // Inside the band on a wide viewport, capped by it once it is not.
    expect(parseStoredWidth("600", WIDE)).toBe(600);
    expect(parseStoredWidth("9000", WIDE)).toBe(WIDE_HEADROOM);
    // Too cramped to honour both bounds — the floor wins.
    expect(parseStoredWidth("900", 900)).toBe(WORKSPACE_MIN_PX);
    expect(parseStoredWidth("900", 700)).toBe(WORKSPACE_MIN_PX);
  });
});

describe("parseStoredCollapsed", () => {
  it("only the written marker collapses", () => {
    expect(parseStoredCollapsed("1")).toBe(true);
    expect(parseStoredCollapsed("0")).toBe(false);
    expect(parseStoredCollapsed(null)).toBe(false);
    expect(parseStoredCollapsed("true")).toBe(false);
  });
});
